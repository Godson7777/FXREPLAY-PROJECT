import { guessSpec, type Bars, type DatasetMeta } from '../core/types';
import { quoteToUsd, type ExitReason, type OrderType, type Side, type Trade } from '../engine/broker';
import type { Session } from '../engine/replay';
import { regimeSeries, tagAt, type RegimeSeries, type Trend, type Vol } from './regime';

/**
 * A closed trade normalised so trades from different sessions (different
 * account sizes, symbols and position sizes) can be combined into one
 * strategy track record. Every return is expressed as a fraction of the
 * session's closed-balance equity right before the trade closed.
 */
export interface TradeRecord {
  key: string;
  sessionId: string;
  sessionName: string;
  tz: string;
  id: number;
  symbol: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  holdSec: number;
  lots: number;
  entry: number;
  exit: number;
  pips: number;
  pnl: number; // $ in the source session
  pct: number; // pnl / equity before
  r: number | null;
  riskPct: number | null; // $ risk at the initial stop / equity before
  hasSL: boolean;
  maeR: number | null;
  mfeR: number | null;
  maePips: number;
  mfePips: number;
  exitReason: ExitReason;
  orderType: OrderType;
  tags: string[];
  note: string;
  rating?: number;
  commissionPct: number;
  /** cost of one "friction unit" (≈ 1 pip, or 0.01% of price if larger) as a fraction of equity */
  frictionPct: number;
  /** same friction unit expressed in R (null without a stop) */
  frictionR: number | null;
  trend: Trend | null;
  vol: Vol | null;
  /** null = the market data for this symbol is not on this device */
  synthetic: boolean | null;
}

/** Size of one friction unit in pips: 1 pip, or 0.01 % of price when that is bigger. */
export function frictionPips(price: number, pipSize: number): number {
  return Math.max(1, (0.0001 * price) / pipSize);
}

export function buildRecords(sessions: Session[], metas: Map<string, DatasetMeta>): TradeRecord[] {
  const out: TradeRecord[] = [];
  for (const s of sessions) {
    const trades = [...s.state.broker.trades].sort((a, b) => a.exitTime - b.exitTime || a.id - b.id);
    let eq = s.balance;
    for (const t of trades) {
      const before = eq;
      eq += t.pnl;
      out.push(toRecord(s, t, before, metas));
    }
  }
  return out.sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime || a.key.localeCompare(b.key));
}

function toRecord(s: Session, t: Trade, before: number, metas: Map<string, DatasetMeta>): TradeRecord {
  const spec = s.specs[t.symbol] ?? guessSpec(t.symbol, t.entry);
  const pipValue = t.lots * spec.contractSize * spec.pipSize * quoteToUsd(t.symbol, t.exit);
  const frictionUsd = pipValue * frictionPips(t.entry, spec.pipSize);
  const b = before > 0 ? before : NaN;
  const meta = metas.get(t.symbol);
  return {
    key: `${s.id}:${t.id}`,
    sessionId: s.id,
    sessionName: s.name,
    tz: s.timezone,
    id: t.id,
    symbol: t.symbol,
    side: t.side,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    holdSec: t.holdSec,
    lots: t.lots,
    entry: t.entry,
    exit: t.exit,
    pips: t.pips,
    pnl: t.pnl,
    pct: isFinite(t.pnl / b) ? t.pnl / b : 0,
    r: t.r != null && isFinite(t.r) ? t.r : null,
    riskPct: t.risk != null && isFinite(t.risk / b) ? t.risk / b : null,
    hasSL: t.risk != null,
    maeR: t.maeR,
    mfeR: t.mfeR,
    maePips: t.maePips,
    mfePips: t.mfePips,
    exitReason: t.exitReason,
    orderType: t.orderType,
    tags: t.tags ?? [],
    note: t.note ?? '',
    rating: t.rating,
    commissionPct: isFinite(t.commission / b) ? t.commission / b : 0,
    frictionPct: isFinite(frictionUsd / b) ? frictionUsd / b : 0,
    frictionR: t.risk ? frictionUsd / t.risk : null,
    trend: t.regime?.trend ?? null,
    vol: t.regime?.vol ?? null,
    synthetic: meta ? meta.source === 'synthetic' : null,
  };
}

/**
 * Fills in market-regime tags for trades that do not have them yet, loading the
 * symbol's 1-minute history once. Tags are written back onto the trades so the
 * work happens only once per trade. Returns the sessions that changed.
 */
export async function ensureRegimes(
  sessions: Session[],
  load: (symbol: string) => Promise<Bars | null>,
  series: (symbol: string, bars: Bars) => RegimeSeries = (_, b) => regimeSeries(b),
): Promise<Session[]> {
  const bySymbol = new Map<string, { s: Session; t: Trade }[]>();
  for (const s of sessions)
    for (const t of s.state.broker.trades) {
      if (t.regime !== undefined) continue;
      if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
      bySymbol.get(t.symbol)!.push({ s, t });
    }
  const changed = new Set<Session>();
  for (const [sym, items] of bySymbol) {
    let bars: Bars | null = null;
    try {
      bars = await load(sym);
    } catch {
      bars = null;
    }
    if (!bars || bars.n < 2) continue; // data missing on this device: try again later
    const rs = series(sym, bars);
    for (const { s, t } of items) {
      t.regime = tagAt(rs, bars, t.entryTime);
      changed.add(s);
    }
  }
  return [...changed];
}
