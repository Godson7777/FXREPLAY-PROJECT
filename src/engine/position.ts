import type { Side } from './broker';

/**
 * Math behind the Long/Short position tool (TradingView-style): risk sizing, the
 * target/stop read-outs and which level a replay reaches first.
 */
export type RiskMode = 'pct' | 'usd' | 'lots';

export interface PosSettings {
  riskMode: RiskMode;
  risk: number;
  /** account size; defaults to the session balance */
  account?: number;
}

export interface PosLevels {
  side: Side;
  entry: number;
  sl: number;
  tp: number;
}

export interface PosEnv {
  pipSize: number;
  /** money value of a price move for `lots` at `price` (Broker.value) */
  value(priceDelta: number, lots: number, price: number): number;
  balance: number;
}

export interface PosCalc {
  lots: number;
  riskUsd: number;
  rewardUsd: number;
  rr: number;
  slPips: number;
  tpPips: number;
  slPct: number;
  tpPct: number;
  /** the stop/target are on the wrong side of the entry for this side */
  invalid: boolean;
}

/** Lots so that hitting the stop loses the configured risk (rounded down to 0.01, min 0.01). */
export function lotsFor(l: PosLevels, s: PosSettings, env: PosEnv): number {
  if (s.riskMode === 'lots') return Math.max(0.01, Math.round(s.risk * 100) / 100);
  const account = s.account && s.account > 0 ? s.account : env.balance;
  const riskUsd = s.riskMode === 'pct' ? (account * s.risk) / 100 : s.risk;
  const perLot = env.value(Math.abs(l.entry - l.sl), 1, l.sl);
  if (!(perLot > 0) || !(riskUsd > 0)) return 0.01;
  return Math.max(0.01, Math.floor((riskUsd / perLot) * 100 + 1e-6) / 100);
}

export function posCalc(l: PosLevels, s: PosSettings, env: PosEnv): PosCalc {
  const lots = lotsFor(l, s, env);
  const slD = Math.abs(l.entry - l.sl), tpD = Math.abs(l.tp - l.entry);
  const dir = l.side === 'long' ? 1 : -1;
  const invalid = dir * (l.entry - l.sl) <= 0 || dir * (l.tp - l.entry) <= 0;
  const riskUsd = env.value(slD, lots, l.sl);
  const rewardUsd = env.value(tpD, lots, l.tp);
  return {
    lots, riskUsd, rewardUsd, rr: slD ? tpD / slD : 0,
    slPips: slD / env.pipSize, tpPips: tpD / env.pipSize,
    slPct: (slD / l.entry) * 100, tpPct: (tpD / l.entry) * 100, invalid,
  };
}

/** Long ↔ short: mirror stop and target around the entry, keeping their distances. */
export function flipLevels(l: PosLevels): PosLevels {
  return { side: l.side === 'long' ? 'short' : 'long', entry: l.entry, sl: 2 * l.entry - l.sl, tp: 2 * l.entry - l.tp };
}

/** Put stop/target on the correct sides for `side`, keeping their distances from the entry. */
export function orient(side: Side, entry: number, slDist: number, tpDist: number): PosLevels {
  const dir = side === 'long' ? 1 : -1;
  return { side, entry, sl: entry - dir * Math.abs(slDist), tp: entry + dir * Math.abs(tpDist) };
}

export interface Hit {
  kind: 'tp' | 'sl';
  index: number;
}

/**
 * Walk revealed bars (index from..to inclusive, `bar` returns null past the replay
 * clock) and report which level is touched first. A bar touching both counts as
 * the stop (conservative, like the broker's default).
 */
export function firstHit(l: PosLevels, from: number, to: number, bar: (i: number) => { h: number; l: number } | null): Hit | null {
  for (let i = Math.max(0, from); i <= to; i++) {
    const b = bar(i);
    if (!b) return null;
    const hitSl = l.side === 'long' ? b.l <= l.sl : b.h >= l.sl;
    const hitTp = l.side === 'long' ? b.h >= l.tp : b.l <= l.tp;
    if (hitSl) return { kind: 'sl', index: i };
    if (hitTp) return { kind: 'tp', index: i };
  }
  return null;
}

/** Order type for an entry: market when at the current price, else limit or stop by side. */
export function autoType(side: Side, entry: number, bid: number, ask: number, tol: number): 'market' | 'limit' | 'stop' {
  const cur = side === 'long' ? ask : bid;
  if (Math.abs(entry - cur) <= tol) return 'market';
  return (side === 'long') === entry < cur ? 'limit' : 'stop';
}
