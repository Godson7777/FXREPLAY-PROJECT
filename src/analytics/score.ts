import { lerpAnchors, mean } from './math';
import type { GroupStats, Report } from './report';
import { TREND_LABEL, type Trend } from './regime';

/**
 * Overflow Score — one number (0–100) summarising whether a backtest shows a
 * real, durable edge. Seven pillars, each built from metrics mapped to points
 * with fixed anchors, then hard caps for known failure modes. This file is the
 * single source of truth: the Methodology page renders straight from it.
 */

type R = Omit<Report, 'score'>;
type Anchors = readonly (readonly [number, number])[];

export interface MetricDef {
  id: string;
  label: string;
  weight: number;
  anchors: Anchors;
  value: (r: R) => number | null;
  fmt: (v: number, r: R) => string;
  anchorFmt: (x: number) => string;
  about: string;
  requires?: string;
}

export interface PillarDef {
  id: string;
  label: string;
  weight: number;
  question: string;
  metrics: MetricDef[];
}

export interface GateDef {
  id: string;
  label: string;
  cap: number;
  rule: string;
  test: (r: R) => boolean;
  detail: (r: R) => string;
}

export interface MetricScore {
  id: string;
  label: string;
  value: number | null;
  display: string;
  points: number | null;
  weight: number;
}
export interface PillarScore {
  id: string;
  label: string;
  weight: number;
  question: string;
  points: number | null;
  metrics: MetricScore[];
}
export interface GateResult {
  id: string;
  label: string;
  cap: number;
  hit: boolean;
  detail: string;
}
export type TierId = 'allweather' | 'robust' | 'promising' | 'fragile' | 'unproven' | 'noedge' | 'insufficient';
export interface ScoreResult {
  score: number | null;
  raw: number | null;
  tier: TierId;
  grade: string;
  label: string;
  verdict: string;
  worthIt: string;
  allWeather: boolean;
  pillars: PillarScore[];
  gates: GateResult[];
  strengths: string[];
  suggestions: string[];
}

// ---- formatting (kept local so the engine has no UI dependency) ----------------------
const pc = (x: number, d = 1) => `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%`;
const sg = (x: number, d = 2) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const fx = (x: number, d = 2) => (isFinite(x) ? x.toFixed(d) : x > 0 ? '∞' : '—');
const un = (r: R) => r.unitLabel;

export const REGIME_ANCHORS: Anchors = [[-0.2, 0], [0, 40], [0.1, 65], [0.25, 85], [0.4, 100]];

/** 0–100: rewards every tested regime being profitable and penalises the weakest one. */
export function regimeIndex(groups: GroupStats[]): number | null {
  const t = groups.filter((g) => g.trades >= 5);
  if (!t.length) return null;
  const s = t.map((g) => lerpAnchors(g.exp ?? 0, REGIME_ANCHORS)!);
  let v = 0.5 * mean(s) + 0.5 * Math.min(...s);
  if (t.length === 2) v *= 0.85;
  else if (t.length === 1) v = Math.min(v, 40);
  return v;
}

/** 0–1: 1 = both halves of the test equally profitable, 0 = both losing. */
export function halvesIndex(r: R): number | null {
  const a = r.consistency.half1?.exp, b = r.consistency.half2?.exp;
  if (r.n < 20 || a == null || b == null) return null;
  if (a > 0 && b > 0) return 0.6 + (0.4 * Math.min(a, b)) / Math.max(a, b);
  return a > 0 || b > 0 ? 0.15 : 0;
}

const regimeDisplay = (gs: GroupStats[]) => {
  const t = gs.filter((g) => g.trades >= 5);
  if (!t.length) return 'not enough tagged trades';
  return `${t.filter((g) => (g.exp ?? 0) > 0).length} of ${t.length} profitable`;
};

export const PILLARS: PillarDef[] = [
  {
    id: 'profit', label: 'Profitability', weight: 15, question: 'Does it make money, and how much per unit of risk?',
    metrics: [
      { id: 'expectancy', label: 'Expectancy per trade', weight: 0.4, anchors: [[0, 0], [0.05, 25], [0.1, 45], [0.2, 65], [0.3, 80], [0.5, 95], [0.8, 100]],
        value: (r) => r.significance.mean, fmt: (v, r) => `${sg(v)} ${un(r)}`, anchorFmt: (x) => `${x.toFixed(2)} R`,
        about: 'Average result per trade in risk units: R is the amount risked at the initial stop (when most trades have no stop, the average loss is used instead — "ALU"). It is what one more trade is worth.' },
      { id: 'profitFactor', label: 'Profit factor', weight: 0.35, anchors: [[1, 0], [1.1, 20], [1.25, 45], [1.5, 70], [2, 88], [3, 100]],
        value: (r) => r.core.profitFactor, fmt: (v) => fx(v), anchorFmt: (x) => x.toFixed(2),
        about: 'Gross profit divided by gross loss. Below 1 the strategy loses money; 1.5+ is healthy; above 3 is rare outside small samples.' },
      { id: 'cagr', label: 'Annualized return (CAGR)', weight: 0.25, anchors: [[0, 0], [0.05, 30], [0.1, 50], [0.2, 70], [0.4, 88], [0.8, 100]],
        value: (r) => (r.cagrReliable ? r.cagr : null), fmt: (v) => pc(v), anchorFmt: (x) => pc(x, 0), requires: 'at least 60 days of trading',
        about: 'Compound annual growth of the account at the risk you actually used.' },
    ],
  },
  {
    id: 'riskAdj', label: 'Risk-adjusted return', weight: 15, question: 'Is the return worth the swings it takes to get there?',
    metrics: [
      { id: 'sharpe', label: 'Sharpe ratio (annualized)', weight: 0.4, anchors: [[0, 0], [0.5, 25], [1, 55], [1.5, 75], [2, 88], [3, 100]],
        value: (r) => r.ratios.sharpe, fmt: (v) => fx(v), anchorFmt: (x) => x.toFixed(1), requires: 'at least 20 trading days',
        about: 'Average daily return divided by its volatility, annualized. Above 1 is good, above 2 is excellent for a single strategy.' },
      { id: 'sortino', label: 'Sortino ratio (annualized)', weight: 0.3, anchors: [[0, 0], [0.75, 30], [1.5, 60], [2.5, 82], [4, 100]],
        value: (r) => r.ratios.sortino, fmt: (v) => fx(v), anchorFmt: (x) => x.toFixed(2), requires: 'at least 20 trading days',
        about: 'Like Sharpe, but only downside volatility counts — big up days are not penalised.' },
      { id: 'calmar', label: 'Calmar ratio', weight: 0.3, anchors: [[0, 0], [0.5, 35], [1, 60], [2, 82], [3, 95], [5, 100]],
        value: (r) => r.ratios.calmar, fmt: (v) => fx(v), anchorFmt: (x) => x.toFixed(1), requires: 'at least 60 days of trading',
        about: 'Annual return divided by the maximum drawdown: how many "worst drawdowns" the strategy earns back per year.' },
    ],
  },
  {
    id: 'drawdown', label: 'Drawdown & tail risk', weight: 15, question: 'How much pain on the way, and how bad are the worst cases?',
    metrics: [
      { id: 'maxDD', label: 'Maximum drawdown', weight: 0.35, anchors: [[0, 100], [0.05, 92], [0.1, 78], [0.15, 62], [0.2, 48], [0.3, 20], [0.4, 0]],
        value: (r) => r.risk.maxDD, fmt: (v) => pc(-v), anchorFmt: (x) => pc(-x, 0),
        about: 'Largest peak-to-trough fall of the closed-trade equity. Most traders abandon a method somewhere past −20%.' },
      { id: 'ulcer', label: 'Ulcer index', weight: 0.2, anchors: [[0, 100], [2, 85], [5, 60], [10, 30], [15, 0]],
        value: (r) => r.risk.ulcer, fmt: (v) => v.toFixed(2), anchorFmt: (x) => x.toFixed(0),
        about: 'Depth and duration of drawdowns combined (root-mean-square of daily drawdown %). Long, deep slumps score badly even if the max drawdown is modest.' },
      { id: 'cvar', label: 'CVaR 95% per trade', weight: 0.2, anchors: [[-0.05, 0], [-0.03, 30], [-0.02, 55], [-0.01, 85], [-0.005, 100]],
        value: (r) => r.risk.cvarPct, fmt: (v) => pc(v, 2), anchorFmt: (x) => pc(x, 1), requires: 'at least 20 trades',
        about: 'Average loss on the worst 5% of trades, as % of equity. Shows how bad the bad trades really are (gaps, missed stops, oversized risk).' },
      { id: 'ruin', label: 'Probability of a 30% drawdown', weight: 0.25, anchors: [[0, 100], [0.01, 88], [0.05, 65], [0.1, 45], [0.2, 20], [0.35, 0]],
        value: (r) => r.ruin30, fmt: (v) => pc(v), anchorFmt: (x) => pc(x, 0),
        about: 'Monte Carlo estimate: the chance that the next 100+ trades, resampled from this record, produce a 30% drawdown.' },
    ],
  },
  {
    id: 'consistency', label: 'Consistency', weight: 15, question: 'Does it earn steadily, month after month?',
    metrics: [
      { id: 'greenMonths', label: 'Profitable months', weight: 0.25, anchors: [[0.35, 0], [0.5, 35], [0.6, 60], [0.7, 80], [0.85, 100]],
        value: (r) => (r.consistency.monthsCount >= 3 ? r.consistency.greenMonthsPct : null), fmt: (v) => pc(v, 0), anchorFmt: (x) => pc(x, 0), requires: 'at least 3 months',
        about: 'Share of traded months that ended positive.' },
      { id: 'worstVsAvg', label: 'Worst month vs average month', weight: 0.3, anchors: [[0.5, 100], [1, 65], [1.5, 35], [2, 15], [3, 0]],
        value: (r) => (r.consistency.monthsCount >= 3 ? r.consistency.worstVsAvg : null),
        fmt: (v) => (v === 0 ? 'no losing month' : isFinite(v) ? `${v.toFixed(2)}×` : 'average month ≤ 0'), anchorFmt: (x) => `${x.toFixed(1)}×`, requires: 'at least 3 months',
        about: 'Loss of the worst month divided by the average monthly return. The rule: one bad month should never cost more than an average month earns (≤ 1×).' },
      { id: 'r2', label: 'Equity smoothness (R²)', weight: 0.2, anchors: [[0.5, 0], [0.7, 40], [0.85, 70], [0.93, 88], [0.98, 100]],
        value: (r) => r.ratios.r2, fmt: (v) => v.toFixed(3), anchorFmt: (x) => x.toFixed(2), requires: 'at least 20 trading days',
        about: 'How closely the (log) equity curve follows a straight rising line. 1 = perfectly steady growth; a falling curve scores 0.' },
      { id: 'halves', label: 'Stability across the test', weight: 0.25, anchors: [[0, 0], [0.15, 15], [0.6, 60], [1, 100]],
        value: halvesIndex, fmt: (_v, r) => `1st half ${sg(r.consistency.half1?.exp ?? 0)} · 2nd half ${sg(r.consistency.half2?.exp ?? 0)} ${un(r)}`,
        anchorFmt: (x) => x.toFixed(2), requires: 'at least 20 trades',
        about: 'Expectancy of the first half of the trades vs the second half. An edge that only exists in one half is likely luck or a market phase that ended.' },
    ],
  },
  {
    id: 'regimes', label: 'Market regimes', weight: 15, question: 'Does it hold up in trending, ranging, calm and volatile markets?',
    metrics: [
      { id: 'trendRegimes', label: 'Trend regimes (up, down, ranging)', weight: 0.6, anchors: [[0, 0], [100, 100]],
        value: (r) => regimeIndex(r.regimes.trend), fmt: (_v, r) => regimeDisplay(r.regimes.trend), anchorFmt: (x) => x.toFixed(0), requires: 'at least 5 trades in a regime',
        about: 'Each trade is tagged with the 4-hour trend at entry (ADX ≥ 20 = trending, direction from +DI/−DI). Points come from the expectancy in every regime, half from the average and half from the weakest one; covering fewer regimes is penalised.' },
      { id: 'volRegimes', label: 'Volatility regimes (low, normal, high)', weight: 0.4, anchors: [[0, 0], [100, 100]],
        value: (r) => regimeIndex(r.regimes.vol), fmt: (_v, r) => regimeDisplay(r.regimes.vol), anchorFmt: (x) => x.toFixed(0), requires: 'at least 5 trades in a regime',
        about: 'Same idea for volatility: 4-hour ATR ranked against the previous 500 four-hour bars (bottom third = low, top third = high).' },
    ],
  },
  {
    id: 'confidence', label: 'Statistical confidence', weight: 15, question: 'Is the edge real, or could it be luck?',
    metrics: [
      { id: 'sampleSize', label: 'Number of trades', weight: 0.2, anchors: [[0, 0], [30, 35], [50, 50], [100, 70], [200, 87], [400, 100]],
        value: (r) => r.n, fmt: (v) => String(v), anchorFmt: (x) => x.toFixed(0),
        about: 'More trades = less room for luck. Below 30 almost anything can happen by chance.' },
      { id: 'pValue', label: 'p-value of the edge', weight: 0.2, anchors: [[0.001, 100], [0.01, 90], [0.05, 70], [0.1, 50], [0.25, 25], [0.5, 0]],
        value: (r) => r.significance.pValue, fmt: (v) => (v < 0.001 ? '< 0.001' : v.toFixed(3)), anchorFmt: (x) => String(x),
        about: 'One-sided t-test: the probability of seeing an average this good if the true edge were zero. Below 0.05 is the classic significance line.' },
      { id: 'psr', label: 'Probabilistic Sharpe ratio', weight: 0.2, anchors: [[0.5, 0], [0.75, 35], [0.9, 60], [0.95, 78], [0.99, 95], [0.999, 100]],
        value: (r) => r.significance.psr, fmt: (v) => pc(v, 1), anchorFmt: (x) => pc(x, 1),
        about: 'Probability that the true Sharpe ratio is above zero, accounting for sample size, skew and fat tails (Bailey & López de Prado).' },
      { id: 'ciLow', label: 'Lower bound of the 95% confidence interval', weight: 0.2, anchors: [[-0.2, 0], [0, 50], [0.05, 68], [0.1, 82], [0.2, 100]],
        value: (r) => r.significance.ciLow, fmt: (v, r) => `${sg(v)} ${un(r)}`, anchorFmt: (x) => `${x.toFixed(2)} R`, requires: 'at least 10 trades',
        about: 'Bootstrap (2,000 resamples) of the expectancy. If even the pessimistic end of the interval is above zero, the edge is unlikely to be luck.' },
      { id: 'outlier', label: 'Edge without the top 5% of trades', weight: 0.2, anchors: [[0, 0], [0.3, 40], [0.5, 65], [0.7, 85], [0.85, 100]],
        value: (r) => (r.robustness.outlier ? (r.significance.mean > 0 ? Math.max(0, r.robustness.outlier.share ?? 0) : 0) : null),
        fmt: (v) => `${pc(v, 0)} of the edge remains`, anchorFmt: (x) => pc(x, 0), requires: 'at least 20 trades',
        about: 'Removes the best 5% of trades and re-measures expectancy. An edge that vanishes depends on rare windfalls you may never see again.' },
    ],
  },
  {
    id: 'execution', label: 'Execution & discipline', weight: 10, question: 'Will it survive real-world costs, and is risk controlled?',
    metrics: [
      { id: 'friction', label: 'Cost headroom', weight: 0.4, anchors: [[0, 0], [0.5, 25], [1, 45], [2, 70], [4, 88], [8, 100]],
        value: (r) => r.robustness.breakEvenFriction, fmt: (v) => `${v.toFixed(1)} cost units per trade`, anchorFmt: (x) => `${x} units`,
        about: 'How much extra slippage and spread per trade the strategy can absorb before its profit is gone, in cost units: 1 unit = 1 pip, or 0.01% of the price when that is larger (about $0.20 on gold at $2,000).' },
      { id: 'slUsage', label: 'Trades with a stop loss', weight: 0.3, anchors: [[0.5, 0], [0.75, 45], [0.9, 75], [0.98, 95], [1, 100]],
        value: (r) => r.robustness.slUsage, fmt: (v) => pc(v, 0), anchorFmt: (x) => pc(x, 0),
        about: 'Defined risk on every trade is what makes results repeatable and R statistics meaningful.' },
      { id: 'riskCV', label: 'Risk consistency', weight: 0.3, anchors: [[0.1, 100], [0.2, 85], [0.35, 65], [0.6, 35], [1, 0]],
        value: (r) => r.robustness.riskCV, fmt: (v) => `CV ${v.toFixed(2)}`, anchorFmt: (x) => x.toFixed(2), requires: 'at least 10 trades with a stop',
        about: 'Coefficient of variation of the % risked per trade. Low = disciplined, consistent sizing.' },
    ],
  },
];

export const GATES: GateDef[] = [
  { id: 'sample', label: 'Fewer than 30 trades', cap: 49, rule: 'n < 30',
    test: (r) => r.n < 30, detail: (r) => `${r.n} trades is too small a sample to trust.` },
  { id: 'expectancy', label: 'No positive expectancy', cap: 34, rule: 'expectancy ≤ 0',
    test: (r) => r.significance.mean <= 0, detail: (r) => `Average trade ${sg(r.significance.mean)} ${un(r)}.` },
  { id: 'drawdown', label: 'Drawdown deeper than 30%', cap: 49, rule: 'max drawdown > 30%',
    test: (r) => r.risk.maxDD > 0.3, detail: (r) => `Max drawdown ${pc(-r.risk.maxDD)}.` },
  { id: 'outliers', label: 'Edge depends on a few trades', cap: 59, rule: 'expectancy ≤ 0 without the best 5% of trades',
    test: (r) => r.robustness.outlier != null && r.significance.mean > 0 && r.robustness.outlier.exp <= 0,
    detail: (r) => `Without the best ${r.robustness.outlier?.removed} trades, expectancy is ${sg(r.robustness.outlier?.exp ?? 0)} ${un(r)}.` },
  { id: 'regimes', label: 'Loses in most market regimes', cap: 64, rule: 'losing in 2+ of the tested trend regimes',
    test: (r) => r.regimes.testedTrend >= 2 && r.regimes.losingTrend >= 2,
    detail: (r) => `Losing in ${r.regimes.losingTrend} of ${r.regimes.testedTrend} trend regimes.` },
  { id: 'monthly', label: 'Worst month lost more than an average month earns', cap: 69, rule: 'worst monthly loss > average monthly return',
    test: (r) => r.consistency.monthsCount >= 3 && (r.consistency.worstMonth ?? 0) < 0 && (r.consistency.worstVsAvg ?? 0) > 1,
    detail: (r) => `Worst month ${pc(r.consistency.worstMonth ?? 0)} vs average month ${pc(r.consistency.avgMonth ?? 0, 2)}.` },
  { id: 'period', label: 'Tested for less than 3 months', cap: 69, rule: 'test period < 90 days',
    test: (r) => r.spanDays < 90, detail: (r) => `Test covers ${Math.round(r.spanDays)} days.` },
];

export const TIERS: { id: TierId; min: number; grade: string; label: string; meaning: string }[] = [
  { id: 'allweather', min: 80, grade: 'A+', label: 'All-weather edge', meaning: 'Profitable in every tested regime, shallow drawdowns, steady months, statistically significant. Worth trading long-term.' },
  { id: 'robust', min: 70, grade: 'A', label: 'Robust edge', meaning: 'Strong and consistent with minor weaknesses. Suitable for long-term use with normal risk.' },
  { id: 'promising', min: 60, grade: 'B', label: 'Promising', meaning: 'Positive edge, not yet proven. Keep testing before trading it with size.' },
  { id: 'fragile', min: 50, grade: 'C', label: 'Fragile', meaning: 'Profitable on paper but sensitive to conditions, costs or a few trades.' },
  { id: 'unproven', min: 35, grade: 'D', label: 'Unproven', meaning: 'Not enough evidence of an edge yet.' },
  { id: 'noedge', min: 0, grade: 'F', label: 'No edge', meaning: 'Consistent with random trading or a negative expectancy.' },
];

export const MIN_TRADES_FOR_SCORE = 10;

export function scoreReport(r: R): ScoreResult {
  const pillars: PillarScore[] = PILLARS.map((p) => {
    const metrics = p.metrics.map((m) => {
      let v: number | null = null;
      try {
        v = m.value(r);
      } catch {
        v = null;
      }
      if (v != null && Number.isNaN(v)) v = null;
      return { id: m.id, label: m.label, value: v, display: v == null ? '—' : m.fmt(v, r), points: lerpAnchors(v, m.anchors), weight: m.weight };
    });
    const live = metrics.filter((m) => m.points != null);
    const w = live.reduce((a, m) => a + m.weight, 0);
    return { id: p.id, label: p.label, weight: p.weight, question: p.question, metrics, points: w ? live.reduce((a, m) => a + m.weight * m.points!, 0) / w : null };
  });
  const gates = GATES.map((g) => ({ id: g.id, label: g.label, cap: g.cap, hit: safe(() => g.test(r)), detail: safe(() => g.detail(r), '') as string }));
  const hit = gates.filter((g) => g.hit);

  if (r.n < MIN_TRADES_FOR_SCORE) {
    return {
      score: null, raw: null, tier: 'insufficient', grade: '—', label: 'Not enough trades',
      verdict: `Close at least ${MIN_TRADES_FOR_SCORE} trades to get a score (${r.n} so far). Around 30 trades the numbers start to mean something; 100+ is solid.`,
      worthIt: 'Too early to tell', allWeather: false, pillars, gates, strengths: [], suggestions: suggestions(r, pillars).slice(0, 3),
    };
  }
  const live = pillars.filter((p) => p.points != null);
  const W = live.reduce((a, p) => a + p.weight, 0);
  const raw = W ? live.reduce((a, p) => a + p.weight * p.points!, 0) / W : 0;
  const cap = hit.length ? Math.min(...hit.map((g) => g.cap)) : 100;
  const score = Math.round(Math.max(0, Math.min(raw, cap)));
  // all-weather = profitable when the market trends AND when it ranges, in every tested
  // volatility regime, and no month lost more than an average month earns
  const aw = allWeatherCheck(r);
  const allWeather = score >= 80 && aw.ok;
  let tier = TIERS.find((t) => score >= t.min)!;
  if (tier.id === 'allweather' && !allWeather) tier = TIERS[1];

  const weak = live.filter((p) => p.points! < 70).sort((a, b) => a.points! - b.points!).slice(0, 2).map((p) => p.label.toLowerCase());
  const weakTxt = weak.length ? weak.join(' and ') : 'consistency over a longer period';
  // a gate only "caps" the score when it actually lowered it; otherwise it is a warning flag
  const binding = hit.filter((g) => g.cap < raw).sort((a, b) => a.cap - b.cap);
  const flags = hit.filter((g) => g.cap >= raw);
  const capTxt =
    (binding.length ? ` Capped at ${cap} because: ${binding.map((g) => g.label.toLowerCase()).join('; ')}.` : '') +
    (flags.length ? ` ${binding.length ? 'Also flagged' : 'Flagged'}: ${flags.map((g) => g.label.toLowerCase()).join('; ')}.` : '');
  const dd = r.risk.maxDD;
  const ddTxt = dd <= 0.15 ? `kept drawdowns shallow (max ${pc(-dd)})` : `had drawdowns of up to ${pc(-dd)} (size down if that is too deep for you)`;
  const worst = r.consistency.worstMonth;
  const monthTxt = worst == null ? '' : worst >= 0 ? ' It had no losing month.' : ' Its worst month lost less than an average month earns.';
  const p = r.significance.pValue;
  const pTxt = p == null ? '' : p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
  const sigTxt = p == null ? '' : p < 0.05 ? ` The edge is statistically significant (${pTxt}).` : ` Statistical significance is not established yet (${pTxt}).`;
  const verdicts: Record<string, string> = {
    allweather: `All-weather edge. It made money across the trend and volatility regimes it was tested in and ${ddTxt}.${monthTxt}${sigTxt}`,
    robust: `Robust edge. Strong and consistent overall; the main thing to watch is ${weakTxt}.${score >= 80 && !aw.ok ? ` Not rated all-weather yet: ${aw.missing.join('; ')}.` : ''}`,
    promising: `Promising, not yet proven. The edge is positive, but ${weakTxt} ${weak.length > 1 ? 'hold' : 'holds'} it back.`,
    fragile: `Fragile. It is profitable on paper but sensitive to ${weakTxt}.`,
    unproven: 'Unproven. There is not enough evidence of a durable edge yet.',
    noedge: 'No edge. The results are consistent with random trading or a negative expectancy.',
  };
  const worth: Record<string, string> = {
    allweather: 'Yes — worth trading long-term', robust: 'Yes, with monitoring', promising: 'Not yet — keep testing', fragile: 'No — fix the weak spots first', unproven: 'No — not enough evidence', noedge: 'No',
  };
  const strengths = live
    .filter((p) => p.points! >= 80)
    .sort((a, b) => b.points! - a.points!)
    .slice(0, 3)
    .map((p) => {
      const best = [...p.metrics].filter((m) => m.points != null).sort((a, b) => b.points! - a.points!)[0];
      return `${p.label} (${Math.round(p.points!)}/100) — ${best.label}: ${best.display}`;
    });
  return {
    score, raw, tier: tier.id, grade: tier.grade, label: tier.label, verdict: verdicts[tier.id] + capTxt, worthIt: worth[tier.id], allWeather,
    pillars, gates, strengths, suggestions: suggestions(r, pillars).slice(0, 5),
  };
}

/** The conditions behind the all-weather label, with what is still missing. */
export function allWeatherCheck(r: R): { ok: boolean; missing: string[] } {
  const g = (k: Trend) => r.regimes.trend.find((x) => x.key === k && x.trades >= 5);
  const won = (x: GroupStats | undefined) => x != null && (x.exp ?? 0) > 0;
  const missing: string[] = [];
  if (!won(g('range'))) missing.push(g('range') ? 'it does not make money in ranging markets' : 'it has not been tested enough in ranging markets (5+ trades)');
  if (!won(g('up')) && !won(g('down'))) missing.push(g('up') || g('down') ? 'it does not make money in trending markets' : 'it has not been tested enough in trending markets (5+ trades)');
  if (r.regimes.losingTrend > 0 && won(g('range')) && (won(g('up')) || won(g('down')))) missing.push('it loses in one trend direction');
  if (r.regimes.losingVol > 0) missing.push('it loses in at least one volatility regime');
  const pv = r.significance.pValue;
  if (pv == null || pv >= 0.05) missing.push(`the edge is not statistically significant yet (${pv == null ? 'not enough data' : `p = ${pv.toFixed(3)}`})`);
  if (r.risk.maxDD > 0.2) missing.push(`its drawdown (${pc(-r.risk.maxDD)}) is too deep — lower the risk per trade`);
  const c = r.consistency;
  if (c.monthsCount < 3) missing.push('it needs at least 3 months of results');
  else if ((c.worstMonth ?? 0) < 0 && (c.worstVsAvg ?? Infinity) > 1) missing.push('its worst month lost more than an average month earns');
  return { ok: !missing.length, missing };
}

function safe<T>(f: () => T, d: T = false as unknown as T): T {
  try {
    return f();
  } catch {
    return d;
  }
}

const FILTERS: Record<Trend, (side: 'long' | 'short' | null) => string> = {
  range: () => 'skip trades when the 4-hour ADX is below 20',
  up: (side) => (side === 'short' ? 'avoid shorts while the 4-hour trend is up' : 'review long entries while the 4-hour trend is up — late entries into extended moves are a common cause'),
  down: (side) => (side === 'long' ? 'avoid longs while the 4-hour trend is down' : 'review short entries while the 4-hour trend is down'),
};

/** Concrete, prioritised advice derived from the report. */
export function suggestions(r: R, pillars: PillarScore[]): string[] {
  const out: { p: number; s: string }[] = [];
  const add = (p: number, s: string) => out.push({ p, s });
  const u = un(r);
  const sig = r.significance;
  if (sig.mean <= 0 && r.n >= 10)
    add(100, `The strategy loses ${Math.abs(sig.mean).toFixed(2)} ${u} per trade on average. Revisit the entry rules first — position sizing cannot fix a negative expectancy.`);
  if (r.n < 50) add(90, `Take at least ${50 - r.n} more trades. Below about 50 trades, luck dominates the result.`);
  if (r.spanDays < 90) add(85, `Extend the test to at least 3 months (now ${Math.round(r.spanDays)} days) so it covers different market conditions.`);
  if (sig.mean > 0 && sig.pValue != null && sig.pValue > 0.05)
    add(80, `The edge is not yet statistically significant (p = ${sig.pValue.toFixed(3)}).${sig.tradesNeeded ? ` At the current Sharpe, about ${sig.tradesNeeded} more trades are needed for 95% confidence.` : ''}`);
  // only flag regimes whose loss is meaningful, not noise around zero
  const meaningful = (g: GroupStats) => g.trades >= 5 && (g.exp ?? 0) < 0 && ((g.exp ?? 0) <= -0.05 || sig.mean - (g.exp ?? 0) >= 0.15);
  for (const g of r.regimes.trend) {
    if (!meaningful(g)) continue;
    const inReg = r.trades.filter((t) => t.trend === g.key);
    const sideExp = (s: 'long' | 'short') => {
      const x = inReg.filter((t) => t.side === s);
      return x.length >= 3 ? mean(x.map((t) => t.u)) : null;
    };
    const L = sideExp('long'), S = sideExp('short');
    const worse = L != null && S != null ? (L < S ? 'long' : 'short') : L != null && L < 0 ? 'long' : S != null && S < 0 ? 'short' : null;
    add(75, `It loses in ${TREND_LABEL[g.key as Trend].toLowerCase()} markets (${sg(g.exp ?? 0)} ${u} per trade over ${g.trades} trades). Consider a filter: ${FILTERS[g.key as Trend](worse)}.`);
  }
  for (const g of r.regimes.vol) {
    if (!meaningful(g)) continue;
    if (g.key === 'high') add(70, `Losses cluster in high-volatility conditions (${sg(g.exp ?? 0)} ${u} per trade). Reduce size or skip trades when the 4-hour ATR is in the top third of its recent range.`);
    if (g.key === 'low') add(65, `It struggles in quiet markets (${sg(g.exp ?? 0)} ${u} per trade). Targets may be too far for low volatility — consider skipping trades when the 4-hour ATR is in the bottom third.`);
    if (g.key === 'normal' && sig.mean > 0) add(60, `It loses in normal volatility (${sg(g.exp ?? 0)} ${u} per trade), so the profit relies on unusual conditions. Check whether the edge is really repeatable.`);
  }
  if (r.regimes.testedTrend < 2 && r.n >= 20) add(62, `So far the trades cover only ${r.regimes.testedTrend} trend regime${r.regimes.testedTrend === 1 ? '' : 's'}. Test periods with different market conditions before trusting the score.`);
  const c = r.consistency;
  if (c.monthsCount >= 3 && (c.avgMonth ?? 0) > 0 && (c.worstMonth ?? 0) < 0 && (c.worstVsAvg ?? 0) > 1)
    add(72, `Your worst month lost ${pc(c.worstMonth ?? 0)}, more than an average month makes (${pc(c.avgMonth ?? 0, 2)}). A monthly loss limit — for example, stop for the month at ${pc(-(Math.max(0, c.avgMonth ?? 0)), 1)} — keeps one bad month from erasing several good ones.`);
  if (r.risk.maxDD > 0.2) add(68, `Drawdowns are deep (${pc(-r.risk.maxDD)}). Halving the risk per trade roughly halves the drawdown — compare risk levels in the Monte Carlo position-sizing table.`);
  const o = r.robustness.outlier;
  if (o && sig.mean > 0 && (o.share ?? 0) < 0.5)
    add(66, `Results lean on a few outsized winners: without the best ${o.removed} trades, expectancy falls to ${sg(o.exp)} ${u}. Make sure the setup can repeat those winners.`);
  const be = r.robustness.breakEvenFriction;
  if (be != null && sig.mean > 0 && be < 1.5) add(64, `The edge is thin: an extra cost of about ${be.toFixed(1)} unit${be.toFixed(1) === '1.0' ? '' : 's'} per trade (1 unit = 1 pip, or 0.01% of price if larger) would erase it. Prefer liquid hours, limit entries and wider targets.`);
  if (r.robustness.slUsage < 0.9) add(58, `${pc(1 - r.robustness.slUsage, 0)} of trades had no stop loss. Undefined risk makes results fragile and R statistics incomplete.`);
  if ((r.robustness.riskCV ?? 0) > 0.5) add(55, `Risk per trade varies a lot (CV ${r.robustness.riskCV!.toFixed(2)}). Consistent risk makes results comparable and drawdowns predictable.`);
  if (r.robustness.capture != null && r.robustness.capture < 0.35) add(50, `On winning trades you keep only ${pc(r.robustness.capture, 0)} of the best open profit. Trailing stops or partial take-profits may capture more.`);
  if (sig.mean > 0 && r.ratios.sharpe != null && r.ratios.sharpe < 1) add(45, `Returns are noisy for their size (Sharpe ${r.ratios.sharpe.toFixed(2)}). Fewer, higher-quality setups usually raise the Sharpe ratio.`);
  if (!out.length) {
    const weakest = pillars.filter((p) => p.points != null).sort((a, b) => a.points! - b.points!)[0];
    if (weakest) add(10, `Weakest area: ${weakest.label.toLowerCase()} (${Math.round(weakest.points!)}/100). Keep the rules unchanged and keep collecting trades — consistency over time is what turns a good score into a trusted one.`);
  }
  return out.sort((a, b) => b.p - a.p).map((x) => x.s);
}
