import { describe, expect, it } from 'vitest';
import { normCdf, normInv, tCdf, quantile, linreg, lerpAnchors, kurtosis, skewness } from '../src/analytics/math';
import { regimeSeries, tagAt } from '../src/analytics/regime';
import { buildRecords, frictionPips } from '../src/analytics/records';
import { buildReport } from '../src/analytics/report';
import { simulatePaths, riskSizing, propFirmSim, ruinProbability } from '../src/analytics/montecarlo';
import { GATES, PILLARS, regimeIndex } from '../src/analytics/score';
import { newSession, type Session } from '../src/engine/replay';
import type { Trade } from '../src/engine/broker';
import { emptyBars, type DatasetMeta } from '../src/core/types';
import { offsetFn } from '../src/core/tz';
import { rng } from '../src/data/synthetic';
import type { Trend, Vol } from '../src/analytics/regime';

const DAY = 86400;
const T0 = Date.UTC(2024, 0, 1) / 1000;
const spec = { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 };

/** Build a session whose trades have the given R results, 1% risk each, one trade per weekday. */
function session(rs: number[], opts: { trend?: (i: number) => Trend; vol?: (i: number) => Vol; perDay?: number; id?: string; balance?: number } = {}): Session {
  const s = newSession({
    id: opts.id ?? 's1', name: 'Test', description: '', symbols: ['EURUSD'], start: T0, end: null, balance: opts.balance ?? 10000,
    commissionPerLot: 0, spreadPips: { '*': 0 }, slFirst: true, timezone: 'UTC', riskPct: 1, createdAt: 0, specs: { EURUSD: spec },
  });
  let bal = s.balance;
  let day = 0;
  const perDay = opts.perDay ?? 1;
  rs.forEach((r, i) => {
    if (i % perDay === 0) {
      day++;
      while ([0, 6].includes(new Date((T0 + day * DAY) * 1000).getUTCDay())) day++;
    }
    const entryTime = T0 + day * DAY + 8 * 3600 + (i % perDay) * 3600;
    const risk = bal * 0.01;
    const pnl = r * risk;
    bal += pnl;
    const t: Trade = {
      id: i + 1, symbol: 'EURUSD', side: i % 2 ? 'short' : 'long', lots: 1, entry: 1.1, exit: 1.1 + r * 0.001, entryTime, exitTime: entryTime + 1800,
      gross: pnl, commission: 0, pnl, pips: r * 10, risk, r, maePips: 5, mfePips: Math.max(0, r) * 10 + 2, maeR: 0.5, mfeR: Math.max(0, r) + 0.2,
      holdSec: 1800, exitReason: r > 0 ? 'tp' : 'sl', orderType: 'market', tags: [], note: '', balanceAfter: bal,
      regime: { trend: opts.trend?.(i) ?? (['up', 'down', 'range'] as Trend[])[i % 3], vol: opts.vol?.(i) ?? (['low', 'normal', 'high'] as Vol[])[Math.floor(i / 3) % 3], adx: 25, atrPct: 0.001 },
    };
    s.state.broker.trades.push(t);
  });
  s.state.broker.balance = bal;
  return s;
}

const meta = (source: DatasetMeta['source'] = 'csv') =>
  new Map<string, DatasetMeta>([['EURUSD', { id: 'EURUSD', symbol: 'EURUSD', source, resolution: 60, from: 0, to: 0, count: 0, spec, createdAt: 0 }]]);

/** Strong, regime-independent edge: wins +2R 50% of the time, else −1R, in a shuffled order. */
function edgeSeries(n: number, seed = 3, win = 0.5, w = 2, l = -1) {
  const rand = rng(seed);
  return Array.from({ length: n }, () => (rand() < win ? w : l));
}

const reportOf = (s: Session | Session[], source: DatasetMeta['source'] = 'csv') => {
  const ss = Array.isArray(s) ? s : [s];
  return buildReport(buildRecords(ss, meta(source)), { initial: ss.length === 1 ? ss[0].balance : 10000, off: offsetFn('UTC') })!;
};

describe('math', () => {
  it('normal and t distributions', () => {
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4);
    expect(normInv(0.05)).toBeCloseTo(-1.644854, 4);
    expect(tCdf(1, 1)).toBeCloseTo(0.75, 6); // Cauchy
    expect(tCdf(2, 10)).toBeCloseTo(0.96331, 4);
    expect(tCdf(-2, 10)).toBeCloseTo(1 - 0.96331, 4);
  });
  it('quantile, regression, anchors, moments', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
    expect(linreg([1, 3, 5, 7]).r2).toBeCloseTo(1);
    expect(linreg([1, 3, 5, 7]).slope).toBeCloseTo(2);
    const a = [[0, 0], [10, 100]] as const;
    expect(lerpAnchors(5, a)).toBe(50);
    expect(lerpAnchors(-1, a)).toBe(0);
    expect(lerpAnchors(Infinity, a)).toBe(100);
    expect(lerpAnchors(null, a)).toBeNull();
    const desc = [[0, 100], [0.4, 0]] as const;
    expect(lerpAnchors(0.2, desc)).toBe(50);
    expect(skewness([1, 2, 3])).toBeCloseTo(0);
    expect(kurtosis([-1, 1, -1, 1])).toBeCloseTo(1);
  });
});

describe('regime classification', () => {
  it('tags a steady uptrend as up and a choppy market as ranging, using only past bars', () => {
    const n = 400;
    const b = emptyBars(n);
    const rand = rng(5);
    let p = 1;
    for (let i = 0; i < n; i++) {
      const trending = i < 250;
      const o = p;
      const c = trending ? o * (1 + 0.004 + (rand() - 0.5) * 0.002) : o * (1 + (rand() - 0.5) * 0.004);
      b.t[i] = T0 + i * 4 * 3600;
      b.o[i] = o;
      b.c[i] = c;
      b.h[i] = Math.max(o, c) * (1 + rand() * 0.001);
      b.l[i] = Math.min(o, c) * (1 - rand() * 0.001);
      b.v[i] = 1;
      p = trending ? c : 1.5 + (rand() - 0.5) * 0.01; // flat, mean-reverting chop after bar 250
    }
    b.n = n;
    const rs = regimeSeries(b);
    expect(tagAt(rs, b, b.t[5])).toBeNull(); // warm-up: not enough history
    expect(tagAt(rs, b, b.t[200] + 60)!.trend).toBe('up');
    expect(tagAt(rs, b, b.t[390] + 60)!.trend).toBe('range');
    // no look-ahead: the tag at bar k uses bar k-1
    const k = 200;
    expect(tagAt(rs, b, b.t[k])!.adx).toBeCloseTo(rs.adx[k - 1], 1);
  });
});

describe('records & report', () => {
  it('normalises trades so a single-session report reproduces the real equity', () => {
    const s = session(edgeSeries(120));
    const rep = reportOf(s);
    expect(rep.n).toBe(120);
    expect(rep.final).toBeCloseTo(s.state.broker.balance, 6);
    expect(rep.unit).toBe('R');
    expect(rep.trades.every((t, i) => Math.abs(t.pnlRef - s.state.broker.trades[i].pnl) < 1e-6)).toBe(true);
    expect(rep.core.winRate).toBeGreaterThan(0.35);
    expect(rep.months.length).toBeGreaterThanOrEqual(5);
    expect(rep.ratios.sharpe).not.toBeNull();
    expect(rep.daily.ppy).toBe(252);
  });

  it('measures significance, friction, outliers and regimes', () => {
    const rep = reportOf(session(edgeSeries(200)));
    const sg = rep.significance;
    expect(sg.mean).toBeGreaterThan(0.2);
    expect(sg.pValue!).toBeLessThan(0.01);
    expect(sg.ciLow!).toBeGreaterThan(0);
    expect(sg.ciHigh!).toBeGreaterThan(sg.ciLow!);
    expect(sg.psr!).toBeGreaterThan(0.95);
    expect(rep.robustness.friction[1].exp).toBeLessThan(rep.robustness.friction[0].exp);
    expect(rep.robustness.breakEvenFriction!).toBeGreaterThan(1);
    expect(rep.robustness.outlier!.exp).toBeLessThan(sg.mean);
    expect(rep.regimes.testedTrend).toBe(3);
    expect(rep.regimes.losingTrend).toBe(0);
    expect(rep.synthetic).toBe('none');
    expect(frictionPips(1.1, 0.0001)).toBeCloseTo(1.1);
    expect(frictionPips(60000, 1)).toBeCloseTo(6);
  });

  it('combines sessions with different account sizes into one normalised record', () => {
    const a = session(edgeSeries(60, 1), { id: 'a', balance: 5000 });
    const b = session(edgeSeries(60, 2), { id: 'b', balance: 100000 });
    const rep = reportOf([a, b]);
    expect(rep.n).toBe(120);
    expect(rep.initial).toBe(10000);
    // compounding the per-trade returns of both sessions on one account
    const expected = rep.trades.reduce((e, t) => e * (1 + t.pct), 10000);
    expect(rep.final).toBeCloseTo(expected, 4);
  });

  it('flags synthetic data', () => {
    expect(reportOf(session(edgeSeries(30)), 'synthetic').synthetic).toBe('all');
  });
});

describe('Overflow Score', () => {
  it('rates a strong, all-weather edge highly', () => {
    const rep = reportOf(session(edgeSeries(300, 9)));
    expect(rep.score.score!).toBeGreaterThanOrEqual(70);
    expect(rep.score.gates.filter((g) => g.hit)).toEqual([]);
    expect(['allweather', 'robust']).toContain(rep.score.tier);
    expect(rep.score.pillars).toHaveLength(PILLARS.length);
  });

  it('caps a negative expectancy at "No edge"', () => {
    const rep = reportOf(session(edgeSeries(150, 4, 0.3, 1.5, -1)));
    expect(rep.significance.mean).toBeLessThan(0);
    expect(rep.score.score!).toBeLessThanOrEqual(34);
    expect(rep.score.tier).toBe('noedge');
    expect(rep.score.suggestions[0]).toMatch(/loses/);
  });

  it('caps small samples and refuses to score fewer than 10 trades', () => {
    expect(reportOf(session(edgeSeries(8))).score.score).toBeNull();
    const small = reportOf(session(edgeSeries(25, 6)));
    expect(small.score.score!).toBeLessThanOrEqual(49);
    expect(small.score.gates.find((g) => g.id === 'sample')!.hit).toBe(true);
  });

  it('penalises an edge that only works in one regime', () => {
    // wins in uptrends only, loses when ranging or trending down
    const rs = edgeSeries(240, 12).map((r, i) => (i % 3 === 0 ? Math.abs(r) * 2 : -1));
    const rep = reportOf(session(rs));
    expect(rep.regimes.losingTrend).toBe(2);
    expect(rep.score.gates.find((g) => g.id === 'regimes')!.hit).toBe(true);
    expect(rep.score.score!).toBeLessThanOrEqual(64);
    expect(rep.score.allWeather).toBe(false);
    expect(regimeIndex(rep.regimes.trend)!).toBeLessThan(40);
  });

  it('applies the monthly loss rule', () => {
    const g = GATES.find((x) => x.id === 'monthly')!;
    expect(g.cap).toBe(69);
  });
});

describe('Monte Carlo', () => {
  const rets = edgeSeries(200, 2).map((r) => r * 0.01);
  it('is deterministic and produces consistent bands', () => {
    const o = { runs: 300, horizon: 50, mode: 'bootstrap' as const, skip: 0, friction: 0, seed: 1, ruinLevels: [0.1, 0.2, 0.3] };
    const a = simulatePaths(rets, rets.map(() => 0.0005), o)!;
    const b = simulatePaths(rets, rets.map(() => 0.0005), o)!;
    expect(a.final.p50).toBe(b.final.p50);
    expect(a.bands.p50).toHaveLength(51);
    expect(a.bands.p5[50]).toBeLessThanOrEqual(a.bands.p95[50]);
    expect(a.ruin[0].prob).toBeGreaterThanOrEqual(a.ruin[2].prob);
    const stressed = simulatePaths(rets, rets.map(() => 0.0005), { ...o, friction: 4, skip: 0.1 })!;
    expect(stressed.final.p50).toBeLessThan(a.final.p50);
    const sh = simulatePaths(rets, rets.map(() => 0), { ...o, mode: 'shuffle' })!;
    expect(sh.horizon).toBe(200);
    expect(sh.final.p5).toBeCloseTo(sh.final.p95, 8); // same trades, any order → same final equity
  });
  it('risk sizing, ruin and prop-firm simulation behave sensibly', () => {
    const units = edgeSeries(200, 2);
    const rows = riskSizing(units, [0.005, 0.01, 0.03], 300, 100);
    expect(rows[0].medianDD).toBeLessThan(rows[2].medianDD);
    expect(ruinProbability(rets, 0.05)!).toBeGreaterThan(ruinProbability(rets, 0.4)!);
    const rules = { profitTarget: 0.1, maxDailyLoss: 0.05, maxTotalLoss: 0.1, minTradingDays: 4, trailingDrawdown: false };
    const good = propFirmSim(units.map((u) => u * 0.01), [0, 1, 1, 2], rules, 500, 60)!;
    const bad = propFirmSim(edgeSeries(200, 2, 0.3, 1, -1).map((u) => u * 0.01), [0, 1, 1, 2], rules, 500, 60)!;
    expect(good.pass).toBeGreaterThan(0.5);
    expect(bad.pass).toBeLessThan(0.1);
    expect(good.pass + good.failDaily + good.failTotal + good.unfinished).toBeCloseTo(1);
  });
});
