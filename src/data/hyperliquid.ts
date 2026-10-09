import { emptyBars, type Bars, type InstrumentSpec } from '../core/types';

/**
 * Hyperliquid perpetuals: public market data (no key, CORS-enabled).
 * REST  POST https://api.hyperliquid.xyz/info  — meta, candleSnapshot
 * WS    wss://api.hyperliquid.xyz/ws           — candle + trades streams
 */
export const HL_INFO = 'https://api.hyperliquid.xyz/info';
export const HL_WS = 'wss://api.hyperliquid.xyz/ws';
/** Hyperliquid only serves the most recent 5000 candles per interval. */
export const HL_MAX_CANDLES = 5000;
/** default taker fee (base tier), % of notional */
export const HL_TAKER_FEE = 0.045;

export interface HlCoin {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface HlCandle {
  t: number; // open time, ms
  T?: number;
  s?: string;
  i?: string;
  o: string | number;
  h: string | number;
  l: string | number;
  c: string | number;
  v: string | number;
  n?: number;
}

export const HL_INTERVALS = [
  { id: '1m', sec: 60 },
  { id: '5m', sec: 300 },
  { id: '15m', sec: 900 },
  { id: '1h', sec: 3600 },
  { id: '4h', sec: 14400 },
  { id: '1d', sec: 86400 },
] as const;
export type HlInterval = (typeof HL_INTERVALS)[number]['id'];

/** Finest interval whose latest-5000-candle window still reaches back to `from`. */
export function pickInterval(from: number, now: number): (typeof HL_INTERVALS)[number] {
  for (const iv of HL_INTERVALS) if (now - from <= iv.sec * HL_MAX_CANDLES) return iv;
  return HL_INTERVALS[HL_INTERVALS.length - 1];
}

/** Dataset id for a Hyperliquid coin. */
export const hlSymbol = (coin: string) => `HL-${coin.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;

/** Instrument spec: 1 lot = 1 coin; prices use at most 5 significant figures and 6 − szDecimals decimals. */
export function hlSpec(coin: string, szDecimals: number, price: number): InstrumentSpec {
  const sig = Math.max(0, 5 - Math.floor(Math.log10(Math.max(Math.abs(price), 1e-12))) - 1);
  const digits = Math.max(0, Math.min(6 - szDecimals, sig));
  // a "pip" is ~0.01% of price rounded to a power of ten (BTC $10, ETH $0.1), never below one tick
  const pip = Math.max(Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(price), 1e-12) / 10000))), Math.pow(10, -digits));
  return { symbol: hlSymbol(coin), pipSize: +pip.toPrecision(1), contractSize: 1, digits };
}

async function post<T>(body: unknown, signal?: AbortSignal, f: typeof fetch = fetch): Promise<T> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled');
    try {
      const res = await f(HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`Hyperliquid request failed (HTTP ${res.status})`), { fatal: true });
      return (await res.json()) as T;
    } catch (e) {
      if (signal?.aborted || (e as { fatal?: boolean }).fatal) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw new Error(`Could not reach Hyperliquid${last instanceof Error ? ` (${last.message})` : ''}`);
}

let metaCache: Promise<HlCoin[]> | null = null;
/** Tradable perp coins (delisted ones removed), cached per page load. */
export function hlCoins(f: typeof fetch = fetch): Promise<HlCoin[]> {
  metaCache ??= post<{ universe: (HlCoin & { isDelisted?: boolean })[] }>({ type: 'meta' }, undefined, f)
    .then((m) => m.universe.filter((u) => !u.isDelisted).map((u) => ({ name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage })))
    .catch((e) => {
      metaCache = null;
      throw e;
    });
  return metaCache;
}

export function candleRow(c: HlCandle): number[] {
  return [Math.floor(c.t / 1000), +c.o, +c.h, +c.l, +c.c, +c.v];
}

/** Candles between two UTC-second times, paging forward 5000 at a time. */
export async function hlCandles(
  coin: string, interval: HlInterval, from: number, to: number,
  o: { signal?: AbortSignal; onProgress?: (pct: number, n: number) => void; fetch?: typeof fetch } = {},
): Promise<number[][]> {
  const sec = HL_INTERVALS.find((x) => x.id === interval)!.sec;
  const rows: number[][] = [];
  let cursor = from * 1000;
  const end = to * 1000;
  while (cursor <= end) {
    const data = await post<HlCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime: cursor, endTime: end } }, o.signal, o.fetch);
    if (!Array.isArray(data) || !data.length) break;
    for (const c of data) if (c.t >= cursor) rows.push(candleRow(c));
    const last = data[data.length - 1].t;
    if (last < cursor) break;
    cursor = last + sec * 1000;
    o.onProgress?.(Math.min(1, (cursor - from * 1000) / Math.max(1, end - from * 1000)), rows.length);
    if (data.length < HL_MAX_CANDLES) break;
  }
  return rows;
}

/** Ensure room for `extra` more bars, growing the typed arrays in place (all holders see the change). */
export function reserveBars(b: Bars, extra: number) {
  if (b.n + extra <= b.t.length) return;
  const cap = Math.max(b.n + extra, Math.ceil(b.t.length * 1.5) + 1024);
  const nb = emptyBars(cap);
  for (const k of ['t', 'o', 'h', 'l', 'c', 'v'] as const) {
    nb[k].set(b[k].subarray(0, b.n));
    b[k] = nb[k];
  }
}

/**
 * Apply a candle row [t,o,h,l,c,v] to the bars: updates the last bar when it has the
 * same open time, appends when newer, ignores older ones. Returns what happened.
 */
export function applyCandle(b: Bars, r: number[]): 'update' | 'append' | 'old' {
  const [t, o, hi, lo, c, v] = r;
  if (!(t > 0) || !isFinite(c)) return 'old';
  const last = b.n ? b.t[b.n - 1] : -Infinity;
  if (t < last) return 'old';
  let i = b.n - 1;
  if (t > last) {
    reserveBars(b, 1);
    i = b.n++;
  }
  b.t[i] = t;
  b.o[i] = o;
  b.h[i] = Math.max(o, hi, lo, c);
  b.l[i] = Math.min(o, hi, lo, c);
  b.c[i] = c;
  b.v[i] = v || 0;
  return t > last ? 'append' : 'update';
}

/** Fold one trade tick into the 1-minute bars (the candle stream later overwrites with exact values). */
export function applyTick(b: Bars, t: number, px: number): 'update' | 'append' | 'old' {
  const m = Math.floor(t / 60) * 60;
  const last = b.n ? b.t[b.n - 1] : -Infinity;
  if (m < last) return 'old';
  if (m > last) return applyCandle(b, [m, px, px, px, px, 0]);
  const i = b.n - 1;
  if (px > b.h[i]) b.h[i] = px;
  if (px < b.l[i]) b.l[i] = px;
  b.c[i] = px;
  return 'update';
}

export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface FeedHandlers {
  candle: (row: number[]) => void;
  trade: (t: number, px: number) => void;
  status: (s: FeedStatus) => void;
  /** called after every (re)connect so the caller can backfill the gap */
  opened: () => void;
}

/** Live WebSocket feed for one coin's 1-minute candles and trades, with reconnect + keepalive. */
export class LiveFeed {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  lastMsg = 0;

  constructor(
    public coin: string,
    private on: FeedHandlers,
    private url = HL_WS,
  ) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.on.status(this.retry ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin: this.coin, interval: '1m' } }));
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: this.coin } }));
      this.ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ method: 'ping' })), 30000);
      this.lastMsg = Date.now();
      this.on.status('live');
      this.on.opened();
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      let m: { channel?: string; data?: unknown };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.channel === 'candle' && m.data && typeof m.data === 'object') {
        const c = m.data as HlCandle;
        if (!c.s || c.s === this.coin) this.on.candle(candleRow(c));
      } else if (m.channel === 'trades' && Array.isArray(m.data)) {
        for (const tr of m.data as { coin?: string; px: string; time: number }[]) {
          if (tr.coin && tr.coin !== this.coin) continue;
          const px = +tr.px;
          if (px > 0 && tr.time > 0) this.on.trade(Math.floor(tr.time / 1000), px);
        }
      }
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      if (this.ws === ws) this.ws = null;
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry() {
    if (this.closed) return;
    this.on.status(this.retry > 3 ? 'offline' : 'reconnecting');
    const wait = Math.min(30000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}
