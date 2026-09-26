import type { InstrumentSpec } from '../core/types';

export type Side = 'long' | 'short';
export type OrderType = 'market' | 'limit' | 'stop';
export type ExitReason = 'sl' | 'tp' | 'manual' | 'be' | 'trail' | 'end';

export interface Order {
  id: number;
  symbol: string;
  side: Side;
  type: Exclude<OrderType, 'market'>;
  price: number;
  lots: number;
  sl: number | null;
  tp: number | null;
  createdAt: number;
  tags: string[];
  note: string;
  trailPips: number | null;
  beAtR: number | null;
}

export interface PartialClose {
  time: number;
  lots: number;
  price: number;
  pnl: number;
}

export interface Position {
  id: number;
  symbol: string;
  side: Side;
  lots: number;
  initialLots: number;
  entry: number;
  entryTime: number;
  sl: number | null;
  tp: number | null;
  initialSl: number | null;
  commission: number;
  realized: number; // gross realized from partial closes
  mae: number; // max adverse excursion, price units (>=0)
  mfe: number; // max favourable excursion, price units (>=0)
  tags: string[];
  note: string;
  trailPips: number | null;
  beAtR: number | null;
  beDone: boolean;
  orderType: OrderType;
  partials: PartialClose[];
  openedBar: number; // bar time on which it opened (no exit checks on that bar)
  slMoved: 'be' | 'trail' | null;
}

export interface Trade {
  id: number;
  symbol: string;
  side: Side;
  lots: number;
  entry: number;
  exit: number; // lot-weighted average exit
  entryTime: number;
  exitTime: number;
  gross: number;
  commission: number;
  pnl: number; // net
  pips: number;
  risk: number | null; // $ risked at initial SL
  r: number | null; // pnl / risk
  maePips: number;
  mfePips: number;
  maeR: number | null;
  mfeR: number | null;
  holdSec: number;
  exitReason: ExitReason;
  orderType: OrderType;
  tags: string[];
  note: string;
  balanceAfter: number;
  shot?: string;
  rating?: number;
}

export interface BrokerConfig {
  initialBalance: number;
  commissionPerLot: number; // USD per lot, per side
  spreadPips: Record<string, number>; // per symbol; '*' default
  slFirst: boolean; // if SL and TP inside the same bar, assume SL was hit first
}

export interface EquityPoint {
  t: number;
  balance: number;
  equity: number;
}

export interface BrokerState {
  balance: number;
  orders: Order[];
  positions: Position[];
  trades: Trade[];
  equity: EquityPoint[];
  nextId: number;
  last: Record<string, { t: number; bid: number }>;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  lots: number;
  price?: number; // for limit/stop
  sl?: number | null;
  tp?: number | null;
  tags?: string[];
  note?: string;
  trailPips?: number | null;
  beAtR?: number | null;
}

export function quoteToUsd(symbol: string, price: number): number {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (/(USD|USDT|USDC|BUSD|FDUSD)$/.test(s)) return 1;
  if (/^USD/.test(s) && price > 0) return 1 / price;
  return 1;
}

export function newBrokerState(initialBalance: number): BrokerState {
  return { balance: initialBalance, orders: [], positions: [], trades: [], equity: [], nextId: 1, last: {} };
}

export class Broker {
  onTradeClosed: ((t: Trade) => void) | null = null;
  onFill: ((p: Position) => void) | null = null;
  blocked: (() => string | null) | null = null;

  constructor(
    public cfg: BrokerConfig,
    public specs: Record<string, InstrumentSpec>,
    public s: BrokerState,
  ) {}

  spec(sym: string): InstrumentSpec {
    return this.specs[sym] ?? { symbol: sym, pipSize: 0.0001, contractSize: 100000, digits: 5 };
  }
  spread(sym: string): number {
    const pips = this.cfg.spreadPips[sym] ?? this.cfg.spreadPips['*'] ?? 0;
    return pips * this.spec(sym).pipSize;
  }
  bid(sym: string) {
    return this.s.last[sym]?.bid ?? NaN;
  }
  ask(sym: string) {
    return this.bid(sym) + this.spread(sym);
  }
  now(sym?: string) {
    if (sym && this.s.last[sym]) return this.s.last[sym].t;
    let t = 0;
    for (const k in this.s.last) t = Math.max(t, this.s.last[k].t);
    return t;
  }

  /** money value of a price move for `lots` */
  value(sym: string, priceDelta: number, lots: number, atPrice: number) {
    const sp = this.spec(sym);
    return priceDelta * lots * sp.contractSize * quoteToUsd(sym, atPrice);
  }

  /** lots so that a stop `slDistance` away loses `riskUsd` */
  lotsForRisk(sym: string, riskUsd: number, slDistance: number, price: number) {
    const perLot = this.value(sym, Math.abs(slDistance), 1, price);
    if (!(perLot > 0)) return 0;
    return Math.max(0.01, Math.floor((riskUsd / perLot) * 100) / 100);
  }

  floating(p: Position): number {
    const px = p.side === 'long' ? this.bid(p.symbol) : this.ask(p.symbol);
    if (!isFinite(px)) return 0;
    return this.value(p.symbol, (p.side === 'long' ? 1 : -1) * (px - p.entry), p.lots, px);
  }

  equity(): number {
    return this.s.balance + this.s.positions.reduce((a, p) => a + this.floating(p), 0);
  }

  openRisk(): number {
    let r = 0;
    for (const p of this.s.positions) {
      if (p.sl == null) continue;
      const loss = this.value(p.symbol, (p.side === 'long' ? 1 : -1) * (p.sl - p.entry), p.lots, p.sl);
      r += Math.min(0, loss);
    }
    return -r;
  }

  private id() {
    return this.s.nextId++;
  }

  place(req: OrderRequest): { ok: true; id: number } | { ok: false; error: string } {
    const sym = req.symbol;
    const block = this.blocked?.();
    if (block) return { ok: false, error: block };
    if (!this.s.last[sym]) return { ok: false, error: 'No price yet for ' + sym };
    if (!(req.lots > 0)) return { ok: false, error: 'Lot size must be > 0' };
    const bid = this.bid(sym), ask = this.ask(sym);
    const px = req.type === 'market' ? (req.side === 'long' ? ask : bid) : req.price!;
    if (!(px > 0)) return { ok: false, error: 'Invalid price' };
    const sl = req.sl ?? null, tp = req.tp ?? null;
    if (req.side === 'long') {
      if (sl != null && sl >= px) return { ok: false, error: 'Stop loss must be below entry for a buy' };
      if (tp != null && tp <= px) return { ok: false, error: 'Take profit must be above entry for a buy' };
    } else {
      if (sl != null && sl <= px) return { ok: false, error: 'Stop loss must be above entry for a sell' };
      if (tp != null && tp >= px) return { ok: false, error: 'Take profit must be below entry for a sell' };
    }
    if (req.type === 'limit') {
      if (req.side === 'long' && px >= ask) return { ok: false, error: 'Buy limit must be below the current ask (use a stop order)' };
      if (req.side === 'short' && px <= bid) return { ok: false, error: 'Sell limit must be above the current bid (use a stop order)' };
    }
    if (req.type === 'stop') {
      if (req.side === 'long' && px <= ask) return { ok: false, error: 'Buy stop must be above the current ask (use a limit order)' };
      if (req.side === 'short' && px >= bid) return { ok: false, error: 'Sell stop must be below the current bid (use a limit order)' };
    }
    const common = {
      symbol: sym, side: req.side, lots: round2(req.lots), sl, tp,
      tags: req.tags ?? [], note: req.note ?? '', trailPips: req.trailPips ?? null, beAtR: req.beAtR ?? null,
    };
    if (req.type === 'market') {
      const p = this.open({ ...common, entry: px, time: this.now(sym), orderType: 'market' });
      return { ok: true, id: p.id };
    }
    const o: Order = { ...common, id: this.id(), type: req.type, price: px, createdAt: this.now(sym) };
    this.s.orders.push(o);
    return { ok: true, id: o.id };
  }

  private open(a: {
    symbol: string; side: Side; lots: number; entry: number; time: number; sl: number | null; tp: number | null;
    tags: string[]; note: string; trailPips: number | null; beAtR: number | null; orderType: OrderType;
  }): Position {
    const commission = this.cfg.commissionPerLot * a.lots;
    const p: Position = {
      id: this.id(), symbol: a.symbol, side: a.side, lots: a.lots, initialLots: a.lots, entry: a.entry, entryTime: a.time,
      sl: a.sl, tp: a.tp, initialSl: a.sl, commission, realized: 0, mae: 0, mfe: 0, tags: a.tags, note: a.note,
      trailPips: a.trailPips, beAtR: a.beAtR, beDone: false, orderType: a.orderType, partials: [], openedBar: a.time, slMoved: null,
    };
    this.s.balance -= commission;
    this.s.positions.push(p);
    this.onFill?.(p);
    return p;
  }

  cancelOrder(id: number) {
    this.s.orders = this.s.orders.filter((o) => o.id !== id);
  }

  modifyOrder(id: number, patch: Partial<Pick<Order, 'price' | 'sl' | 'tp' | 'lots'>>) {
    const o = this.s.orders.find((x) => x.id === id);
    if (o) Object.assign(o, patch);
  }

  modifyPosition(id: number, patch: { sl?: number | null; tp?: number | null; trailPips?: number | null; note?: string; tags?: string[] }) {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p) return;
    if (patch.sl !== undefined) {
      if (p.initialSl == null && patch.sl != null) p.initialSl = patch.sl;
      p.sl = patch.sl;
    }
    if (patch.tp !== undefined) p.tp = patch.tp;
    if (patch.trailPips !== undefined) p.trailPips = patch.trailPips;
    if (patch.note !== undefined) p.note = patch.note;
    if (patch.tags !== undefined) p.tags = patch.tags;
  }

  breakeven(id: number) {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p) return;
    p.sl = p.entry;
    p.slMoved = 'be';
  }

  reverse(id: number) {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p) return;
    const { symbol, lots, side } = p;
    this.close(id, 1, 'manual');
    this.place({ symbol, side: side === 'long' ? 'short' : 'long', type: 'market', lots });
  }

  /** Close a fraction (0..1] of a position at market. */
  close(id: number, fraction = 1, reason: ExitReason = 'manual', price?: number, time?: number): Trade | null {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p) return null;
    const px = price ?? (p.side === 'long' ? this.bid(p.symbol) : this.ask(p.symbol));
    const t = time ?? this.now(p.symbol);
    let lots = fraction >= 1 ? p.lots : round2(p.lots * fraction);
    if (lots <= 0) return null;
    if (lots >= p.lots - 1e-9) lots = p.lots;
    const gross = this.value(p.symbol, (p.side === 'long' ? 1 : -1) * (px - p.entry), lots, px);
    const comm = this.cfg.commissionPerLot * lots;
    this.s.balance += gross - comm;
    p.commission += comm;
    p.realized += gross;
    p.partials.push({ time: t, lots, price: px, pnl: gross });
    p.lots = round2(p.lots - lots);
    if (p.lots > 1e-9) return null;
    return this.finalize(p, reason, t);
  }

  private finalize(p: Position, reason: ExitReason, t: number): Trade {
    this.s.positions = this.s.positions.filter((x) => x !== p);
    const sp = this.spec(p.symbol);
    const totLots = p.partials.reduce((a, x) => a + x.lots, 0) || p.initialLots;
    const exit = p.partials.reduce((a, x) => a + x.price * x.lots, 0) / totLots;
    const dir = p.side === 'long' ? 1 : -1;
    const pnl = p.realized - p.commission;
    const riskDist = p.initialSl != null ? Math.abs(p.entry - p.initialSl) : null;
    const risk = riskDist ? this.value(p.symbol, riskDist, p.initialLots, p.initialSl!) + p.commission : null;
    let why = reason;
    if (reason === 'sl' && p.slMoved) why = p.slMoved;
    const tr: Trade = {
      id: p.id, symbol: p.symbol, side: p.side, lots: p.initialLots, entry: p.entry, exit, entryTime: p.entryTime, exitTime: t,
      gross: p.realized, commission: p.commission, pnl, pips: (dir * (exit - p.entry)) / sp.pipSize,
      risk, r: risk ? pnl / risk : null,
      maePips: p.mae / sp.pipSize, mfePips: p.mfe / sp.pipSize,
      maeR: riskDist ? p.mae / riskDist : null, mfeR: riskDist ? p.mfe / riskDist : null,
      holdSec: t - p.entryTime, exitReason: why, orderType: p.orderType, tags: p.tags, note: p.note,
      balanceAfter: this.s.balance,
    };
    this.s.trades.push(tr);
    this.onTradeClosed?.(tr);
    return tr;
  }

  closeAll(reason: ExitReason = 'manual') {
    for (const p of [...this.s.positions]) this.close(p.id, 1, reason);
  }

  setPrice(sym: string, t: number, bid: number) {
    this.s.last[sym] = { t, bid };
  }

  /**
   * Process a newly revealed base bar. Order of events inside the bar:
   * exits of existing positions (SL before TP if both touched, unless configured),
   * then pending order triggers, then excursion/trailing updates.
   */
  onBar(sym: string, t: number, o: number, h: number, l: number, c: number) {
    const spr = this.spread(sym);
    // 1) exits
    for (const p of [...this.s.positions]) {
      if (p.symbol !== sym || p.openedBar === t) continue;
      if (p.side === 'long') {
        const hitSl = p.sl != null && l <= p.sl;
        const hitTp = p.tp != null && h >= p.tp;
        if (hitSl && (!hitTp || this.cfg.slFirst || o <= p.sl!)) this.close(p.id, 1, 'sl', Math.min(p.sl!, o), t);
        else if (hitTp) this.close(p.id, 1, 'tp', Math.max(p.tp!, o), t);
      } else {
        const hitSl = p.sl != null && h + spr >= p.sl;
        const hitTp = p.tp != null && l + spr <= p.tp;
        if (hitSl && (!hitTp || this.cfg.slFirst || o + spr >= p.sl!)) this.close(p.id, 1, 'sl', Math.max(p.sl!, o + spr), t);
        else if (hitTp) this.close(p.id, 1, 'tp', Math.min(p.tp!, o + spr), t);
      }
    }
    // 2) pending orders
    for (const od of [...this.s.orders]) {
      if (od.symbol !== sym) continue;
      let fill: number | null = null;
      if (od.side === 'long') {
        const aO = o + spr, aH = h + spr, aL = l + spr;
        if (od.type === 'limit' && aL <= od.price) fill = Math.min(od.price, aO);
        if (od.type === 'stop' && aH >= od.price) fill = Math.max(od.price, aO);
      } else {
        if (od.type === 'limit' && h >= od.price) fill = Math.max(od.price, o);
        if (od.type === 'stop' && l <= od.price) fill = Math.min(od.price, o);
      }
      if (fill != null) {
        this.s.orders = this.s.orders.filter((x) => x !== od);
        this.open({ ...od, entry: fill, time: t, orderType: od.type });
      }
    }
    // 3) excursions, trailing & auto-breakeven
    for (const p of this.s.positions) {
      if (p.symbol !== sym) continue;
      if (p.side === 'long') {
        p.mae = Math.max(p.mae, p.entry - l);
        p.mfe = Math.max(p.mfe, h - p.entry);
      } else {
        p.mae = Math.max(p.mae, h + spr - p.entry);
        p.mfe = Math.max(p.mfe, p.entry - (l + spr));
      }
      const risk = p.initialSl != null ? Math.abs(p.entry - p.initialSl) : 0;
      if (p.beAtR && !p.beDone && risk > 0 && p.mfe >= p.beAtR * risk) {
        p.beDone = true;
        if (p.sl == null || (p.side === 'long' ? p.sl < p.entry : p.sl > p.entry)) {
          p.sl = p.entry;
          p.slMoved = 'be';
        }
      }
      if (p.trailPips && p.trailPips > 0) {
        const d = p.trailPips * this.spec(sym).pipSize;
        const cand = p.side === 'long' ? h - d : l + spr + d;
        if (p.sl == null || (p.side === 'long' ? cand > p.sl : cand < p.sl)) {
          p.sl = cand;
          p.slMoved = 'trail';
        }
      }
    }
    // equity snapshot (hourly resolution is plenty for curves)
    const prev = this.s.last[sym]?.t ?? 0;
    this.setPrice(sym, t, c);
    if (Math.floor(prev / 3600) !== Math.floor(t / 3600)) {
      const eq = this.s.equity;
      const pt = { t, balance: this.s.balance, equity: this.equity() };
      if (eq.length && eq[eq.length - 1].t === t) eq[eq.length - 1] = pt;
      else eq.push(pt);
      if (eq.length > 60000) this.s.equity = eq.filter((_, i) => i % 2 === 0);
    }
  }
}

export function round2(x: number) {
  return Math.round(x * 100) / 100;
}
