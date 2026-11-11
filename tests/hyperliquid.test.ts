import { describe, expect, it } from 'vitest';
import { applyCandle, applyTick, hlCandles, hlSpec, hlSymbol, pickInterval, reserveBars, HL_INFO } from '../src/data/hyperliquid';
import { barsFromRows, emptyBars } from '../src/core/types';
import { checkRange, dataWindow } from '../src/engine/replay';

describe('hyperliquid helpers', () => {
  it('picks the finest interval inside the 5000-candle window', () => {
    const now = 1_800_000_000;
    expect(pickInterval(now - 3 * 86400, now).id).toBe('1m');
    expect(pickInterval(now - 10 * 86400, now).id).toBe('5m');
    expect(pickInterval(now - 40 * 86400, now).id).toBe('15m');
    expect(pickInterval(now - 150 * 86400, now).id).toBe('1h');
    expect(pickInterval(now - 4000 * 86400, now).id).toBe('1d');
  });

  it('derives price digits from Hyperliquid tick rules', () => {
    expect(hlSpec('BTC', 5, 104321).digits).toBe(0);
    expect(hlSpec('ETH', 4, 3456.7).digits).toBe(1);
    expect(hlSpec('DOGE', 0, 0.21345).digits).toBe(5);
    expect(hlSpec('BTC', 5, 1).contractSize).toBe(1);
    expect(hlSpec('BTC', 5, 104321).pipSize).toBe(10);
    expect(hlSpec('ETH', 4, 3456.7).pipSize).toBe(0.1);
    expect(hlSpec('DOGE', 0, 0.21345).pipSize).toBe(0.00001);
    expect(hlSymbol('kPEPE')).toBe('HL-KPEPE');
  });

  it('updates the forming candle and appends new ones in place', () => {
    const b = barsFromRows([[60, 1, 2, 0.5, 1.5, 10]]);
    const ref = b.t;
    expect(applyCandle(b, [60, 1, 2.5, 0.5, 2.2, 12])).toBe('update');
    expect(b.n).toBe(1);
    expect(b.h[0]).toBe(2.5);
    expect(applyCandle(b, [120, 2.2, 2.3, 2.1, 2.25, 3])).toBe('append');
    expect(b.n).toBe(2);
    expect(b.t).not.toBe(ref); // grew: arrays replaced on the same object
    expect(applyCandle(b, [60, 9, 9, 9, 9, 9])).toBe('old');
    expect(b.c[0]).toBe(2.2);
  });

  it('folds trade ticks into 1-minute bars', () => {
    const b = emptyBars(0);
    expect(applyTick(b, 125, 10)).toBe('append');
    expect(b.t[0]).toBe(120);
    applyTick(b, 130, 12);
    applyTick(b, 150, 9);
    expect([b.o[0], b.h[0], b.l[0], b.c[0]]).toEqual([10, 12, 9, 9]);
    expect(applyTick(b, 185, 11)).toBe('append');
    expect(b.n).toBe(2);
    expect(applyTick(b, 100, 1)).toBe('old');
  });

  it('reserves capacity without losing data', () => {
    const b = barsFromRows([[60, 1, 1, 1, 1, 1], [120, 2, 2, 2, 2, 2]]);
    reserveBars(b, 5000);
    expect(b.t.length).toBeGreaterThanOrEqual(5002);
    expect([...b.c.subarray(0, 2)]).toEqual([1, 2]);
  });

  it('pages candleSnapshot requests', async () => {
    const calls: { startTime: number; endTime: number }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      expect(url).toBe(HL_INFO);
      const body = JSON.parse(String(init.body));
      calls.push(body.req);
      const out = [];
      for (let t = body.req.startTime; t <= body.req.endTime && out.length < 5000; t += 60000) out.push({ t, o: '1', h: '2', l: '0.5', c: '1.5', v: '3' });
      return new Response(JSON.stringify(out), { status: 200 });
    }) as typeof fetch;
    const rows = await hlCandles('BTC', '1m', 0, 7000 * 60, { fetch: fake });
    expect(calls.length).toBe(2);
    expect(rows.length).toBe(7001);
    expect(rows[0]).toEqual([0, 1, 2, 0.5, 1.5, 3]);
    expect(rows[6999][0] - rows[6998][0]).toBe(60);
  });
});

describe('session date range', () => {
  const fmt = (t: number) => String(t);
  it('finds the common window', () => {
    expect(dataWindow([{ from: 10, to: 100 }, { from: 20, to: 90 }])).toEqual({ from: 20, to: 90 });
  });
  it('rejects a start after the data ends', () => {
    expect(checkRange({ from: 0, to: 100 }, 150, null, fmt)).toMatch(/Start must be between 0 and 100/);
    expect(checkRange({ from: 0, to: 100 }, 50, null, fmt)).toBeNull();
    expect(checkRange({ from: 0, to: 100 }, 50, 40, fmt)).toMatch(/End must be after/);
    expect(checkRange({ from: 50, to: 40 }, 45, null, fmt)).toMatch(/no overlapping/);
  });
});

// ---- live feed: fallback to polling, recovery, dead-socket watchdog ----------------------
import { afterEach, beforeEach, vi } from 'vitest';
import { LiveFeed, hlCoins as coinsFor, coinLabel, hlSymbol as symFor, type FeedStatus as FS } from '../src/data/hyperliquid';

class FakeWS {
  static all: FakeWS[] = [];
  static fail = true;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
    setTimeout(() => {
      if (FakeWS.fail) { this.readyState = 3; this.onerror?.(); this.onclose?.(); } else { this.readyState = 1; this.onopen?.(); }
    }, 10);
  }
  send(m: string) { this.sent.push(m); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}

describe('live feed resilience', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeWS.all = []; FakeWS.fail = true; vi.stubGlobal('WebSocket', FakeWS); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const make = (poll: () => Promise<number[][]>) => {
    const st: FS[] = [], candles: number[][] = [], trades: number[][] = [];
    let opened = 0;
    const feed = new LiveFeed('BTC', { status: (s) => st.push(s), candle: (r) => candles.push(r), trade: (t, px) => trades.push([t, px]), opened: () => opened++ }, { poll, pollMs: 3000 });
    return { feed, st, candles, trades, opened: () => opened };
  };

  it('polls over HTTPS when the socket cannot connect, then returns to the socket', async () => {
    const poll = vi.fn(async () => [[1700000040, 100, 101, 99, 100.5, 3]]);
    const x = make(poll);
    await vi.advanceTimersByTimeAsync(1200); // first attempt fails, retry after 1 s fails too
    expect(x.feed.isPolling).toBe(true);
    await vi.advanceTimersByTimeAsync(3100);
    expect(poll).toHaveBeenCalled();
    expect(x.st).toContain('polling');
    expect(x.candles.length).toBeGreaterThan(0);
    expect(x.trades[0][1]).toBe(100.5);
    FakeWS.fail = false;
    await vi.advanceTimersByTimeAsync(12000);
    expect(x.st[x.st.length - 1]).toBe('live');
    expect(x.feed.isPolling).toBe(false);
    expect(x.opened()).toBe(1);
    const calls = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(poll.mock.calls.length).toBe(calls);
    x.feed.close();
  });

  it('reports offline when polling fails too', async () => {
    const x = make(async () => { throw new Error('down'); });
    await vi.advanceTimersByTimeAsync(12000);
    expect(x.st).toContain('offline');
    x.feed.close();
  });

  it('reconnects a socket that went silent', async () => {
    FakeWS.fail = false;
    const x = make(async () => []);
    await vi.advanceTimersByTimeAsync(50);
    expect(x.st[x.st.length - 1]).toBe('live');
    expect(FakeWS.all[0].sent.some((m) => m.includes('"trades"'))).toBe(true);
    await vi.advanceTimersByTimeAsync(31000); // pings go out, nothing comes back
    expect(FakeWS.all[0].readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1100);
    expect(FakeWS.all.length).toBeGreaterThan(1);
    x.feed.close();
  });

  it('wake() reconnects at once', async () => {
    const x = make(async () => []);
    await vi.advanceTimersByTimeAsync(5000);
    const n = FakeWS.all.length;
    FakeWS.fail = false;
    x.feed.wake();
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeWS.all.length).toBe(n + 1);
    expect(x.st[x.st.length - 1]).toBe('live');
    x.feed.close();
  });
});

describe('builder-deployed markets', () => {
  it('lists own perps and builder markets from one request, and names them', async () => {
    const f = (async () => ({ ok: true, status: 200, json: async () => [
      { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'OLD', szDecimals: 1, maxLeverage: 3, isDelisted: true }] },
      { universe: [{ name: 'xyz:GOLD', szDecimals: 4, maxLeverage: 20 }] },
    ] })) as unknown as typeof fetch;
    const coins = await coinsFor(f);
    expect(coins.map((c) => c.name)).toEqual(['BTC', 'xyz:GOLD']);
    expect(coins[1].dex).toBe('xyz');
    expect(coinLabel('xyz:GOLD')).toBe('GOLD · xyz');
    expect(coinLabel('BTC')).toBe('BTC');
    expect(symFor('xyz:GOLD')).toBe('HL-XYZGOLD');
  });
});
