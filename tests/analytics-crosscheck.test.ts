import { describe, expect, it } from 'vitest';
import { buildRecords } from '../src/analytics/records';
import { buildReport, groupBy, type Report } from '../src/analytics/report';
import { newSession, type Session } from '../src/engine/replay';
import type { Trade } from '../src/engine/broker';
import type { DatasetMeta } from '../src/core/types';
import { offsetFn } from '../src/core/tz';
import { rng } from '../src/data/synthetic';

/**
 * The analytics page is only worth something if its numbers are right. These tests work the
 * answers out a second way — by hand for a small list, with plain loops for random ones — and
 * compare them with what the report says.
 */
const DAY = 86400;
const spec = { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 };
const metas = new Map<string, DatasetMeta>([['EURUSD', { id: 'EURUSD', symbol: 'EURUSD', source: 'csv', resolution: 60, from: 0, to: 0, count: 0, spec, createdAt: 0 }]]);

interface Row { pnl: number; risk?: number | null; entry: number; exit: number; side?: 'long' | 'short'; tags?: string[] }

function sessionOf(rows: Row[], balance = 10000, tz = 'UTC', id = 's1'): Session {
  const s = newSession({
    id, name: 'Check', description: '', symbols: ['EURUSD'], start: rows[0]?.entry ?? 0, end: null, balance,
    commissionPerLot: 0, spreadPips: { '*': 0 }, slFirst: true, timezone: tz, riskPct: 1, createdAt: 0, specs: { EURUSD: spec },
  });
  let bal = balance;
  rows.forEach((x, i) => {
    bal += x.pnl;
    const risk = x.risk === undefined ? 100 : x.risk;
    const t: Trade = {
      id: i + 1, symbol: 'EURUSD', side: x.side ?? (i % 2 ? 'short' : 'long'), lots: 1, entry: 1.1, exit: 1.1, entryTime: x.entry, exitTime: x.exit,
      gross: x.pnl, commission: 0, pnl: x.pnl, pips: x.pnl / 10, risk, r: risk ? x.pnl / risk : null, maePips: 0, mfePips: 0, maeR: null, mfeR: null,
      holdSec: x.exit - x.entry, exitReason: x.pnl > 0 ? 'tp' : x.pnl < 0 ? 'sl' : 'manual', orderType: 'market', tags: x.tags ?? [], note: '', balanceAfter: bal, regime: null,
    };
    s.state.broker.trades.push(t);
  });
  s.state.broker.balance = bal;
  return s;
}
const report = (s: Session, tz = s.timezone) => buildReport(buildRecords([s], metas), { initial: s.balance, off: offsetFn(tz) });

/** Every number in the report, with its path. */
function numbers(o: unknown, path = '', out: [string, number][] = []): [string, number][] {
  if (typeof o === 'number') out.push([path, o]);
  else if (Array.isArray(o) || ArrayBuffer.isView(o)) (o as ArrayLike<unknown>).length <= 400 && Array.from(o as ArrayLike<unknown>).forEach((v, i) => numbers(v, `${path}[${i}]`, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) numbers(v, path ? `${path}.${k}` : k, out);
  return out;
}
const noNaN = (r: Report, what: string) => {
  const bad = numbers(r).filter(([, v]) => Number.isNaN(v)).map(([p]) => p);
  expect(bad, `${what}: NaN in the report`).toEqual([]);
};

// ten trades, one per weekday from Monday 1 January 2024, each risking $100 on a $10,000 account
const MON = Date.UTC(2024, 0, 1) / 1000;
const days = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
const PNL = [200, -100, 300, -100, -100, 150, 0, -100, 400, -50];
const hand = () => sessionOf(PNL.map((pnl, i) => ({ pnl, entry: MON + days[i] * DAY + 8 * 3600, exit: MON + days[i] * DAY + 9 * 3600 })));

describe('a trade list worked out by hand', () => {
  const r = report(hand())!;
  const c = r.core;
  it('counts and totals', () => {
    expect(r.n).toBe(10);
    expect([c.wins, c.losses, c.breakeven]).toEqual([4, 5, 1]);
    expect(c.winRate).toBeCloseTo(0.4, 12);
    expect(c.grossProfit).toBeCloseTo(1050, 6);
    expect(c.grossLoss).toBeCloseTo(450, 6);
    expect(r.netPnl).toBeCloseTo(600, 6);
    expect(r.final).toBeCloseTo(10600, 6);
    expect(r.returnPct).toBeCloseTo(0.06, 9);
  });
  it('averages and ratios', () => {
    expect(c.profitFactor).toBeCloseTo(1050 / 450, 9);
    expect(c.expectancy).toBeCloseTo(60, 6);
    expect(c.avgWin).toBeCloseTo(262.5, 6);
    expect(c.avgLoss).toBeCloseTo(-90, 6);
    expect(c.payoff).toBeCloseTo(262.5 / 90, 9);
    expect(c.largestWin).toBeCloseTo(400, 6);
    expect(c.largestLoss).toBeCloseTo(-100, 6);
    expect(c.kellyPct).toBeCloseTo(0.4 - 0.6 / (262.5 / 90), 9);
  });
  it('R multiples', () => {
    expect(r.unit).toBe('R');
    expect(c.totalR).toBeCloseTo(6, 9);
    expect(c.avgR).toBeCloseTo(0.6, 9);
    expect(c.avgWinR).toBeCloseTo(2.625, 9);
    expect(c.avgLossR).toBeCloseTo(-0.9, 9);
    expect(r.significance.mean).toBeCloseTo(0.6, 9);
  });
  it('drawdown: $200 from the $10,400 high, eight days under water', () => {
    expect(r.risk.maxDDAbs).toBeCloseTo(200, 6);
    expect(r.risk.maxDD).toBeCloseTo(200 / 10400, 9);
    expect(r.risk.maxDDDays).toBeCloseTo(8, 6);
    expect(c.recoveryFactor).toBeCloseTo(3, 6);
    expect(Math.min(...r.ddPath)).toBeCloseTo(-200 / 10400, 9);
  });
  it('streaks', () => {
    expect(c.maxLossStreak).toBe(2);
    expect(c.maxWinStreak).toBe(1);
    expect(c.currentStreak).toBe(-1);
  });
  it('days and months', () => {
    expect(r.localDays.length).toBe(10);
    expect(c.bestDay).toBeCloseTo(400, 6);
    expect(c.worstDay).toBeCloseTo(-100, 6);
    expect(c.profitableDaysPct).toBeCloseTo(0.4, 9);
    expect(r.months.map((m) => m.key)).toEqual(['2024-01']);
    expect(r.months[0].ret).toBeCloseTo(0.06, 9);
    expect(r.daily.equity[r.daily.equity.length - 1]).toBeCloseTo(10600, 6);
    expect(r.daily.ret.length).toBe(10); // ten weekdays, the weekend is not a trading day
  });
});

describe('awkward trade lists never produce a broken number', () => {
  const at = (i: number) => ({ entry: MON + i * DAY + 3600, exit: MON + i * DAY + 7200 });
  it('one winning trade', () => {
    const r = report(sessionOf([{ pnl: 50, ...at(0) }]))!;
    noNaN(r, 'one trade');
    expect(r.netPnl).toBeCloseTo(50, 6);
    expect(r.core.winRate).toBe(1);
    expect(r.core.profitFactor).toBe(Infinity);
    expect(r.risk.maxDD).toBe(0);
  });
  it('one losing trade', () => {
    const r = report(sessionOf([{ pnl: -50, ...at(0) }]))!;
    noNaN(r, 'one loss');
    expect(r.core.profitFactor).toBe(0);
    expect(r.risk.maxDDAbs).toBeCloseTo(50, 6);
  });
  it('only winners, only losers, only break-even', () => {
    for (const [what, f] of [['wins', () => 80], ['losses', () => -80], ['break-even', () => 0]] as const) {
      const r = report(sessionOf(Array.from({ length: 30 }, (_, i) => ({ pnl: f(), ...at(i) }))))!;
      noNaN(r, what);
      expect(r.netPnl).toBeCloseTo(30 * f(), 4);
      expect(r.core.wins + r.core.losses + r.core.breakeven).toBe(30);
    }
  });
  it('no stop on any trade: results are measured in average-loss units instead of R', () => {
    const rand = rng(5);
    const r = report(sessionOf(Array.from({ length: 40 }, (_, i) => ({ pnl: Math.round((rand() - 0.45) * 300), risk: null, ...at(i) }))))!;
    noNaN(r, 'no stops');
    expect(r.unit).toBe('ALU');
    expect(r.core.totalR).toBeNull();
    expect(r.robustness.slUsage).toBe(0);
  });
  it('several trades closing in the same second (Close all)', () => {
    const t = MON + 5 * 3600;
    const rows = [{ pnl: 120, entry: t - 3000, exit: t }, { pnl: -80, entry: t - 5000, exit: t }, { pnl: 40, entry: t - 1000, exit: t }, { pnl: -30, entry: t - 1000, exit: t }];
    const r = report(sessionOf(rows))!;
    noNaN(r, 'same second');
    expect(r.netPnl).toBeCloseTo(50, 6);
    expect(r.final).toBeCloseTo(10050, 6);
  });
  it('an account that is wiped out', () => {
    const r = report(sessionOf([{ pnl: -6000, ...at(0) }, { pnl: -4000, ...at(1) }, { pnl: 100, ...at(2) }]))!;
    noNaN(r, 'wiped out');
    expect(r.final).toBeGreaterThanOrEqual(0);
    expect(r.risk.maxDD).toBeLessThanOrEqual(1);
  });
});

describe('random trade lists agree with a plain recount', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const n = 5 + Math.floor(rand() * 400);
      const start = 20000 + Math.floor(rand() * 80000);
      let t = MON + Math.floor(rand() * 200) * DAY;
      const rows: Row[] = [];
      for (let i = 0; i < n; i++) {
        t += Math.floor(rand() * 2.5 * DAY) + 60;
        const hold = 60 + Math.floor(rand() * 2 * DAY);
        const u = rand();
        const pnl = u < 0.07 ? 0 : Math.round((rand() - 0.47) * start * 0.02 * 100) / 100;
        rows.push({ pnl, entry: t, exit: t + hold, side: rand() < 0.5 ? 'long' : 'short', risk: rand() < 0.9 ? start * 0.005 : null, tags: rand() < 0.5 ? ['a'] : rand() < 0.5 ? ['b'] : [] });
      }
      const s = sessionOf(rows, start);
      const r = report(s)!;
      noNaN(r, `seed ${seed}`);

      // a plain recount, in the order trades closed
      const T = [...s.state.broker.trades].sort((a, b) => a.exitTime - b.exitTime || a.id - b.id);
      let bal = start, peak = start, ddAbs = 0, ddPct = 0, gp = 0, gl = 0, w = 0, l = 0, sumR = 0, nR = 0;
      const byDay = new Map<number, number>(), byMonth = new Map<string, number>();
      for (const x of T) {
        bal += x.pnl;
        if (x.pnl > 0) (w++, (gp += x.pnl));
        else if (x.pnl < 0) (l++, (gl -= x.pnl));
        if (bal > peak) peak = bal;
        ddAbs = Math.max(ddAbs, peak - bal);
        ddPct = Math.max(ddPct, (peak - bal) / peak);
        if (x.r != null) (sumR += x.r), nR++;
        const d = Math.floor(x.exitTime / DAY);
        byDay.set(d, (byDay.get(d) ?? 0) + x.pnl);
        const mk = new Date(x.exitTime * 1000).toISOString().slice(0, 7);
        byMonth.set(mk, (byMonth.get(mk) ?? 0) + x.pnl);
      }
      const net = bal - start, tol = Math.max(1e-6, Math.abs(start) * 1e-9);
      expect(r.n).toBe(n);
      expect(Math.abs(r.netPnl - net)).toBeLessThan(tol);
      expect(Math.abs(r.final - bal)).toBeLessThan(tol);
      expect([r.core.wins, r.core.losses, r.core.breakeven]).toEqual([w, l, n - w - l]);
      expect(Math.abs(r.core.grossProfit - gp)).toBeLessThan(tol * 10);
      expect(Math.abs(r.core.grossLoss - gl)).toBeLessThan(tol * 10);
      if (gl > 0) expect(r.core.profitFactor).toBeCloseTo(gp / gl, 6);
      expect(Math.abs(r.risk.maxDDAbs - ddAbs)).toBeLessThan(tol * 10);
      expect(r.risk.maxDD).toBeCloseTo(ddPct, 9);
      if (nR) expect(r.core.totalR!).toBeCloseTo(sumR, 6);
      expect(r.core.expectancy).toBeCloseTo(net / n, 6);

      // the parts add up to the whole
      expect(Math.abs(r.months.reduce((a, m) => a + m.pnl, 0) - net)).toBeLessThan(tol * 10);
      expect(r.months.reduce((a, m) => a + m.trades, 0)).toBe(n);
      expect(Math.abs(r.localDays.reduce((a, d) => a + d.pnl, 0) - net)).toBeLessThan(tol * 10);
      expect(Math.abs(r.daily.equity[r.daily.equity.length - 1] - bal)).toBeLessThan(tol * 10);
      expect(r.daily.count.reduce((a, b) => a + b, 0)).toBe(n);
      expect(r.equity.v[r.equity.v.length - 1]).toBeCloseTo(r.final, 6);
      for (const [mk, v] of byMonth) expect(Math.abs((r.months.find((m) => m.key === mk)?.pnl ?? NaN) - v)).toBeLessThan(tol * 10);
      expect(r.core.bestDay).toBeCloseTo(Math.max(...byDay.values()), 4);
      expect(r.core.worstDay).toBeCloseTo(Math.min(...byDay.values()), 4);
      for (const groups of [groupBy(r.trades, (x) => x.side), groupBy(r.trades, (x) => x.exitReason), groupBy(r.trades, (x) => (x.tags.length ? x.tags : ['(untagged)']))]) {
        expect(groups.reduce((a, g) => a + g.trades, 0)).toBe(n);
        expect(Math.abs(groups.reduce((a, g) => a + g.pnl, 0) - net)).toBeLessThan(tol * 10);
        expect(groups.reduce((a, g) => a + g.wins, 0)).toBe(w);
      }
      // bounded figures stay in their range
      expect(r.core.winRate).toBeGreaterThanOrEqual(0);
      expect(r.core.winRate).toBeLessThanOrEqual(1);
      expect(r.risk.underwaterPct).toBeGreaterThanOrEqual(0);
      expect(r.risk.underwaterPct).toBeLessThanOrEqual(1);
      for (const p of [r.significance.pValue, r.significance.psr, r.ruin30, r.propPass]) if (p != null) (expect(p).toBeGreaterThanOrEqual(0), expect(p).toBeLessThanOrEqual(1));
      if (r.significance.ciLow != null) (expect(r.significance.ciLow).toBeLessThanOrEqual(r.significance.mean + 1e-9), expect(r.significance.ciHigh!).toBeGreaterThanOrEqual(r.significance.mean - 1e-9));
      expect(r.score.score == null || (r.score.score >= 0 && r.score.score <= 100)).toBe(true);
    });
  }
});

describe('calendar days and months follow the chart timezone', () => {
  it('a trade closed at 20:00 UTC on 31 January belongs to 1 February in Jakarta', () => {
    const t = Date.UTC(2024, 0, 31, 20) / 1000;
    const rows = [{ pnl: 100, entry: t - 3600, exit: t }, { pnl: -40, entry: t + DAY, exit: t + DAY + 3600 }];
    const utc = report(sessionOf(rows, 10000, 'UTC'))!;
    const jkt = report(sessionOf(rows, 10000, 'Asia/Jakarta'))!;
    expect(utc.months.map((m) => m.key)).toEqual(['2024-01', '2024-02']);
    expect(jkt.months.map((m) => m.key)).toEqual(['2024-02']);
    expect(utc.localDays.map((d) => d.key)).toEqual(['2024-01-31', '2024-02-01']);
    expect(jkt.localDays.map((d) => d.key)).toEqual(['2024-02-01', '2024-02-02']);
  });
});
