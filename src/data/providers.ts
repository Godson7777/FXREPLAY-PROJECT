import { barsFromRows, type Bars, type DatasetMeta } from '../core/types';
import { downloadBinance } from './binance';
import { HL_INTERVALS, hlCandles, pickInterval, type HlInterval } from './hyperliquid';

/**
 * Real market data from exchange / data-vendor REST APIs, called straight from the
 * browser (no backend). Each provider downloads [t,o,h,l,c,v] rows in UTC seconds.
 */
export type ProviderId = 'binance' | 'binance-futures' | 'bybit' | 'bybit-linear' | 'okx' | 'twelvedata' | 'hyperliquid';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  markets: string;
  example: string;
  needsKey: boolean;
  note: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'binance', label: 'Binance — Spot', markets: 'Crypto', example: 'BTCUSDT', needsKey: false, note: 'Years of 1-minute history. Falls back to data-api.binance.vision if binance.com is blocked.' },
  { id: 'binance-futures', label: 'Binance — USDⓈ-M Futures', markets: 'Crypto perps', example: 'BTCUSDT', needsKey: false, note: 'Perpetual futures, 1-minute history.' },
  { id: 'bybit', label: 'Bybit — Spot', markets: 'Crypto', example: 'BTCUSDT', needsKey: false, note: '1-minute history, 1,000 bars per request.' },
  { id: 'bybit-linear', label: 'Bybit — USDT Perpetual', markets: 'Crypto perps', example: 'BTCUSDT', needsKey: false, note: '1-minute history, 1,000 bars per request.' },
  { id: 'okx', label: 'OKX — Spot / Swap', markets: 'Crypto', example: 'BTC-USDT', needsKey: false, note: 'Use BTC-USDT for spot or BTC-USDT-SWAP for the perpetual. 100 bars per request, so long ranges take a while.' },
  { id: 'twelvedata', label: 'Twelve Data — Forex, gold, indices, stocks', markets: 'Forex · Metals · Indices · Stocks', example: 'XAU/USD', needsKey: true, note: 'Needs a free API key from twelvedata.com (≈800 requests/day, 8 per minute; up to 5,000 one-minute bars each). Examples: EUR/USD, XAU/USD, GBP/JPY, AAPL, SPY.' },
  { id: 'hyperliquid', label: 'Hyperliquid — Perps', markets: 'Crypto perps', example: 'BTC', needsKey: false, note: 'Only the latest 5,000 candles per interval are served (1m ≈ 3.5 days).' },
];

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!;

const TD_KEY = 'overflowtrade.twelvedata.key';
/** The Twelve Data key lives only in this browser (never synced or backed up). */
export function getTdKey(): string {
  try {
    return localStorage.getItem(TD_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setTdKey(k: string) {
  try {
    if (k) localStorage.setItem(TD_KEY, k.trim());
    else localStorage.removeItem(TD_KEY);
  } catch {
    /* private mode */
  }
}

/** Dataset id for a provider symbol (Binance keeps its historical naming). */
export function datasetId(p: ProviderId, symbol: string): string {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9.]/g, '');
  switch (p) {
    case 'binance': return s;
    case 'binance-futures': return `${s}.P`;
    case 'bybit': return `BYBIT-${s}`;
    case 'bybit-linear': return `BYBIT-${s}.P`;
    case 'okx': return `OKX-${s}`;
    case 'twelvedata': return s; // XAU/USD → XAUUSD, so the usual specs apply
    case 'hyperliquid': return `HL-${s}`;
  }
}

/** DatasetMeta.source used for a provider. */
export function sourceOf(p: ProviderId): DatasetMeta['source'] {
  if (p === 'binance' || p === 'binance-futures') return 'binance';
  if (p === 'bybit' || p === 'bybit-linear') return 'bybit';
  return p;
}

export interface FetchOpts {
  signal?: AbortSignal;
  onProgress?: (pct: number, bars: number, msg?: string) => void;
  fetch?: typeof fetch;
  /** waits between rate-limited calls; injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  key?: string;
  /** base resolution in seconds to fetch (refresh keeps the dataset's resolution) */
  resolution?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class FetchError extends Error {
  constructor(msg: string, public fatal = false) {
    super(msg);
  }
}

async function getJson<T>(label: string, url: string, o: FetchOpts): Promise<T> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (o.signal?.aborted) throw new Error('Cancelled');
    let res: Response;
    try {
      res = await f(url, { signal: o.signal });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      last = `Could not reach ${label} — your network, browser or region may block it.`;
      await sleep(800 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `${label} is busy (HTTP ${res.status})`;
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new FetchError(`${label} request failed (HTTP ${res.status})`, true);
    return (await res.json()) as T;
  }
  throw new Error(last || `${label} request failed`);
}

const RES_TO: Record<number, { bybit: string; okx: string; td: string; hl: HlInterval }> = {
  60: { bybit: '1', okx: '1m', td: '1min', hl: '1m' },
  300: { bybit: '5', okx: '5m', td: '5min', hl: '5m' },
  900: { bybit: '15', okx: '15m', td: '15min', hl: '15m' },
  3600: { bybit: '60', okx: '1H', td: '1h', hl: '1h' },
  14400: { bybit: '240', okx: '4H', td: '4h', hl: '4h' },
  86400: { bybit: 'D', okx: '1Dutc', td: '1day', hl: '1d' },
};

/** Download candles for [from, to] (UTC seconds). Returns bars at the provider's base resolution. */
export async function fetchCandles(p: ProviderId, symbol: string, from: number, to: number, o: FetchOpts = {}): Promise<Bars> {
  const sym = symbol.trim();
  if (!sym) throw new Error('Enter a symbol');
  if (!(to > from)) throw new Error('The end date must be after the start date');
  const res = o.resolution ?? 60;
  let rows: number[][];
  switch (p) {
    case 'binance':
    case 'binance-futures':
      if (res !== 60) throw new Error('Binance datasets are stored as 1-minute bars');
      return downloadBinance(sym, from, to, o.onProgress, o.signal, p === 'binance' ? 'spot' : 'futures');
    case 'bybit':
    case 'bybit-linear':
      rows = await bybit(sym, p === 'bybit' ? 'spot' : 'linear', res, from, to, o);
      break;
    case 'okx':
      rows = await okx(sym, res, from, to, o);
      break;
    case 'twelvedata':
      rows = await twelvedata(sym, res, from, to, o);
      break;
    case 'hyperliquid': {
      const iv = o.resolution ? RES_TO[o.resolution]?.hl ?? pickInterval(from, Date.now() / 1000).id : pickInterval(from, Date.now() / 1000).id;
      rows = await hlCandles(sym, iv, from, to, { signal: o.signal, onProgress: o.onProgress, fetch: o.fetch });
      if (!o.resolution) o.resolution = HL_INTERVALS.find((x) => x.id === iv)!.sec;
      break;
    }
  }
  rows = rows.filter((r) => r[0] >= from && r[0] <= to);
  if (!rows.length) throw new Error(`No candles returned for ${sym} — check the symbol and dates`);
  return barsFromRows(rows);
}

/** Bybit v5: newest-first pages of up to 1000, walked backwards from `to`. */
async function bybit(sym: string, category: 'spot' | 'linear', res: number, from: number, to: number, o: FetchOpts) {
  const iv = RES_TO[res]?.bybit;
  if (!iv) throw new Error('Unsupported resolution for Bybit');
  const rows: number[][] = [];
  let end = to * 1000;
  while (end >= from * 1000) {
    const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${encodeURIComponent(sym.toUpperCase())}&interval=${iv}&start=${from * 1000}&end=${end}&limit=1000`;
    const j = await getJson<{ retCode: number; retMsg: string; result?: { list?: string[][] } }>('Bybit', url, o);
    if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg || 'request failed'}${/symbol/i.test(j.retMsg) ? ' — e.g. BTCUSDT' : ''}`);
    const list = j.result?.list ?? [];
    if (!list.length) break;
    for (const k of list) rows.push([Math.floor(+k[0] / 1000), +k[1], +k[2], +k[3], +k[4], +k[5]]);
    const oldest = +list[list.length - 1][0];
    if (oldest >= end) break;
    end = oldest - 1;
    o.onProgress?.(Math.min(1, (to * 1000 - end) / ((to - from) * 1000)), rows.length);
    if (list.length < 1000) break;
  }
  return rows;
}

/** OKX v5 history-candles: newest-first pages of 100 (`after` = older than), ≈20 req/2s. */
async function okx(sym: string, res: number, from: number, to: number, o: FetchOpts) {
  const bar = RES_TO[res]?.okx;
  if (!bar) throw new Error('Unsupported resolution for OKX');
  const sleep = o.sleep ?? realSleep;
  const rows: number[][] = [];
  let after = to * 1000 + 1;
  while (after > from * 1000) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(sym.toUpperCase())}&bar=${bar}&after=${after}&limit=100`;
    const j = await getJson<{ code: string; msg: string; data?: string[][] }>('OKX', url, o);
    if (j.code !== '0') throw new Error(`OKX: ${j.msg || 'request failed'}${/instId|instrument/i.test(j.msg) ? ' — e.g. BTC-USDT or BTC-USDT-SWAP' : ''}`);
    const list = j.data ?? [];
    if (!list.length) break;
    for (const k of list) rows.push([Math.floor(+k[0] / 1000), +k[1], +k[2], +k[3], +k[4], +k[5]]);
    const oldest = +list[list.length - 1][0];
    if (oldest >= after) break;
    after = oldest;
    o.onProgress?.(Math.min(1, (to * 1000 - after) / ((to - from) * 1000)), rows.length);
    if (list.length < 100) break;
    await sleep(110);
  }
  return rows;
}

/** Twelve Data time_series: newest-first pages of 5000, paced to 8 requests/minute. */
async function twelvedata(sym: string, res: number, from: number, to: number, o: FetchOpts) {
  const interval = RES_TO[res]?.td;
  if (!interval) throw new Error('Unsupported resolution for Twelve Data');
  const key = o.key ?? getTdKey();
  if (!key) throw new Error('Twelve Data needs a free API key — get one at twelvedata.com and paste it in.');
  const sleep = o.sleep ?? realSleep;
  const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const rows: number[][] = [];
  let end = to;
  let calls = 0;
  while (end >= from) {
    if (calls > 0) await sleep(7600); // stay under 8 requests per minute
    calls++;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym.toUpperCase())}&interval=${interval}&start_date=${encodeURIComponent(fmt(from))}&end_date=${encodeURIComponent(fmt(end))}&outputsize=5000&timezone=UTC&order=desc&format=JSON&apikey=${encodeURIComponent(key)}`;
    let j = await getJson<{ status?: string; code?: number; message?: string; values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[] }>('Twelve Data', url, o);
    if (j.status === 'error' && j.code === 429) {
      // per-minute credits used up: wait for the next minute and retry once
      for (let s = 60; s > 0; s -= 5) {
        o.onProgress?.(Math.min(1, (to - end) / (to - from)), rows.length, `Twelve Data rate limit — resuming in ${s}s…`);
        await sleep(5000);
      }
      j = await getJson('Twelve Data', url, o);
    }
    if (j.status === 'error') {
      const m = j.message ?? 'request failed';
      // "no data is available on the specified dates" ends a backwards walk normally
      if (rows.length && /no data|not found/i.test(m)) break;
      throw new Error(`Twelve Data: ${m}`);
    }
    const vals = j.values ?? [];
    if (!vals.length) break;
    for (const v of vals) {
      const t = Math.floor(Date.parse(v.datetime.replace(' ', 'T') + (v.datetime.length <= 10 ? 'T00:00:00Z' : 'Z')) / 1000);
      if (isFinite(t)) rows.push([t, +v.open, +v.high, +v.low, +v.close, +(v.volume ?? 0) || 0]);
    }
    const oldest = rows[rows.length - 1][0];
    if (oldest >= end) break;
    end = oldest - res;
    o.onProgress?.(Math.min(1, (to - end) / (to - from)), rows.length);
    if (vals.length < 5000) break;
  }
  return rows;
}

/** Which provider can refresh a stored dataset (new datasets record it; old Binance ones are inferred). */
export function refreshSource(m: DatasetMeta): { provider: ProviderId; symbol: string } | null {
  if (m.provider) return m.provider;
  if (m.source === 'binance') return { provider: m.id.endsWith('.P') ? 'binance-futures' : 'binance', symbol: m.id.replace(/\.P$/, '') };
  if (m.source === 'hyperliquid' && m.id.startsWith('HL-')) return { provider: 'hyperliquid', symbol: m.id.slice(3) };
  return null;
}
