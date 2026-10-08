import type { OffsetFn } from '../core/tz';
import { rng } from '../data/synthetic';
import { PRESETS } from '../engine/rules';
import { kurtosis, linreg, mean, median, normCdf, normInv, quantileSorted, skewness, std, tCdf, variance } from './math';
import { propFirmSim, ruinProbability } from './montecarlo';
import type { TradeRecord } from './records';
import { TRENDS, TREND_LABEL, VOLS, VOL_LABEL, type Trend, type Vol } from './regime';
import { scoreReport, type ScoreResult } from './score';

/** A record placed on the report's reference account. */
export interface ReportTrade extends TradeRecord {
  idx: number;
  /** result in risk units (R, or average-loss units) */
  u: number;
  /** one friction unit expressed in the same risk units */
  fu: number;
  eqBefore: number;
  pnlRef: number;
}

export interface GroupStats {
  key: string;
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  sumPct: number;
  exp: number | null;
  avgR: number | null;
  pf: number;
}

export interface Report {
  n: number;
  unit: 'R' | 'ALU';
  unitLabel: string;
  initial: number;
  final: number;
  netPnl: number;
  returnPct: number;
  start: number;
  end: number;
  spanDays: number;
  cagr: number | null;
  cagrReliable: boolean;
  trades: ReportTrade[];
  equity: { t: number[]; v: number[] };
  ddPath: number[]; // drawdown fraction (≤ 0) at each equity point
  daily: { t: number[]; ret: number[]; equity: number[]; count: number[]; ppy: number };
  localDays: { key: string; pnl: number; n: number }[];
  months: { key: string; ret: number; pnl: number; trades: number }[];
  core: CoreStats;
  ratios: { sharpe: number | null; sortino: number | null; calmar: number | null; martin: number | null; gainToPain: number | null; r2: number | null; slope: number };
  risk: {
    maxDD: number; maxDDAbs: number; maxDDDays: number; underwaterPct: number; ulcer: number | null;
    varU: number | null; cvarU: number | null; varPct: number | null; cvarPct: number | null; varDay: number | null; cvarDay: number | null;
    worstTradePct: number; worstDayPct: number | null; maxLossStreak: number; expectedMaxLossStreak: number | null;
  };
  consistency: {
    monthsCount: number; monthsTraded: number; greenMonthsPct: number | null; avgMonth: number | null; bestMonth: number | null; worstMonth: number | null;
    worstVsAvg: number | null; rolling: { x: number[]; y: number[]; window: number }; half1: GroupStats | null; half2: GroupStats | null;
  };
  significance: {
    n: number; mean: number; sd: number; tStat: number | null; pValue: number | null; ciLow: number | null; ciHigh: number | null;
    sr: number | null; skew: number; kurt: number; psr: number | null; minTrl: number | null; tradesNeeded: number | null; dsr: number | null; trials: number;
  };
  regimes: {
    trend: GroupStats[]; vol: GroupStats[]; matrix: Record<Trend, Record<Vol, GroupStats | null>>;
    taggedPct: number; testedTrend: number; losingTrend: number; testedVol: number; losingVol: number;
  };
  robustness: {
    friction: { k: number; exp: number; pf: number; netPct: number }[];
    breakEvenFriction: number | null;
    outlier: { removed: number; exp: number; netPct: number; pf: number; share: number | null } | null;
    capture: number | null;
    slUsage: number;
    riskCV: number | null;
    medianRiskPct: number | null;
  };
  ruin30: number | null;
  propPass: number | null;
  synthetic: 'none' | 'some' | 'all' | 'unknown';
  score: ScoreResult;
}

export interface CoreStats {
  trades: number; wins: number; losses: number; breakeven: number; winRate: number;
  netPnl: number; grossProfit: number; grossLoss: number; commission: number; profitFactor: number;
  expectancy: number; expectancyU: number; avgWin: number; avgLoss: number; payoff: number; largestWin: number; largestLoss: number;
  avgR: number | null; totalR: number | null; avgWinR: number | null; avgLossR: number | null; sqn: number | null; kellyPct: number;
  maxWinStreak: number; maxLossStreak: number; currentStreak: number;
  avgHoldSec: number; avgHoldWinSec: number; avgHoldLossSec: number;
  longs: number; shorts: number; longWinRate: number; shortWinRate: number;
  avgMaeR: number | null; avgMfeR: number | null; edgeRatio: number | null; tpHitRate: number; slHitRate: number;
  bestDay: number; worstDay: number; profitableDaysPct: number; avgTradesPerDay: number; recoveryFactor: number;
}

export interface ReportOptions {
  initial: number;
  /** offset used for calendar days / months (the scope's chart timezone) */
  off: OffsetFn;
  /** per-trade Sharpe ratios of every backtest run, for the deflated Sharpe ratio */
  trialsSR?: number[];
}

const pf = (pos: number, neg: number) => (neg ? pos / neg : pos ? Infinity : 0);

export function groupStats(trades: ReportTrade[], key: string, label = key): GroupStats {
  let wins = 0, gp = 0, gl = 0, sumPct = 0, su = 0;
  const rs: number[] = [];
  for (const t of trades) {
    if (t.pnlRef > 0) {
      wins++;
      gp += t.pnlRef;
    } else if (t.pnlRef < 0) gl -= t.pnlRef;
    sumPct += t.pct;
    su += t.u;
    if (t.r != null) rs.push(t.r);
  }
  const n = trades.length;
  return { key, label, trades: n, wins, winRate: n ? wins / n : 0, pnl: gp - gl, sumPct, exp: n ? su / n : null, avgR: rs.length ? mean(rs) : null, pf: pf(gp, gl) };
}

export function groupBy(trades: ReportTrade[], keyFn: (t: ReportTrade) => string | string[], order?: string[], labels?: Record<string, string>): GroupStats[] {
  const map = new Map<string, ReportTrade[]>();
  for (const t of trades) {
    const ks = keyFn(t);
    for (const k of Array.isArray(ks) ? ks : [ks]) {
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
  }
  const keys = order ? order.filter((k) => map.has(k)) : [...map.keys()].sort();
  if (order) for (const k of map.keys()) if (!order.includes(k)) keys.push(k);
  return keys.map((k) => groupStats(map.get(k)!, k, labels?.[k] ?? k));
}

const dowUtc = (day: number) => (((day + 4) % 7) + 7) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
const pad = (n: number) => String(n).padStart(2, '0');
function localKey(t: number, off: OffsetFn, len: 7 | 10) {
  const d = new Date((t + off(t)) * 1000);
  const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return s.slice(0, len);
}

export function buildReport(records: TradeRecord[], opts: ReportOptions): Report | null {
  const recs = [...records].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
  const n = recs.length;
  if (!n) return null;
  const initial = opts.initial > 0 ? opts.initial : 10000;

  // --- risk units ---------------------------------------------------------------
  const riskPcts = recs.map((r) => r.riskPct).filter((x): x is number => x != null && x > 0);
  const medRisk = riskPcts.length ? median(riskPcts) : null;
  const rCount = recs.filter((r) => r.r != null).length;
  const unit: 'R' | 'ALU' = medRisk && rCount >= 0.8 * n ? 'R' : 'ALU';
  const lossPcts = recs.filter((r) => r.pct < 0).map((r) => -r.pct);
  const alu = (lossPcts.length ? mean(lossPcts) : mean(recs.map((r) => Math.abs(r.pct)))) || 0.01;

  // --- reference equity path ------------------------------------------------------
  const trades: ReportTrade[] = [];
  let e = initial;
  const eqT = [recs[0].entryTime], eqV = [initial];
  recs.forEach((r, idx) => {
    const u = unit === 'R' ? (r.r ?? r.pct / medRisk!) : r.pct / alu;
    const fu = unit === 'R' ? (r.frictionR ?? r.frictionPct / medRisk!) : r.frictionPct / alu;
    const pnlRef = e > 0 ? e * r.pct : 0;
    trades.push({ ...r, idx, u, fu, eqBefore: e, pnlRef });
    e = Math.max(0, e + pnlRef);
    eqT.push(r.exitTime);
    eqV.push(e);
  });
  const final = e;
  const start = recs.reduce((m, r) => Math.min(m, r.entryTime), Infinity);
  const end = recs[n - 1].exitTime;
  const spanDays = Math.max(1, (end - start) / 86400);
  const cagr = final > 0 ? Math.pow(final / initial, 365 / spanDays) - 1 : -1;

  // --- drawdown on the trade-level path --------------------------------------------
  let peak = initial, peakT = eqT[0], maxDD = 0, maxDDAbs = 0, maxDur = 0, inDD = false;
  const ddPath: number[] = [];
  for (let i = 0; i < eqV.length; i++) {
    const v = eqV[i], t = eqT[i];
    if (v >= peak) {
      if (inDD) maxDur = Math.max(maxDur, t - peakT);
      inDD = false;
      peak = v;
      peakT = t;
      ddPath.push(0);
    } else {
      inDD = true;
      const dd = peak > 0 ? (peak - v) / peak : 1;
      ddPath.push(-dd);
      if (dd > maxDD) maxDD = dd;
      if (peak - v > maxDDAbs) maxDDAbs = peak - v;
    }
  }
  if (inDD) maxDur = Math.max(maxDur, end - peakT);

  // --- daily series (UTC, weekend P&L folded into Fri/Mon for 5-day markets) -----------
  const day = (t: number) => Math.floor(t / 86400);
  const satShare = recs.filter((r) => dowUtc(day(r.exitTime)) === 6).length / n;
  const allDays = satShare >= 0.05;
  const mapDay = (d: number) => {
    if (allDays) return d;
    const w = dowUtc(d);
    return w === 6 ? d - 1 : w === 0 ? d + 1 : d;
  };
  const pnlByDay = new Map<number, number>(), cntByDay = new Map<number, number>();
  for (const t of trades) {
    const d = mapDay(day(t.exitTime));
    pnlByDay.set(d, (pnlByDay.get(d) ?? 0) + t.pnlRef);
    cntByDay.set(d, (cntByDay.get(d) ?? 0) + 1);
  }
  const daily = { t: [] as number[], ret: [] as number[], equity: [] as number[], count: [] as number[], ppy: allDays ? 365 : 252 };
  {
    let E = initial;
    const d0 = mapDay(day(start)), d1 = mapDay(day(end));
    for (let d = d0; d <= d1; d++) {
      const w = dowUtc(d);
      if (!allDays && (w === 0 || w === 6)) continue;
      const E0 = E;
      E += pnlByDay.get(d) ?? 0;
      daily.t.push(d * 86400);
      daily.ret.push(E0 > 0 ? E / E0 - 1 : 0);
      daily.equity.push(E);
      daily.count.push(cntByDay.get(d) ?? 0);
    }
  }

  // --- ratios --------------------------------------------------------------------
  let sharpe: number | null = null, sortino: number | null = null, ulcer: number | null = null, r2: number | null = null, slope = 0;
  const dr = daily.ret;
  if (dr.length >= 20) {
    const m = mean(dr), s = std(dr);
    sharpe = s > 0 ? (m / s) * Math.sqrt(daily.ppy) : null;
    const down = Math.sqrt(mean(dr.map((x) => Math.min(0, x) ** 2)));
    sortino = down > 0 ? (m / down) * Math.sqrt(daily.ppy) : m > 0 ? Infinity : null;
  }
  let underwater = 0;
  if (daily.equity.length) {
    let pk = initial, sq = 0;
    for (const v of daily.equity) {
      pk = Math.max(pk, v);
      const ddp = pk > 0 ? ((v - pk) / pk) * 100 : 0;
      sq += ddp * ddp;
      if (v < pk) underwater++;
    }
    ulcer = Math.sqrt(sq / daily.equity.length);
    if (daily.equity.length >= 20 && daily.equity.every((v) => v > 0)) {
      const lr = linreg([Math.log(initial), ...daily.equity.map((v) => Math.log(v))]);
      slope = lr.slope;
      r2 = lr.slope > 0 ? lr.r2 : 0;
    }
  }
  const cagrReliable = spanDays >= 60 && final > 0;

  // --- months (scope timezone) -----------------------------------------------------
  const months: Report['months'] = [];
  {
    const byMonth = new Map<string, { pnl: number; trades: number }>();
    for (const t of trades) {
      const k = localKey(t.exitTime, opts.off, 7);
      const x = byMonth.get(k) ?? { pnl: 0, trades: 0 };
      x.pnl += t.pnlRef;
      x.trades++;
      byMonth.set(k, x);
    }
    const first = localKey(start, opts.off, 7), last = localKey(end, opts.off, 7);
    let [y, mo] = first.split('-').map(Number);
    let E = initial;
    for (let guard = 0; guard < 1200; guard++) {
      const k = `${y}-${pad(mo)}`;
      const x = byMonth.get(k) ?? { pnl: 0, trades: 0 };
      months.push({ key: k, pnl: x.pnl, trades: x.trades, ret: E > 0 ? x.pnl / E : 0 });
      E += x.pnl;
      if (k >= last) break;
      mo++;
      if (mo > 12) (mo = 1), y++;
    }
  }
  const traded = months.filter((m) => m.trades > 0);
  const monthRets = months.map((m) => m.ret);
  const avgMonth = months.length ? mean(monthRets) : null;
  const worstMonth = months.length ? Math.min(...monthRets) : null;
  const bestMonth = months.length ? Math.max(...monthRets) : null;
  const worstVsAvg = worstMonth == null || avgMonth == null ? null : worstMonth >= 0 ? 0 : avgMonth > 0 ? -worstMonth / avgMonth : Infinity;
  const negMonths = monthRets.filter((x) => x < 0);
  const gainToPain = months.length ? (negMonths.length ? monthRets.reduce((a, b) => a + b, 0) / -negMonths.reduce((a, b) => a + b, 0) : monthRets.some((x) => x > 0) ? Infinity : null) : null;
  const calmar = !cagrReliable ? null : maxDD > 0 ? cagr / maxDD : cagr > 0 ? Infinity : null;
  const martin = cagrReliable && ulcer && ulcer > 0 ? (cagr * 100) / ulcer : null;

  // --- local calendar days ------------------------------------------------------------
  const ld = new Map<string, { pnl: number; n: number }>();
  for (const t of trades) {
    const k = localKey(t.exitTime, opts.off, 10);
    const x = ld.get(k) ?? { pnl: 0, n: 0 };
    x.pnl += t.pnlRef;
    x.n++;
    ld.set(k, x);
  }
  const localDays = [...ld.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ key, ...v }));

  // --- core stats -------------------------------------------------------------------
  const core = coreStats(trades, initial, final, maxDDAbs, localDays);

  // --- consistency extras -------------------------------------------------------------
  const rolling = { x: [] as number[], y: [] as number[], window: 0 };
  if (n >= 20) {
    const w = n >= 120 ? 30 : Math.max(10, Math.floor(n / 4));
    rolling.window = w;
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += trades[i].u;
      if (i >= w) s -= trades[i - w].u;
      if (i >= w - 1) {
        rolling.x.push(i + 1);
        rolling.y.push(s / w);
      }
    }
  }
  const half = Math.floor(n / 2);
  const half1 = n >= 10 ? groupStats(trades.slice(0, half), 'h1', 'First half') : null;
  const half2 = n >= 10 ? groupStats(trades.slice(half), 'h2', 'Second half') : null;

  // --- significance -------------------------------------------------------------------
  const u = trades.map((t) => t.u);
  const mu = mean(u), sd = std(u);
  const tStat = n >= 2 && sd > 0 ? mu / (sd / Math.sqrt(n)) : null;
  const pValue = tStat != null ? 1 - tCdf(tStat, n - 1) : null;
  let ciLow: number | null = null, ciHigh: number | null = null;
  if (n >= 10) {
    const B = n > 2000 ? 1000 : 2000;
    const rand = rng(1234);
    const means = new Float64Array(B);
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += u[Math.floor(rand() * n)];
      means[b] = s / n;
    }
    means.sort();
    ciLow = quantileSorted(means, 0.025);
    ciHigh = quantileSorted(means, 0.975);
  }
  const sr = sd > 0 ? mu / sd : null;
  const skew = skewness(u), kurt = kurtosis(u);
  const denom = sr != null ? Math.max(1e-9, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr) : 1;
  const psr = sr != null && n >= 10 ? normCdf((sr * Math.sqrt(n - 1)) / Math.sqrt(denom)) : null;
  const minTrl = sr != null && sr > 0 ? 1 + denom * (1.6449 / sr) ** 2 : null;
  const tradesNeeded = minTrl != null ? Math.max(0, Math.ceil(minTrl - n)) : null;
  let dsr: number | null = null;
  const trials = opts.trialsSR?.filter((x) => isFinite(x)) ?? [];
  if (n >= 10 && trials.length >= 2) {
    // deflated Sharpe on per-trade % returns, the same measure used for every trial
    const px = trades.map((t) => t.pct), sp = std(px);
    if (sp > 0) {
      const srp = mean(px) / sp, sk = skewness(px), ku = kurtosis(px);
      const N = trials.length, g = 0.5772156649;
      const sr0 = Math.sqrt(variance(trials)) * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E)));
      const den = Math.max(1e-9, 1 - sk * srp + ((ku - 1) / 4) * srp * srp);
      dsr = normCdf(((srp - sr0) * Math.sqrt(n - 1)) / Math.sqrt(den));
    }
  }

  // --- tail risk ---------------------------------------------------------------------
  const su = Float64Array.from(u).sort();
  const spct = Float64Array.from(trades.map((t) => t.pct)).sort();
  const tailMean = (s: Float64Array, v: number) => {
    let a = 0, c = 0;
    for (const x of s) if (x <= v) (a += x), c++;
    return c ? a / c : v;
  };
  const varU = n >= 20 ? quantileSorted(su, 0.05) : null;
  const varPct = n >= 20 ? quantileSorted(spct, 0.05) : null;
  const sdr = Float64Array.from(dr).sort();
  const varDay = dr.length >= 40 ? quantileSorted(sdr, 0.05) : null;
  const lossQ = core.losses / n;
  const expectedMaxLossStreak = lossQ > 0 && lossQ < 1 && n * (1 - lossQ) > 1 ? Math.log(n * (1 - lossQ)) / Math.log(1 / lossQ) : null;

  // --- regimes -----------------------------------------------------------------------
  const tagged = trades.filter((t) => t.trend != null && t.vol != null);
  const trendG = TRENDS.map((k) => groupStats(tagged.filter((t) => t.trend === k), k, TREND_LABEL[k]));
  const volG = VOLS.map((k) => groupStats(tagged.filter((t) => t.vol === k), k, VOL_LABEL[k]));
  const matrix = {} as Record<Trend, Record<Vol, GroupStats | null>>;
  for (const tr of TRENDS) {
    matrix[tr] = {} as Record<Vol, GroupStats | null>;
    for (const vo of VOLS) {
      const g = tagged.filter((t) => t.trend === tr && t.vol === vo);
      matrix[tr][vo] = g.length ? groupStats(g, `${tr}-${vo}`) : null;
    }
  }
  const tested = (gs: GroupStats[]) => gs.filter((g) => g.trades >= 5);

  // --- robustness ---------------------------------------------------------------------
  const friction = [0, 1, 2].map((k) => {
    let gp = 0, gl = 0, comp = 1, su2 = 0;
    for (const t of trades) {
      const x = t.pct - k * t.frictionPct;
      if (x > 0) gp += x;
      else gl -= x;
      comp *= 1 + x;
      su2 += t.u - k * t.fu;
    }
    return { k, exp: su2 / n, pf: pf(gp, gl), netPct: comp - 1 };
  });
  const sumPct = trades.reduce((a, t) => a + t.pct, 0), sumF = trades.reduce((a, t) => a + t.frictionPct, 0);
  const breakEvenFriction = sumF > 0 ? Math.max(0, sumPct / sumF) : null;
  let outlier: Report['robustness']['outlier'] = null;
  if (n >= 20) {
    const m = Math.max(1, Math.ceil(0.05 * n));
    const rest = [...trades].sort((a, b) => b.pct - a.pct).slice(m);
    let gp = 0, gl = 0, comp = 1;
    for (const t of rest) {
      if (t.pct > 0) gp += t.pct;
      else gl -= t.pct;
      comp *= 1 + t.pct;
    }
    const exp = mean(rest.map((t) => t.u));
    outlier = { removed: m, exp, netPct: comp - 1, pf: pf(gp, gl), share: mu > 0 ? exp / mu : null };
  }
  const caps = trades.filter((t) => t.r != null && t.r > 0 && t.mfeR != null && t.mfeR > 0).map((t) => Math.min(1, t.r! / t.mfeR!));
  const riskCV = riskPcts.length >= 10 && mean(riskPcts) > 0 ? std(riskPcts) / mean(riskPcts) : null;

  // --- simulations used by the score & badges ------------------------------------------
  const pcts = trades.map((t) => t.pct);
  const ruin30 = ruinProbability(pcts, 0.3, 500, Math.max(n, 100), 99);
  const ftmo = PRESETS[0];
  const prop = propFirmSim(u.map((x) => x * 0.01), daily.count.length ? daily.count : [1], {
    profitTarget: ftmo.profitTarget / 100, maxDailyLoss: ftmo.maxDailyLoss / 100, maxTotalLoss: ftmo.maxTotalLoss / 100,
    minTradingDays: ftmo.minTradingDays, trailingDrawdown: ftmo.trailingDrawdown,
  }, 500, 60, 21);

  const synth = recs.map((r) => r.synthetic);
  const synthetic: Report['synthetic'] = synth.every((x) => x === true) ? 'all' : synth.some((x) => x === true) ? 'some' : synth.some((x) => x === null) ? 'unknown' : 'none';

  const rep: Omit<Report, 'score'> = {
    n, unit, unitLabel: unit === 'R' ? 'R' : 'ALU', initial, final, netPnl: final - initial, returnPct: final / initial - 1,
    start, end, spanDays, cagr: final > 0 ? cagr : null, cagrReliable,
    trades, equity: { t: eqT, v: eqV }, ddPath, daily, localDays, months, core,
    ratios: { sharpe, sortino, calmar, martin, gainToPain, r2, slope },
    risk: {
      maxDD, maxDDAbs, maxDDDays: maxDur / 86400, underwaterPct: daily.equity.length ? underwater / daily.equity.length : 0, ulcer,
      varU, cvarU: varU != null ? tailMean(su, varU) : null, varPct, cvarPct: varPct != null ? tailMean(spct, varPct) : null,
      varDay, cvarDay: varDay != null ? tailMean(sdr, varDay) : null,
      worstTradePct: spct[0], worstDayPct: dr.length ? sdr[0] : null, maxLossStreak: core.maxLossStreak, expectedMaxLossStreak,
    },
    consistency: {
      monthsCount: months.length, monthsTraded: traded.length, greenMonthsPct: traded.length ? traded.filter((m) => m.ret > 0).length / traded.length : null,
      avgMonth, bestMonth, worstMonth, worstVsAvg, rolling, half1, half2,
    },
    significance: { n, mean: mu, sd, tStat, pValue, ciLow, ciHigh, sr, skew, kurt, psr, minTrl, tradesNeeded, dsr, trials: trials.length },
    regimes: {
      trend: trendG, vol: volG, matrix, taggedPct: tagged.length / n,
      testedTrend: tested(trendG).length, losingTrend: tested(trendG).filter((g) => (g.exp ?? 0) < 0).length,
      testedVol: tested(volG).length, losingVol: tested(volG).filter((g) => (g.exp ?? 0) < 0).length,
    },
    robustness: {
      friction, breakEvenFriction, outlier, capture: caps.length >= 5 ? mean(caps) : null,
      slUsage: recs.filter((r) => r.hasSL).length / n, riskCV, medianRiskPct: medRisk,
    },
    ruin30, propPass: prop ? prop.pass : null, synthetic,
  };
  return { ...rep, score: scoreReport(rep) };
}

function coreStats(T: ReportTrade[], initial: number, final: number, maxDDAbs: number, localDays: { pnl: number }[]): CoreStats {
  const n = T.length;
  const wins = T.filter((t) => t.pnlRef > 0), losses = T.filter((t) => t.pnlRef < 0);
  const gp = wins.reduce((a, t) => a + t.pnlRef, 0), gl = -losses.reduce((a, t) => a + t.pnlRef, 0);
  const net = final - initial;
  const Rs = T.filter((t) => t.r != null).map((t) => t.r!);
  const winR = T.filter((t) => t.r != null && t.pnlRef > 0).map((t) => t.r!);
  const lossR = T.filter((t) => t.r != null && t.pnlRef < 0).map((t) => t.r!);
  let ws = 0, ls = 0, mws = 0, mls = 0;
  for (const t of T) {
    if (t.pnlRef > 0) (ws++, (ls = 0));
    else if (t.pnlRef < 0) (ls++, (ws = 0));
    else (ws = 0), (ls = 0);
    mws = Math.max(mws, ws);
    mls = Math.max(mls, ls);
  }
  let cur = 0;
  for (let i = n - 1; i >= 0; i--) {
    const s = Math.sign(T[i].pnlRef);
    if (s === 0) break;
    if (cur === 0 || Math.sign(cur) === s) cur += s;
    else break;
  }
  const winRate = n ? wins.length / n : 0;
  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = losses.length ? -gl / losses.length : 0;
  const payoff = avgLoss ? avgWin / -avgLoss : wins.length ? Infinity : 0;
  const maes = T.filter((t) => t.maeR != null).map((t) => t.maeR!);
  const mfes = T.filter((t) => t.mfeR != null).map((t) => t.mfeR!);
  const longs = T.filter((t) => t.side === 'long'), shorts = T.filter((t) => t.side === 'short');
  const wr = (a: ReportTrade[]) => (a.length ? a.filter((t) => t.pnlRef > 0).length / a.length : 0);
  const dayVals = localDays.map((d) => d.pnl);
  return {
    trades: n, wins: wins.length, losses: losses.length, breakeven: n - wins.length - losses.length, winRate,
    netPnl: net, grossProfit: gp, grossLoss: gl, commission: T.reduce((a, t) => a + t.commissionPct * t.eqBefore, 0), profitFactor: pf(gp, gl),
    expectancy: n ? net / n : 0, expectancyU: n ? mean(T.map((t) => t.u)) : 0,
    avgWin, avgLoss, payoff,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnlRef)) : 0, largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnlRef)) : 0,
    avgR: Rs.length ? mean(Rs) : null, totalR: Rs.length ? Rs.reduce((a, b) => a + b, 0) : null,
    avgWinR: winR.length ? mean(winR) : null, avgLossR: lossR.length ? mean(lossR) : null,
    sqn: Rs.length > 1 && std(Rs) ? (mean(Rs) / std(Rs)) * Math.sqrt(Math.min(Rs.length, 100)) : null,
    kellyPct: payoff && isFinite(payoff) ? Math.max(0, winRate - (1 - winRate) / payoff) : 0,
    maxWinStreak: mws, maxLossStreak: mls, currentStreak: cur,
    avgHoldSec: mean(T.map((t) => t.holdSec)), avgHoldWinSec: mean(wins.map((t) => t.holdSec)), avgHoldLossSec: mean(losses.map((t) => t.holdSec)),
    longs: longs.length, shorts: shorts.length, longWinRate: wr(longs), shortWinRate: wr(shorts),
    avgMaeR: maes.length ? mean(maes) : null, avgMfeR: mfes.length ? mean(mfes) : null, edgeRatio: maes.length && mean(maes) ? mean(mfes) / mean(maes) : null,
    tpHitRate: n ? T.filter((t) => t.exitReason === 'tp').length / n : 0, slHitRate: n ? T.filter((t) => t.exitReason === 'sl').length / n : 0,
    bestDay: dayVals.length ? Math.max(...dayVals) : 0, worstDay: dayVals.length ? Math.min(...dayVals) : 0,
    profitableDaysPct: dayVals.length ? dayVals.filter((x) => x > 0).length / dayVals.length : 0,
    avgTradesPerDay: localDays.length ? n / localDays.length : 0,
    recoveryFactor: maxDDAbs ? net / maxDDAbs : net > 0 ? Infinity : 0,
  };
}

/** Per-trade Sharpe of a set of records (used to count "trials" for the deflated Sharpe ratio). */
export function perTradeSharpe(records: TradeRecord[]): number | null {
  if (records.length < 10) return null;
  const x = records.map((r) => r.pct);
  const s = std(x);
  return s > 0 ? mean(x) / s : null;
}
