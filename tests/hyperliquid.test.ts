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
