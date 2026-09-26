import { describe, expect, it } from 'vitest';
import { parseTf, aggregate, partialCandle, bucketKey } from '../src/core/timeframe';
import { barsFromRows } from '../src/core/types';
import { offsetFn } from '../src/core/tz';
import { parseCsv, parseStamp } from '../src/data/csv';
import { Broker, newBrokerState } from '../src/engine/broker';
import { computeStats, monteCarlo } from '../src/analytics/stats';
import { generateSynthetic } from '../src/data/synthetic';
import { ema, sma } from '../src/core/indicators';

const utc = offsetFn('UTC');

describe('timeframes', () => {
  it('parses any timeframe', () => {
    expect(parseTf('7m')!.sec).toBe(420);
    expect(parseTf('13')!.sec).toBe(780);
    expect(parseTf('2H')!.sec).toBe(7200);
    expect(parseTf('4h')!.label).toBe('4H');
    expect(parseTf('D')!.sec).toBe(86400);
    expect(parseTf('3D')!.sec).toBe(3 * 86400);
    expect(parseTf('W')!.unit).toBe('W');
    expect(parseTf('1M')!.unit).toBe('M');
    expect(parseTf('1m')!.unit).toBe('m');
    expect(parseTf('45s')!.sec).toBe(45);
    expect(parseTf('abc')).toBeNull();
  });

  it('aligns weekly buckets to Monday and monthly to the 1st', () => {
    const wed = Date.UTC(2024, 0, 10, 12) / 1000; // Wed
    expect(new Date(bucketKey(wed, parseTf('W')!) * 1000).getUTCDay()).toBe(1);
    expect(new Date(bucketKey(wed, parseTf('M')!) * 1000).toISOString().slice(0, 10)).toBe('2024-01-01');
  });

  it('restarts non-divisor intraday frames each day', () => {
    const day = Date.UTC(2024, 0, 2) / 1000;
    expect(bucketKey(day + 5, parseTf('7m')!)).toBe(day);
    expect(bucketKey(day + 7 * 60 + 1, parseTf('7m')!)).toBe(day + 420);
  });

  it('aggregates 1m bars into any timeframe with correct OHLCV', () => {
    const t0 = Date.UTC(2024, 0, 2) / 1000;
    const rows = Array.from({ length: 120 }, (_, i) => [t0 + i * 60, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.2, 1]);
    const b = barsFromRows(rows);
    const a = aggregate(b, parseTf('7m')!, utc);
    expect(a.n).toBe(Math.ceil(120 / 7));
    expect(a.o[0]).toBe(100);
    expect(a.c[0]).toBeCloseTo(106.2);
    expect(a.h[0]).toBeCloseTo(106.5);
    expect(a.l[0]).toBeCloseTo(99.5);
    expect(a.v[0]).toBe(7);
    const h1 = aggregate(b, parseTf('1H')!, utc);
    expect(h1.n).toBe(2);
    // forming candle only sees bars up to the cursor
    const p = partialCandle(b, h1, 1, 65);
    expect(p.open).toBe(160);
    expect(p.close).toBeCloseTo(165.2);
    expect(p.high).toBeCloseTo(165.5);
  });

  it('applies timezone offsets for daily candles', () => {
    const jkt = offsetFn('Asia/Jakarta');
    expect(jkt(Date.UTC(2024, 5, 1) / 1000)).toBe(7 * 3600);
    const ny = offsetFn('America/New_York');
    expect(ny(Date.UTC(2024, 0, 15) / 1000)).toBe(-5 * 3600);
    expect(ny(Date.UTC(2024, 6, 15) / 1000)).toBe(-4 * 3600);
  });
});

describe('csv', () => {
  it('parses common timestamp formats', () => {
    const e = Date.UTC(2024, 0, 2, 13, 5) / 1000;
    expect(parseStamp('2024.01.02 13:05')).toBe(e);
    expect(parseStamp('20240102 130500')).toBe(e);
    expect(parseStamp('02.01.2024 13:05:00.000')).toBe(e);
    expect(parseStamp('2024-01-02T13:05:00Z')).toBe(e);
    expect(parseStamp(String(e * 1000))).toBe(e);
  });
  it('parses MT4 and HistData files', () => {
    const mt4 = '2024.01.02,00:00,1.1,1.2,1.0,1.15,10\n2024.01.02,00:01,1.15,1.16,1.14,1.155,5';
    const b = parseCsv(mt4);
    expect(b.n).toBe(2);
    expect(b.c[1]).toBe(1.155);
    const hd = '20240102 000000;1.1;1.2;1.0;1.15;0\n20240102 000100;1.15;1.16;1.14;1.155;0';
    const b2 = parseCsv(hd, -5);
    expect(b2.t[0]).toBe(Date.UTC(2024, 0, 2, 5) / 1000);
  });
  it('parses header CSVs', () => {
    const b = parseCsv('Date,Open,High,Low,Close,Volume\n2024-01-02 00:00:00,1,2,0.5,1.5,100');
    expect(b.n).toBe(1);
    expect(b.h[0]).toBe(2);
  });
});

describe('broker', () => {
  const spec = { EURUSD: { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 } };
  const mk = (slFirst = true) =>
    new Broker({ initialBalance: 10000, commissionPerLot: 0, spreadPips: { '*': 0 }, slFirst }, spec, newBrokerState(10000));

  it('fills market orders and hits TP', () => {
    const br = mk();
    br.setPrice('EURUSD', 0, 1.1);
    const r = br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1, sl: 1.099, tp: 1.102 });
    expect(r.ok).toBe(true);
    br.onBar('EURUSD', 60, 1.1, 1.1025, 1.0995, 1.102);
    expect(br.s.positions.length).toBe(0);
    const t = br.s.trades[0];
    expect(t.exitReason).toBe('tp');
    expect(t.pnl).toBeCloseTo(200);
    expect(t.r).toBeCloseTo(2);
    expect(br.s.balance).toBeCloseTo(10200);
  });

  it('assumes SL first when both are touched in one bar', () => {
    const br = mk(true);
    br.setPrice('EURUSD', 0, 1.1);
    br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1, sl: 1.099, tp: 1.101 });
    br.onBar('EURUSD', 60, 1.1, 1.102, 1.098, 1.1);
    expect(br.s.trades[0].exitReason).toBe('sl');
    expect(br.s.trades[0].pnl).toBeCloseTo(-100);
  });

  it('fills limit and stop orders with gap handling', () => {
    const br = mk();
    br.setPrice('EURUSD', 0, 1.1);
    expect(br.place({ symbol: 'EURUSD', side: 'long', type: 'limit', lots: 1, price: 1.099 }).ok).toBe(true);
    expect(br.place({ symbol: 'EURUSD', side: 'short', type: 'stop', lots: 1, price: 1.098 }).ok).toBe(true);
    // gap down through both levels
    br.onBar('EURUSD', 60, 1.097, 1.0975, 1.096, 1.097);
    expect(br.s.positions.length).toBe(2);
    const long = br.s.positions.find((p) => p.side === 'long')!;
    const short = br.s.positions.find((p) => p.side === 'short')!;
    expect(long.entry).toBe(1.097); // better than limit because of the gap
    expect(short.entry).toBe(1.097); // stop slips to the open
  });

  it('rejects invalid SL/TP', () => {
    const br = mk();
    br.setPrice('EURUSD', 0, 1.1);
    expect(br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1, sl: 1.2 }).ok).toBe(false);
    expect(br.place({ symbol: 'EURUSD', side: 'short', type: 'limit', lots: 1, price: 1.09 }).ok).toBe(false);
  });

  it('supports partial closes, breakeven and trailing', () => {
    const br = mk();
    br.setPrice('EURUSD', 0, 1.1);
    const r = br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 2, sl: 1.099, trailPips: 5 });
    if (!r.ok) throw new Error();
    br.onBar('EURUSD', 60, 1.1, 1.102, 1.1, 1.102);
    const p = br.s.positions[0];
    expect(p.sl).toBeCloseTo(1.1015);
    br.close(p.id, 0.5);
    expect(br.s.positions[0].lots).toBe(1);
    br.onBar('EURUSD', 120, 1.102, 1.102, 1.1, 1.1);
    expect(br.s.trades.length).toBe(1);
    expect(br.s.trades[0].exitReason).toBe('trail');
    expect(br.s.trades[0].lots).toBe(2);
    expect(br.s.trades[0].pnl).toBeCloseTo(200 + 150);
  });

  it('sizes positions by risk', () => {
    const br = mk();
    br.setPrice('EURUSD', 0, 1.1);
    expect(br.lotsForRisk('EURUSD', 100, 0.001, 1.1)).toBe(1);
    expect(br.lotsForRisk('EURUSD', 50, 0.002, 1.1)).toBe(0.25);
  });

  it('converts P&L for USD-base pairs', () => {
    const br = new Broker({ initialBalance: 1e4, commissionPerLot: 0, spreadPips: {}, slFirst: true }, { USDJPY: { symbol: 'USDJPY', pipSize: 0.01, contractSize: 100000, digits: 3 } }, newBrokerState(1e4));
    br.setPrice('USDJPY', 0, 150);
    br.place({ symbol: 'USDJPY', side: 'long', type: 'market', lots: 1 });
    br.setPrice('USDJPY', 60, 151);
    br.closeAll();
    expect(br.s.trades[0].pnl).toBeCloseTo((1 * 100000) / 151);
  });
});

describe('stats', () => {
  it('computes core metrics', () => {
    const mkT = (pnl: number, i: number) => ({
      id: i, symbol: 'X', side: 'long' as const, lots: 1, entry: 1, exit: 1, entryTime: i * 3600, exitTime: i * 3600 + 60,
      gross: pnl, commission: 0, pnl, pips: 0, risk: 100, r: pnl / 100, maePips: 0, mfePips: 0, maeR: 0.5, mfeR: 1, holdSec: 60,
      exitReason: 'tp' as const, orderType: 'market' as const, tags: [], note: '', balanceAfter: 0,
    });
    const trades = [200, -100, 200, -100, -100, 300].map(mkT);
    let b = 10000;
    for (const t of trades) t.balanceAfter = b += t.pnl;
    const s = computeStats(trades, 10000);
    expect(s.trades).toBe(6);
    expect(s.winRate).toBeCloseTo(0.5);
    expect(s.netPnl).toBe(400);
    expect(s.profitFactor).toBeCloseTo(700 / 300);
    expect(s.maxDD).toBe(200);
    expect(s.maxLossStreak).toBe(2);
    expect(s.totalR).toBeCloseTo(4);
    const mc = monteCarlo(trades, 10400, 200, 50);
    expect(mc).not.toBeNull();
    expect(mc!.bands.p50.length).toBe(51);
  });
});

describe('indicators & synthetic data', () => {
  it('sma/ema', () => {
    const x = [1, 2, 3, 4, 5];
    expect(Array.from(sma(x, 5, 3)).slice(2)).toEqual([2, 3, 4]);
    expect(ema(x, 5, 3)[2]).toBe(2);
  });
  it('generates weekday-only 1m bars', () => {
    const b = generateSynthetic({ start: Date.UTC(2024, 0, 1) / 1000, days: 14, price: 1.1 });
    expect(b.n).toBeGreaterThan(9 * 1400);
    for (let i = 0; i < b.n; i++) expect(new Date(b.t[i] * 1000).getUTCDay()).not.toBe(6);
  });
});
