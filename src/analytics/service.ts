import type { Bars, DatasetMeta } from '../core/types';
import { offsetFn } from '../core/tz';
import type { Session } from '../engine/replay';
import type { RegimeTag } from './regime';
import { listDatasets, loadBars } from '../data/store';
import { patchRegimes } from '../data/sessions';
import { strategySessions, type Strategy } from '../data/strategies';
import { buildRecords, ensureRegimes, type TradeRecord } from './records';
import { buildReport, perTradeSharpe, type Report } from './report';
import { regimeSeries, type RegimeSeries } from './regime';

/**
 * The one pipeline every page uses to turn sessions into a report:
 * regime tagging (once per trade) → normalised trade records → report + score.
 */

// ---- regimes ------------------------------------------------------------------------

const seriesCache = new Map<string, { sig: string; rs: RegimeSeries }>();

function seriesFor(symbol: string, b: Bars): RegimeSeries {
  const sig = `${b.n}:${b.t[0]}:${b.t[b.n - 1]}`;
  const hit = seriesCache.get(symbol);
  if (hit && hit.sig === sig) return hit.rs;
  const rs = regimeSeries(b);
  seriesCache.set(symbol, { sig, rs });
  return rs;
}

/** Tags trades with their market regime and saves the tags (derived data only). */
export async function prepareSessions(sessions: Session[]): Promise<void> {
  const changed = await ensureRegimes(sessions, (sym) => loadBars(sym), seriesFor);
  for (const s of changed) {
    const tags = new Map<number, RegimeTag | null>();
    for (const t of s.state.broker.trades) if (t.regime !== undefined) tags.set(t.id, t.regime);
    try {
      await patchRegimes(s.id, tags);
    } catch (e) {
      console.warn('Could not save regime tags', e);
    }
  }
}

export async function datasetMetas(): Promise<Map<string, DatasetMeta>> {
  return new Map((await listDatasets()).map((m) => [m.id, m]));
}

// ---- reports -------------------------------------------------------------------------

const sessionsSig = (sessions: Session[]) =>
  sessions
    .map((s) => {
      const tr = s.state.broker.trades;
      let tagged = 0;
      for (const t of tr) if (t.regime !== undefined) tagged++;
      return `${s.id}:${s.state.updatedAt}:${tr.length}:${tagged}:${s.balance}`;
    })
    .join('|');
const metasSig = (m: Map<string, DatasetMeta>) => [...m.values()].map((d) => `${d.id}:${d.source}:${d.createdAt}`).join(',');

const reportCache = new Map<string, Report | null>();
const trialCache = new Map<string, number[]>();

function remember<T>(cache: Map<string, T>, key: string, value: T, max = 40) {
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value as string);
  return value;
}

/** Per-trade Sharpe of every session with 10+ trades: the "trials" for the deflated Sharpe ratio. */
export function trialSharpes(all: Session[], metas: Map<string, DatasetMeta>): number[] {
  const key = sessionsSig(all) + '#' + metasSig(metas);
  const hit = trialCache.get(key);
  if (hit) return hit;
  const out = all.map((s) => perTradeSharpe(buildRecords([s], metas))).filter((x): x is number => x != null && isFinite(x));
  return remember(trialCache, key, out, 8);
}

export interface ReportFilter {
  key: string;
  test: (r: TradeRecord) => boolean;
}

/** The account a combined report is drawn on: the earliest session's balance and timezone. */
export function referenceSession(sessions: Session[]): Session | null {
  return [...sessions].sort((a, b) => a.start - b.start || a.createdAt - b.createdAt)[0] ?? null;
}

/** Synchronous, cached report for a set of (already prepared) sessions. */
export function reportOf(sessions: Session[], metas: Map<string, DatasetMeta>, trials: number[], filter?: ReportFilter): Report | null {
  const ref = referenceSession(sessions);
  if (!ref) return null;
  const key = `${sessionsSig(sessions)}#${metasSig(metas)}#${trials.length}:${trials.reduce((a, b) => a + b, 0).toFixed(6)}#${filter?.key ?? ''}`;
  if (reportCache.has(key)) return reportCache.get(key)!;
  let recs = buildRecords(sessions, metas);
  if (filter) recs = recs.filter(filter.test);
  const rep = recs.length ? buildReport(recs, { initial: ref.balance, off: offsetFn(ref.timezone), trialsSR: trials }) : null;
  return remember(reportCache, key, rep);
}

/** Full pipeline for a scope: tag regimes, then build the report. */
export async function scopeReport(scope: Session[], all: Session[], filter?: ReportFilter): Promise<Report | null> {
  if (!scope.length) return null;
  await prepareSessions(scope);
  const metas = await datasetMetas();
  return reportOf(scope, metas, trialSharpes(all, metas), filter);
}

/** Reports for several groups of sessions (tagging every session once). */
export async function reportsFor(groups: Session[][], all: Session[]): Promise<(Report | null)[]> {
  const uniq = [...new Set(groups.flat())];
  await prepareSessions(uniq);
  const metas = await datasetMetas();
  const trials = trialSharpes(all, metas);
  return groups.map((g) => (g.length ? reportOf(g, metas, trials) : null));
}

// ---- leaderboard rules -------------------------------------------------------------------

export const RANK_MIN_TRADES = 50;
export const RANK_MIN_DAYS = 90;
export const RANK_RULES = `Published strategies with at least ${RANK_MIN_TRADES} closed trades over at least 3 months (${RANK_MIN_DAYS} days) of real market data are ranked by Overflow Score.`;

export interface Eligibility {
  ranked: boolean;
  reasons: string[];
  trades: number;
  days: number;
}

export function eligibility(st: Strategy | null, r: Report | null): Eligibility {
  const reasons: string[] = [];
  if (st && !st.published) reasons.push('Not published yet — turn on "Publish to leaderboard".');
  if (!r) reasons.push('No closed trades yet.');
  else {
    if (r.n < RANK_MIN_TRADES) reasons.push(`Needs ${RANK_MIN_TRADES - r.n} more closed trade${RANK_MIN_TRADES - r.n === 1 ? '' : 's'} (${r.n} of ${RANK_MIN_TRADES}).`);
    if (r.spanDays < RANK_MIN_DAYS) {
      const left = Math.max(1, Math.ceil(RANK_MIN_DAYS - r.spanDays));
      reasons.push(`Needs ${left} more day${left === 1 ? '' : 's'} of tested history (${Math.floor(r.spanDays)} of ${RANK_MIN_DAYS}).`);
    }
    if (r.synthetic === 'all' || r.synthetic === 'some') reasons.push(`Uses synthetic practice data${r.synthetic === 'some' ? ' for some trades' : ''} — backtest on imported real market data to be ranked.`);
    if (r.synthetic === 'unknown') {
      const missing = [...new Set(r.trades.filter((t) => t.synthetic === null).map((t) => t.symbol))];
      reasons.push(`Market data for ${missing.join(', ')} is not on this device, so it cannot be verified as real data.`);
    }
    if (r.score.score == null) reasons.push('Not enough trades for a score yet.');
  }
  return { ranked: reasons.length === 0, reasons, trades: r?.n ?? 0, days: r?.spanDays ?? 0 };
}

export interface Badge {
  id: string;
  label: string;
  title: string;
}

export function badges(r: Report): Badge[] {
  const out: Badge[] = [];
  if (r.score.allWeather) out.push({ id: 'allweather', label: 'All-weather', title: 'Profitable in trending and ranging markets and in every tested volatility regime' });
  if ((r.propPass ?? 0) >= 0.5) out.push({ id: 'prop', label: 'Prop-ready', title: `${Math.round((r.propPass ?? 0) * 100)}% simulated chance to pass a 10%-target / 5%-daily / 10%-max-loss evaluation at 1% risk` });
  if (r.n >= 100) out.push({ id: 'n100', label: '100+ trades', title: `${r.n} closed trades` });
  if (r.spanDays >= 365) out.push({ id: 'year', label: '1-year record', title: `Tested over ${Math.round(r.spanDays)} days` });
  if (r.significance.pValue != null && r.significance.pValue < 0.05) out.push({ id: 'sig', label: 'Significant', title: `The edge is statistically significant (p = ${r.significance.pValue < 0.001 ? '< 0.001' : r.significance.pValue.toFixed(3)})` });
  return out;
}

// ---- leaderboard -----------------------------------------------------------------------

export interface BoardEntry {
  strategy: Strategy;
  sessions: Session[];
  report: Report | null;
  elig: Eligibility;
  /** 1-based rank among eligible strategies, null when not ranked */
  rank: number | null;
}

const byScore = (a: BoardEntry, b: BoardEntry) =>
  (b.report?.score.score ?? -1) - (a.report?.score.score ?? -1) || (b.report?.n ?? 0) - (a.report?.n ?? 0) || a.strategy.createdAt - b.strategy.createdAt || a.strategy.id.localeCompare(b.strategy.id);

/** Every strategy with its report, eligibility and rank, best first. */
export async function buildBoard(all: Session[], strategies: Strategy[]): Promise<BoardEntry[]> {
  const groups = strategies.map((st) => strategySessions(st, all));
  const reps = await reportsFor(groups, all);
  const entries: BoardEntry[] = strategies.map((st, i) => ({ strategy: st, sessions: groups[i], report: reps[i], elig: eligibility(st, reps[i]), rank: null }));
  entries.sort(byScore);
  let k = 0;
  for (const e of entries) if (e.elig.ranked) e.rank = ++k;
  return entries;
}
