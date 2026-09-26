import type { Broker } from './broker';
import type { OffsetFn } from '../core/tz';

/** Prop-firm style challenge rules (all percentages of the starting balance). */
export interface ChallengeRules {
  name: string;
  profitTarget: number; // % e.g. 10
  maxDailyLoss: number; // % e.g. 5
  maxTotalLoss: number; // % e.g. 10
  minTradingDays: number;
  trailingDrawdown: boolean; // max loss trails the equity high-water mark
  stopOnBreach: boolean; // close everything and lock trading when a limit is hit
}

export interface ChallengeState {
  status: 'active' | 'passed' | 'failed';
  reason: string;
  endedAt: number | null;
  dayKey: number;
  dayStartRef: number; // max(balance, equity) at the start of the day
  highWater: number;
  tradingDays: number[];
  worstDailyLoss: number; // $ (positive)
  maxDrawdown: number; // $ from start/high-water (positive)
  todayLoss: number; // $ (positive) right now
}

export const PRESETS: ChallengeRules[] = [
  { name: 'FTMO Phase 1', profitTarget: 10, maxDailyLoss: 5, maxTotalLoss: 10, minTradingDays: 4, trailingDrawdown: false, stopOnBreach: true },
  { name: 'FTMO Phase 2', profitTarget: 5, maxDailyLoss: 5, maxTotalLoss: 10, minTradingDays: 4, trailingDrawdown: false, stopOnBreach: true },
  { name: 'The5ers High Stakes', profitTarget: 8, maxDailyLoss: 5, maxTotalLoss: 10, minTradingDays: 3, trailingDrawdown: false, stopOnBreach: true },
  { name: 'Funding Pips 1-Step', profitTarget: 10, maxDailyLoss: 3, maxTotalLoss: 6, minTradingDays: 3, trailingDrawdown: false, stopOnBreach: true },
  { name: 'Trailing 6% (futures style)', profitTarget: 6, maxDailyLoss: 0, maxTotalLoss: 6, minTradingDays: 5, trailingDrawdown: true, stopOnBreach: true },
];

export function newChallengeState(balance: number): ChallengeState {
  return {
    status: 'active', reason: '', endedAt: null, dayKey: -1, dayStartRef: balance, highWater: balance,
    tradingDays: [], worstDailyLoss: 0, maxDrawdown: 0, todayLoss: 0,
  };
}

export function dayKeyOf(utc: number, off: OffsetFn) {
  return Math.floor((utc + off(utc)) / 86400);
}

/** Record a trading day (called when a position opens). */
export function markTradingDay(st: ChallengeState, utc: number, off: OffsetFn) {
  const d = dayKeyOf(utc, off);
  if (!st.tradingDays.includes(d)) st.tradingDays.push(d);
}

/**
 * Evaluate the rules after a bar. Returns the new status if it changed.
 * Loss limits are checked on equity (floating P&L included), like real prop firms.
 */
export function evaluate(rules: ChallengeRules, st: ChallengeState, br: Broker, initial: number, utc: number, off: OffsetFn): ChallengeState['status'] | null {
  if (st.status !== 'active') return null;
  const eq = br.equity();
  const bal = br.s.balance;
  const d = dayKeyOf(utc, off);
  if (d !== st.dayKey) {
    st.dayKey = d;
    st.dayStartRef = Math.max(bal, eq);
    st.todayLoss = 0;
  }
  st.todayLoss = Math.max(0, st.dayStartRef - eq);
  st.worstDailyLoss = Math.max(st.worstDailyLoss, st.todayLoss);
  st.highWater = Math.max(st.highWater, eq);
  const ddBase = rules.trailingDrawdown ? Math.min(st.highWater, initial * (1 + rules.maxTotalLoss / 100)) : initial;
  st.maxDrawdown = Math.max(st.maxDrawdown, ddBase - eq);

  const fail = (reason: string) => {
    st.status = 'failed';
    st.reason = reason;
    st.endedAt = utc;
    if (rules.stopOnBreach) {
      br.closeAll('manual');
      br.s.orders = [];
    }
    return 'failed' as const;
  };
  if (rules.maxDailyLoss > 0 && st.todayLoss >= (rules.maxDailyLoss / 100) * initial) return fail(`Daily loss limit of ${rules.maxDailyLoss}% hit`);
  if (rules.maxTotalLoss > 0 && eq <= ddBase - (rules.maxTotalLoss / 100) * initial) return fail(`Max ${rules.trailingDrawdown ? 'trailing ' : ''}loss of ${rules.maxTotalLoss}% hit`);
  if (rules.profitTarget > 0 && bal >= initial * (1 + rules.profitTarget / 100) && br.s.positions.length === 0 && st.tradingDays.length >= rules.minTradingDays) {
    st.status = 'passed';
    st.reason = `Profit target of ${rules.profitTarget}% reached in ${st.tradingDays.length} trading days`;
    st.endedAt = utc;
    return 'passed';
  }
  return null;
}
