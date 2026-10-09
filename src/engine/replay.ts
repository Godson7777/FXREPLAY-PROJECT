import { indexAtOrBefore, type Bars, type InstrumentSpec } from '../core/types';
import { Broker, newBrokerState, type BrokerState } from './broker';
import type { Drawing } from '../ui/drawings';
import { offsetFn } from '../core/tz';
import { evaluate, markTradingDay, newChallengeState, type ChallengeRules, type ChallengeState } from './rules';

export interface PaneConfig {
  symbol: string;
  tf: string;
  indicators: IndicatorConfig[];
}

export interface IndicatorConfig {
  id: string;
  type: string;
  params: Record<string, number>;
  color: string;
}

export interface SessionConfig {
  id: string;
  name: string;
  description: string;
  symbols: string[]; // dataset ids
  start: number; // UTC seconds
  end: number | null;
  balance: number;
  commissionPerLot: number;
  spreadPips: Record<string, number>;
  slFirst: boolean;
  timezone: string;
  riskPct: number;
  createdAt: number;
  specs: Record<string, InstrumentSpec>;
  rules?: ChallengeRules | null;
  /** account leverage; when set, positions use isolated margin and can be liquidated */
  leverage?: number;
  maxLeverage?: Record<string, number>;
  /** fee in % of notional per side (crypto venues) */
  feePct?: number;
  /** forward-test on a live market feed instead of replaying history */
  live?: { venue: 'hyperliquid'; coin: string } | null;
}

export interface SessionState {
  clock: number;
  broker: BrokerState;
  drawings: Record<string, Drawing[]>;
  layout: number; // 1 | 2 | 3 | 4
  panes: PaneConfig[];
  active: number;
  updatedAt: number;
  finished: boolean;
  favTfs: string[];
  challenge?: ChallengeState;
  chartType?: Record<number, ChartType>;
}

export type ChartType = 'candles' | 'hollow' | 'heikin' | 'bars' | 'line' | 'area';

export interface Session extends SessionConfig {
  state: SessionState;
}

export function newSession(cfg: SessionConfig): Session {
  const sym = cfg.symbols[0];
  return {
    ...cfg,
    state: {
      clock: cfg.start,
      broker: newBrokerState(cfg.balance),
      drawings: {},
      layout: 1,
      panes: [0, 1, 2, 3].map((i) => ({
        symbol: cfg.symbols[i % cfg.symbols.length] ?? sym,
        tf: ['15m', '1H', '4H', 'D'][i],
        indicators: [],
      })),
      active: 0,
      updatedAt: Date.now(),
      finished: false,
      favTfs: ['1m', '5m', '15m', '1H', '4H', 'D'],
    },
  };
}

/** Common time window [from, to] covered by every selected dataset (from > to = no overlap). */
export function dataWindow(metas: { from: number; to: number }[]): { from: number; to: number } {
  return { from: Math.max(...metas.map((m) => m.from)), to: Math.min(...metas.map((m) => m.to)) };
}

/** Error text for a start/end outside the data, or null when the range can be replayed. */
export function checkRange(win: { from: number; to: number }, start: number, end: number | null, fmt: (t: number) => string): string | null {
  if (win.from >= win.to) return 'The selected symbols have no overlapping dates — pick symbols that cover the same period.';
  if (!isFinite(start)) return 'Invalid start date';
  if (start < win.from || start >= win.to) return `Start must be between ${fmt(win.from)} and ${fmt(win.to)} — that is where your data is. After the last bar there is nothing to replay.`;
  if (end != null && (!isFinite(end) || end <= start)) return 'End must be after the start';
  return null;
}

/**
 * The replay clock. Every symbol has its own base-bar cursor; the clock always
 * advances to the earliest next bar across all symbols so multi-symbol sessions
 * stay time-synchronised. Each revealed base bar is fed to the broker, so
 * SL/TP/pending orders resolve at base (e.g. 1-minute) resolution no matter
 * which timeframe you are looking at.
 */
export class Replay {
  cursor: Record<string, number> = {};
  broker: Broker;
  listeners = new Set<(kind: 'step' | 'jump') => void>();
  onChallenge: ((st: ChallengeState) => void) | null = null;

  constructor(
    public session: Session,
    public data: Record<string, Bars>,
  ) {
    const s = session;
    this.broker = new Broker(
      { initialBalance: s.balance, commissionPerLot: s.commissionPerLot, spreadPips: s.spreadPips, slFirst: s.slFirst, leverage: s.leverage, maxLeverage: s.maxLeverage, feePct: s.feePct },
      s.specs,
      s.state.broker,
    );
    for (const sym of s.symbols) {
      const b = data[sym];
      if (!b) continue;
      const i = Math.max(0, indexAtOrBefore(b.t, b.n, s.state.clock - 1));
      this.cursor[sym] = i;
      if (!this.broker.s.last[sym]) this.broker.setPrice(sym, b.t[i], b.c[i]);
    }
    if (s.rules && !s.state.challenge) s.state.challenge = newChallengeState(s.balance);
    const off = offsetFn(s.timezone);
    this.broker.onFill = (p) => {
      if (s.state.challenge) markTradingDay(s.state.challenge, p.entryTime, off);
    };
    this.broker.blocked = () => this.locked;
    this.checkRules();
  }

  /** Add a symbol mid-session: its cursor starts at the current clock, so it stays in sync. */
  addSymbol(sym: string, bars: Bars, spec: InstrumentSpec) {
    const s = this.session;
    if (this.cursor[sym] != null) return;
    this.data[sym] = bars;
    s.specs[sym] = spec;
    if (!s.symbols.includes(sym)) s.symbols.push(sym);
    const i = Math.max(0, indexAtOrBefore(bars.t, bars.n, s.state.clock - 1));
    this.cursor[sym] = i;
    this.broker.setPrice(sym, bars.t[i], bars.c[i]);
  }

  get locked(): string | null {
    const c = this.session.state.challenge;
    if (c && c.status === 'failed' && this.session.rules?.stopOnBreach) return `Challenge failed: ${c.reason}`;
    return null;
  }

  checkRules() {
    const s = this.session;
    if (!s.rules || !s.state.challenge) return;
    const changed = evaluate(s.rules, s.state.challenge, this.broker, s.balance, s.state.clock, offsetFn(s.timezone));
    if (changed) this.onChallenge?.(s.state.challenge);
  }

  get clock() {
    return this.session.state.clock;
  }

  nextTime(): number {
    let nt = Infinity;
    for (const sym in this.cursor) {
      const b = this.data[sym];
      const i = this.cursor[sym] + 1;
      if (i < b.n && b.t[i] < nt) nt = b.t[i];
    }
    const end = this.session.end;
    if (end != null && nt > end) return Infinity;
    return nt;
  }

  /** Last bar time across the session's symbols (respects the session end). */
  dataEnd(): number {
    let t = -Infinity;
    for (const sym in this.cursor) {
      const b = this.data[sym];
      if (b?.n) t = Math.max(t, b.t[b.n - 1]);
    }
    return this.session.end != null ? Math.min(t, this.session.end) : t;
  }

  /** True when at least one more bar can be revealed. */
  hasFuture() {
    return isFinite(this.nextTime());
  }

  /** Reveal the next base bar(s). Returns false at the end of data/session. */
  stepBase(): boolean {
    const nt = this.nextTime();
    if (!isFinite(nt)) {
      this.session.state.finished = true;
      return false;
    }
    for (const sym in this.cursor) {
      const b = this.data[sym];
      const i = this.cursor[sym] + 1;
      if (i < b.n && b.t[i] === nt) {
        this.cursor[sym] = i;
        this.broker.onBar(sym, nt, b.o[i], b.h[i], b.l[i], b.c[i]);
      }
    }
    this.session.state.clock = nt + 1;
    this.checkRules();
    return true;
  }

  /** Advance until `pred` says stop (checked after each base step), with a safety cap. */
  advanceWhile(pred: () => boolean, max = 5_000_000): number {
    let n = 0;
    while (n < max && pred()) {
      if (!this.stepBase()) break;
      n++;
    }
    return n;
  }

  /** Jump forward to a UTC time, processing every bar in between (orders stay honest). */
  jumpTo(utc: number) {
    this.advanceWhile(() => this.nextTime() <= utc);
    this.emit('jump');
  }

  emit(kind: 'step' | 'jump') {
    this.session.state.updatedAt = Date.now();
    for (const l of this.listeners) l(kind);
  }
}
