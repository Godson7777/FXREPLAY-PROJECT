import type { Trade } from '../engine/broker';

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  commission: number;
  returnPct: number;
  profitFactor: number;
  expectancy: number; // $ per trade
  expectancyR: number | null;
  avgWin: number;
  avgLoss: number;
  payoff: number; // avgWin / |avgLoss|
  largestWin: number;
  largestLoss: number;
  avgR: number | null;
  totalR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  maxDD: number;
  maxDDPct: number;
  maxDDDurationSec: number;
  recoveryFactor: number;
  sharpe: number; // per-trade, annualised by trade frequency
  sortino: number;
  sqn: number | null;
  kellyPct: number;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number;
  avgHoldSec: number;
  avgHoldWinSec: number;
  avgHoldLossSec: number;
  longs: number;
  shorts: number;
  longWinRate: number;
  shortWinRate: number;
  avgMaeR: number | null;
  avgMfeR: number | null;
  edgeRatio: number | null; // avg MFE / avg MAE
  tpHitRate: number;
  slHitRate: number;
  bestDay: number;
  worstDay: number;
  profitableDaysPct: number;
  avgTradesPerDay: number;
  finalBalance: number;
  initialBalance: number;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export function computeStats(trades: Trade[], initialBalance: number): Stats {
  const T = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const pnl = T.map((t) => t.pnl);
  const wins = T.filter((t) => t.pnl > 0);
  const losses = T.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const netPnl = grossProfit - grossLoss;
  const Rs = T.filter((t) => t.r != null).map((t) => t.r!);
  const winR = T.filter((t) => t.r != null && t.pnl > 0).map((t) => t.r!);
  const lossR = T.filter((t) => t.r != null && t.pnl < 0).map((t) => t.r!);

  // equity & drawdown (trade-by-trade on closed balance)
  let bal = initialBalance, peak = initialBalance, peakT = T[0]?.entryTime ?? 0;
  let maxDD = 0, maxDDPct = 0, maxDur = 0;
  const rets: number[] = [];
  for (const t of T) {
    const before = bal;
    bal += t.pnl;
    rets.push(before > 0 ? t.pnl / before : 0);
    if (bal > peak) {
      maxDur = Math.max(maxDur, t.exitTime - peakT);
      peak = bal;
      peakT = t.exitTime;
    }
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd / peak > maxDDPct) maxDDPct = dd / peak;
  }
  if (T.length) maxDur = Math.max(maxDur, T[T.length - 1].exitTime - peakT);

  // streaks
  let ws = 0, ls = 0, mws = 0, mls = 0;
  for (const t of T) {
    if (t.pnl > 0) (ws++, (ls = 0));
    else if (t.pnl < 0) (ls++, (ws = 0));
    mws = Math.max(mws, ws);
    mls = Math.max(mls, ls);
  }

  // per-day (by exit date, UTC)
  const days = new Map<number, number>();
  for (const t of T) {
    const d = Math.floor(t.exitTime / 86400);
    days.set(d, (days.get(d) || 0) + t.pnl);
  }
  const dayVals = [...days.values()];
  const spanDays = T.length ? Math.max(1, (T[T.length - 1].exitTime - T[0].entryTime) / 86400) : 1;
  const tradesPerYear = (T.length / spanDays) * 252;

  const sd = std(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)));
  const m = mean(rets);
  const winRate = T.length ? wins.length / T.length : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const payoff = avgLoss ? avgWin / -avgLoss : wins.length ? Infinity : 0;
  const maes = T.filter((t) => t.maeR != null).map((t) => t.maeR!);
  const mfes = T.filter((t) => t.mfeR != null).map((t) => t.mfeR!);
  const longs = T.filter((t) => t.side === 'long');
  const shorts = T.filter((t) => t.side === 'short');
  const wr = (a: Trade[]) => (a.length ? a.filter((t) => t.pnl > 0).length / a.length : 0);
  const last = T[T.length - 1];
  let cur = 0;
  for (let i = T.length - 1; i >= 0; i--) {
    const s = Math.sign(T[i].pnl);
    if (s === 0) break;
    if (cur === 0 || Math.sign(cur) === s) cur += s;
    else break;
  }

  return {
    trades: T.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: T.length - wins.length - losses.length,
    winRate,
    netPnl,
    grossProfit,
    grossLoss,
    commission: T.reduce((a, t) => a + t.commission, 0),
    returnPct: initialBalance ? netPnl / initialBalance : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    expectancy: mean(pnl),
    expectancyR: Rs.length ? mean(Rs) : null,
    avgWin,
    avgLoss,
    payoff,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
    avgR: Rs.length ? mean(Rs) : null,
    totalR: Rs.length ? Rs.reduce((a, b) => a + b, 0) : null,
    avgWinR: winR.length ? mean(winR) : null,
    avgLossR: lossR.length ? mean(lossR) : null,
    maxDD,
    maxDDPct,
    maxDDDurationSec: maxDur,
    recoveryFactor: maxDD ? netPnl / maxDD : netPnl > 0 ? Infinity : 0,
    sharpe: sd ? (m / sd) * Math.sqrt(Math.max(1, tradesPerYear)) : 0,
    sortino: downside ? (m / downside) * Math.sqrt(Math.max(1, tradesPerYear)) : 0,
    sqn: Rs.length > 1 && std(Rs) ? (mean(Rs) / std(Rs)) * Math.sqrt(Math.min(Rs.length, 100)) : null,
    kellyPct: payoff && isFinite(payoff) ? Math.max(0, winRate - (1 - winRate) / payoff) : 0,
    maxWinStreak: mws,
    maxLossStreak: mls,
    currentStreak: cur,
    avgHoldSec: mean(T.map((t) => t.holdSec)),
    avgHoldWinSec: mean(wins.map((t) => t.holdSec)),
    avgHoldLossSec: mean(losses.map((t) => t.holdSec)),
    longs: longs.length,
    shorts: shorts.length,
    longWinRate: wr(longs),
    shortWinRate: wr(shorts),
    avgMaeR: maes.length ? mean(maes) : null,
    avgMfeR: mfes.length ? mean(mfes) : null,
    edgeRatio: maes.length && mean(maes) ? mean(mfes) / mean(maes) : null,
    tpHitRate: T.length ? T.filter((t) => t.exitReason === 'tp').length / T.length : 0,
    slHitRate: T.length ? T.filter((t) => t.exitReason === 'sl').length / T.length : 0,
    bestDay: dayVals.length ? Math.max(...dayVals) : 0,
    worstDay: dayVals.length ? Math.min(...dayVals) : 0,
    profitableDaysPct: dayVals.length ? dayVals.filter((x) => x > 0).length / dayVals.length : 0,
    avgTradesPerDay: days.size ? T.length / days.size : 0,
    finalBalance: last ? initialBalance + netPnl : initialBalance,
    initialBalance,
  };
}

// ---- breakdowns -------------------------------------------------------------

export interface Group {
  key: string;
  trades: number;
  wins: number;
  pnl: number;
  winRate: number;
  avgR: number | null;
  pf: number;
}

export function groupBy<T extends Trade>(trades: T[], keyFn: (t: T) => string | string[], order?: string[]): Group[] {
  const map = new Map<string, T[]>();
  for (const t of trades) {
    const ks = keyFn(t);
    for (const k of Array.isArray(ks) ? ks : [ks]) {
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
  }
  const keys = order ? order.filter((k) => map.has(k)) : [...map.keys()].sort();
  if (order) for (const k of map.keys()) if (!order.includes(k)) keys.push(k);
  return keys.map((key) => {
    const a = map.get(key)!;
    const w = a.filter((t) => t.pnl > 0);
    const gp = w.reduce((s, t) => s + t.pnl, 0);
    const gl = -a.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const rs = a.filter((t) => t.r != null).map((t) => t.r!);
    return {
      key, trades: a.length, wins: w.length, pnl: gp - gl, winRate: w.length / a.length,
      avgR: rs.length ? mean(rs) : null, pf: gl ? gp / gl : gp ? Infinity : 0,
    };
  });
}

export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Trading session by entry hour (UTC). Overlap gets its own bucket. */
export function sessionOf(utc: number): string {
  const h = new Date(utc * 1000).getUTCHours();
  if (h >= 12 && h < 16) return 'London/NY overlap';
  if (h >= 7 && h < 12) return 'London';
  if (h >= 16 && h < 21) return 'New York';
  if (h >= 21 || h < 1) return 'Sydney';
  return 'Asia';
}
export const SESSIONS = ['Sydney', 'Asia', 'London', 'London/NY overlap', 'New York'];

export function holdBucket(sec: number): string {
  if (sec < 15 * 60) return '<15m';
  if (sec < 3600) return '15m–1h';
  if (sec < 4 * 3600) return '1–4h';
  if (sec < 86400) return '4–24h';
  if (sec < 3 * 86400) return '1–3d';
  return '>3d';
}
export const HOLD_BUCKETS = ['<15m', '15m–1h', '1–4h', '4–24h', '1–3d', '>3d'];

/** R-multiple histogram with 0.5R bins, clamped to [-3, +6]. */
export function rHistogram(trades: { r: number | null }[]) {
  const bins: { lo: number; hi: number; count: number }[] = [];
  for (let x = -3; x < 6; x += 0.5) bins.push({ lo: x, hi: x + 0.5, count: 0 });
  for (const t of trades) {
    if (t.r == null) continue;
    const r = Math.max(-2.999, Math.min(5.999, t.r));
    const i = Math.floor((r + 3) / 0.5);
    bins[i].count++;
  }
  return bins;
}
