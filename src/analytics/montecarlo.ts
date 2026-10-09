import { rng } from '../data/synthetic';
import { quantileSorted } from './math';

/**
 * Monte Carlo tools. Inputs are per-trade returns as fractions of equity
 * (e.g. 0.012 = +1.2 %). Paths compound, so position sizing behaves like a
 * fixed-fractional account.
 */

export interface PathSimOptions {
  runs: number;
  /** trades per simulated path (shuffle mode always uses every trade once) */
  horizon: number;
  mode: 'bootstrap' | 'shuffle';
  /** probability of skipping a trade — missed signals, days off */
  skip: number;
  /** extra friction units charged on every trade (slippage / wider spreads) */
  friction: number;
  seed: number;
  ruinLevels: number[];
}

export const DEFAULT_PATH_OPTS: PathSimOptions = { runs: 1000, horizon: 100, mode: 'bootstrap', skip: 0, friction: 0, seed: 7, ruinLevels: [0.1, 0.2, 0.3, 0.5] };

export interface Quantiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface PathSimResult {
  runs: number;
  horizon: number;
  mode: 'bootstrap' | 'shuffle';
  bands: { p5: Float64Array; p25: Float64Array; p50: Float64Array; p75: Float64Array; p95: Float64Array };
  /** final equity as a multiple of the starting equity */
  final: Quantiles & { mean: number };
  profitProb: number;
  dd: { p50: number; p75: number; p95: number; p99: number; mean: number; max: number };
  ddHist: { lo: number; hi: number; count: number }[];
  ruin: { level: number; prob: number }[];
  lossStreak: { p50: number; p95: number };
}

export function simulatePaths(rets: number[], friction: number[], o: PathSimOptions): PathSimResult | null {
  const n = rets.length;
  if (n < 5) return null;
  const H = o.mode === 'shuffle' ? n : Math.max(1, Math.round(o.horizon));
  const runs = Math.max(50, Math.round(o.runs));
  const rand = rng(o.seed);
  const paths = new Float32Array(runs * (H + 1));
  const finals = new Float64Array(runs), dds = new Float64Array(runs), streaks = new Float64Array(runs);
  const ruinHits = o.ruinLevels.map(() => 0);
  const idx = new Int32Array(n);
  let profit = 0;
  for (let r = 0; r < runs; r++) {
    if (o.mode === 'shuffle') {
      for (let i = 0; i < n; i++) idx[i] = i;
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = idx[i];
        idx[i] = idx[j];
        idx[j] = tmp;
      }
    }
    let e = 1, peak = 1, mdd = 0, streak = 0, maxStreak = 0;
    const base = r * (H + 1);
    paths[base] = 1;
    for (let i = 1; i <= H; i++) {
      const k = o.mode === 'shuffle' ? idx[i - 1] : Math.floor(rand() * n);
      if (o.skip > 0 && rand() < o.skip) {
        paths[base + i] = e;
        continue;
      }
      const ret = rets[k] - o.friction * (friction[k] ?? 0);
      e = Math.max(0, e * (1 + ret));
      if (ret < 0) {
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      } else streak = 0;
      if (e > peak) peak = e;
      const dd = peak > 0 ? (peak - e) / peak : 1;
      if (dd > mdd) mdd = dd;
      paths[base + i] = e;
    }
    finals[r] = e;
    dds[r] = mdd;
    streaks[r] = maxStreak;
    if (e > 1) profit++;
    o.ruinLevels.forEach((lv, li) => {
      if (mdd >= lv) ruinHits[li]++;
    });
  }
  const col = new Float64Array(runs);
  const bands = { p5: new Float64Array(H + 1), p25: new Float64Array(H + 1), p50: new Float64Array(H + 1), p75: new Float64Array(H + 1), p95: new Float64Array(H + 1) };
  for (let i = 0; i <= H; i++) {
    for (let r = 0; r < runs; r++) col[r] = paths[r * (H + 1) + i];
    col.sort();
    bands.p5[i] = quantileSorted(col, 0.05);
    bands.p25[i] = quantileSorted(col, 0.25);
    bands.p50[i] = quantileSorted(col, 0.5);
    bands.p75[i] = quantileSorted(col, 0.75);
    bands.p95[i] = quantileSorted(col, 0.95);
  }
  const fs = Float64Array.from(finals).sort();
  const ds = Float64Array.from(dds).sort();
  const ss = Float64Array.from(streaks).sort();
  return {
    runs, horizon: H, mode: o.mode, bands,
    final: { p5: quantileSorted(fs, 0.05), p25: quantileSorted(fs, 0.25), p50: quantileSorted(fs, 0.5), p75: quantileSorted(fs, 0.75), p95: quantileSorted(fs, 0.95), mean: fs.reduce((a, b) => a + b, 0) / runs },
    profitProb: profit / runs,
    dd: { p50: quantileSorted(ds, 0.5), p75: quantileSorted(ds, 0.75), p95: quantileSorted(ds, 0.95), p99: quantileSorted(ds, 0.99), mean: ds.reduce((a, b) => a + b, 0) / runs, max: ds[ds.length - 1] },
    ddHist: histogram(ds),
    ruin: o.ruinLevels.map((level, i) => ({ level, prob: ruinHits[i] / runs })),
    lossStreak: { p50: quantileSorted(ss, 0.5), p95: quantileSorted(ss, 0.95) },
  };
}

/** Max-drawdown histogram with 2.5 % bins up to the 99th percentile (plus an overflow bin). */
function histogram(sortedDd: Float64Array) {
  const top = Math.max(0.1, quantileSorted(sortedDd, 0.99));
  const w = 0.025;
  const nb = Math.min(24, Math.max(4, Math.ceil(top / w)));
  const bins = Array.from({ length: nb }, (_, i) => ({ lo: i * w, hi: (i + 1) * w, count: 0 }));
  const over = { lo: nb * w, hi: Infinity, count: 0 };
  for (const d of sortedDd) {
    const i = Math.floor(d / w);
    if (i < nb) bins[i].count++;
    else over.count++;
  }
  if (over.count) bins.push(over);
  return bins;
}

/** Probability that a bootstrap path of `horizon` trades suffers a drawdown ≥ level. */
export function ruinProbability(rets: number[], level: number, runs = 500, horizon = 100, seed = 99): number | null {
  const n = rets.length;
  if (n < 5) return null;
  const rand = rng(seed);
  let hits = 0;
  for (let r = 0; r < runs; r++) {
    let e = 1, peak = 1;
    for (let i = 0; i < horizon; i++) {
      e = Math.max(0, e * (1 + rets[Math.floor(rand() * n)]));
      if (e > peak) peak = e;
      if ((peak - e) / peak >= level) {
        hits++;
        break;
      }
    }
  }
  return hits / runs;
}

// ---- position sizing -------------------------------------------------------------

export interface RiskRow {
  risk: number; // fraction of equity risked per trade (1 R)
  medianReturn: number;
  p5Return: number;
  p95Return: number;
  medianDD: number;
  p95DD: number;
  probDD20: number;
  probRuin: number; // drawdown ≥ 50 %
}

/**
 * Re-runs the trade sequence at different risk-per-trade levels. `units` are
 * per-trade results in risk units (R, or average-loss units) so a value of
 * −1 loses exactly the chosen risk.
 */
export function riskSizing(units: number[], risks: number[], runs = 1000, horizon = 100, seed = 11): RiskRow[] {
  const n = units.length;
  if (n < 5) return [];
  return risks.map((risk, ri) => {
    const rand = rng(seed + ri);
    const fin = new Float64Array(runs), dds = new Float64Array(runs);
    let p20 = 0, ruin = 0;
    for (let r = 0; r < runs; r++) {
      let e = 1, peak = 1, mdd = 0;
      for (let i = 0; i < horizon; i++) {
        e = Math.max(0, e * (1 + units[Math.floor(rand() * n)] * risk));
        if (e > peak) peak = e;
        const dd = (peak - e) / peak;
        if (dd > mdd) mdd = dd;
      }
      fin[r] = e - 1;
      dds[r] = mdd;
      if (mdd >= 0.2) p20++;
      if (mdd >= 0.5) ruin++;
    }
    fin.sort();
    dds.sort();
    return {
      risk, medianReturn: quantileSorted(fin, 0.5), p5Return: quantileSorted(fin, 0.05), p95Return: quantileSorted(fin, 0.95),
      medianDD: quantileSorted(dds, 0.5), p95DD: quantileSorted(dds, 0.95), probDD20: p20 / runs, probRuin: ruin / runs,
    };
  });
}

// ---- prop-firm evaluation ------------------------------------------------------------

export interface PropRules {
  profitTarget: number; // fraction, e.g. 0.10
  maxDailyLoss: number; // fraction of the starting balance, 0 = none
  maxTotalLoss: number; // fraction of the starting balance
  minTradingDays: number;
  trailingDrawdown: boolean;
}

export interface PropResult {
  runs: number;
  maxDays: number;
  pass: number;
  failDaily: number;
  failTotal: number;
  unfinished: number;
  medianDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
}

/**
 * Simulates a funded-account evaluation day by day. Each simulated day draws
 * its number of trades from the strategy's real trades-per-day distribution
 * (zero-trade days included) and each trade from the strategy's results.
 */
export function propFirmSim(rets: number[], dayCounts: number[], rules: PropRules, runs = 2000, maxDays = 60, seed = 21): PropResult | null {
  const n = rets.length;
  if (n < 5 || !dayCounts.length) return null;
  const rand = rng(seed);
  let pass = 0, failD = 0, failT = 0;
  const passDays: number[] = [];
  for (let r = 0; r < runs; r++) {
    let b = 1, hw = 1, tradingDays = 0, outcome: 'pass' | 'daily' | 'total' | null = null;
    for (let d = 1; d <= maxDays && !outcome; d++) {
      const c = dayCounts[Math.floor(rand() * dayCounts.length)];
      const dayStart = b;
      if (c > 0) tradingDays++;
      for (let j = 0; j < c; j++) {
        b = Math.max(0, b * (1 + rets[Math.floor(rand() * n)]));
        if (b > hw) hw = b;
        if (rules.maxDailyLoss > 0 && dayStart - b >= rules.maxDailyLoss - 1e-12) {
          outcome = 'daily';
          break;
        }
        const floor = rules.trailingDrawdown ? Math.min(hw, 1 + rules.maxTotalLoss) - rules.maxTotalLoss : 1 - rules.maxTotalLoss;
        if (rules.maxTotalLoss > 0 && b <= floor + 1e-12) {
          outcome = 'total';
          break;
        }
      }
      if (!outcome && rules.profitTarget > 0 && b >= 1 + rules.profitTarget && tradingDays >= rules.minTradingDays) {
        outcome = 'pass';
        passDays.push(d);
      }
    }
    if (outcome === 'pass') pass++;
    else if (outcome === 'daily') failD++;
    else if (outcome === 'total') failT++;
  }
  const pd = Float64Array.from(passDays).sort();
  return {
    runs, maxDays,
    pass: pass / runs, failDaily: failD / runs, failTotal: failT / runs, unfinished: (runs - pass - failD - failT) / runs,
    medianDays: pd.length ? quantileSorted(pd, 0.5) : null, p25Days: pd.length ? quantileSorted(pd, 0.25) : null, p75Days: pd.length ? quantileSorted(pd, 0.75) : null,
  };
}
