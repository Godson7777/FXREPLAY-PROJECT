import { indexAtOrBefore, type Bars, type InstrumentSpec } from '../core/types';
import { Broker, newBrokerState, type BrokerState } from './broker';
import type { Drawing } from '../ui/drawings';

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
}

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

  constructor(
    public session: Session,
    public data: Record<string, Bars>,
  ) {
    const s = session;
    this.broker = new Broker(
      { initialBalance: s.balance, commissionPerLot: s.commissionPerLot, spreadPips: s.spreadPips, slFirst: s.slFirst },
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
