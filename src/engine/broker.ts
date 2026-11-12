import type { InstrumentSpec } from '../core/types';
import type { RegimeTag } from '../analytics/regime';

export type Side = 'long' | 'short';
export type OrderType = 'market' | 'limit' | 'stop';
export type ExitReason = 'sl' | 'tp' | 'manual' | 'be' | 'trail' | 'end' | 'liq';

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
  /** leverage the order will open with (leveraged sessions only) */
  leverage?: number;
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
  /** isolated-margin fields; absent on unleveraged sessions */
  leverage?: number;
  margin?: number;
  liq?: number | null;
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
  /** market regime at entry; undefined = not computed yet, null = not enough history */
  regime?: RegimeTag | null;
}

export interface BrokerConfig {
  initialBalance: number;
  commissionPerLot: number; // USD per lot, per side
  spreadPips: Record<string, number>; // per symbol; '*' default
  slFirst: boolean; // if SL and TP inside the same bar, assume SL was hit first
  /** default leverage; when set, every position uses isolated margin and can be liquidated */
  leverage?: number;
  /** max leverage per symbol ('*' default); maintenance margin = 1 / (2 × max leverage) */
  maxLeverage?: Record<string, number>;
  /** fee in % of notional, charged per side (e.g. 0.045 for a 0.045% taker fee) */
  feePct?: number;
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
  leverage?: number;
}

/**
 * Rough USD value of one unit of a currency, for pairs quoted in neither USD nor with USD
 * as the base (EURJPY, EURGBP…). Only used when no price of the matching USD pair is at
 * hand; the ticket says so when it is. Without it a JPY profit would be counted as dollars.
 */
const APPROX_USD: Record<string, number> = {
  EUR: 1.08, GBP: 1.27, AUD: 0.66, NZD: 0.6, CAD: 0.73, CHF: 1.13, JPY: 0.0067, SEK: 0.095, NOK: 0.093, DKK: 0.145,
  SGD: 0.75, HKD: 0.128, ZAR: 0.054, MXN: 0.055, TRY: 0.029, PLN: 0.25, CZK: 0.043, HUF: 0.0027, CNH: 0.138, CNY: 0.138,
};

/** How a symbol's prices turn into dollars. */
export function quoteInfo(symbol: string): { kind: 'usd' | 'inverse' | 'cross' | 'other'; ccy: string | null } {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (/(USD|USDT|USDC|BUSD|FDUSD)$/.test(s)) return { kind: 'usd', ccy: 'USD' };
  if (/^USD/.test(s)) return { kind: 'inverse', ccy: s.slice(3) || null };
  const q = s.slice(-3);
  if (s.length >= 6 && APPROX_USD[q] != null) return { kind: 'cross', ccy: q };
  return { kind: 'other', ccy: null };
}

/**
 * USD value of one unit of the symbol's quote currency. `rate` can supply an exact
 * figure for a cross pair's quote currency (from the matching USD pair); otherwise an
 * approximate one is used.
 */
export function quoteToUsd(symbol: string, price: number, rate?: (ccy: string) => number | null): number {
  const q = quoteInfo(symbol);
  if (q.kind === 'usd' || q.kind === 'other') return 1;
  if (q.kind === 'inverse') return price > 0 ? 1 / price : 1;
  const exact = rate?.(q.ccy!);
  return exact != null && exact > 0 && isFinite(exact) ? exact : APPROX_USD[q.ccy!];
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

  /**
   * Exact USD value of one unit of `ccy` when the session carries the matching USD pair
   * (USDJPY or JPYUSD for JPY), else null.
   */
  private usdRate = (ccy: string): number | null => {
    for (const k in this.s.last) {
      const s = k.toUpperCase().replace(/[^A-Z]/g, '');
      const bid = this.s.last[k].bid;
      if (!(bid > 0)) continue;
      if (s === `USD${ccy}`) return 1 / bid;
      if (s === `${ccy}USD`) return bid;
    }
    return null;
  };

  /**
   * How a cross pair's results are turned into dollars, for display: null for symbols
   * that need no conversion.
   */
  conversion(sym: string): { ccy: string; rate: number; exact: boolean } | null {
    const q = quoteInfo(sym);
    if (q.kind !== 'cross' || !q.ccy) return null;
    const exact = this.usdRate(q.ccy);
    return { ccy: q.ccy, rate: exact ?? quoteToUsd(sym, 0), exact: exact != null };
  }

  /** money value of a price move for `lots` */
  value(sym: string, priceDelta: number, lots: number, atPrice: number) {
    const sp = this.spec(sym);
    return priceDelta * lots * sp.contractSize * quoteToUsd(sym, atPrice, this.usdRate);
  }

  /** lots so that a stop `slDistance` away loses `riskUsd` */
  lotsForRisk(sym: string, riskUsd: number, slDistance: number, price: number) {
    const perLot = this.value(sym, Math.abs(slDistance), 1, price);
    if (!(perLot > 0)) return 0;
    return Math.max(0.01, Math.floor((riskUsd / perLot) * 100 + 1e-6) / 100);
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

  // ---- leverage & isolated margin ------------------------------------------------

  get leveraged() {
    return this.cfg.leverage != null && this.cfg.leverage > 0;
  }
  maxLev(sym: string) {
    return this.cfg.maxLeverage?.[sym] ?? this.cfg.maxLeverage?.['*'] ?? null;
  }
  /** leverage clamped to 1…max for the symbol */
  levFor(sym: string, want?: number) {
    const max = this.maxLev(sym);
    const l = want ?? this.cfg.leverage ?? 1;
    return Math.max(1, Math.min(max ?? Infinity, isFinite(l) && l > 0 ? l : 1));
  }
  notional(sym: string, lots: number, px: number) {
    return Math.abs(this.value(sym, px, lots, px));
  }
  marginFor(sym: string, lots: number, px: number, lev: number) {
    return this.notional(sym, lots, px) / lev;
  }
  /** maintenance margin rate: half the initial margin at max leverage (50% stop-out without a max) */
  mmr(sym: string, lev: number) {
    return 1 / (2 * (this.maxLev(sym) ?? lev));
  }
  /** isolated-margin liquidation trigger price */
  liqPrice(sym: string, side: Side, entry: number, lev: number) {
    const d = 1 / lev - this.mmr(sym, lev);
    return side === 'long' ? entry * (1 - d) : entry * (1 + d);
  }
  usedMargin() {
    return this.s.positions.reduce((a, p) => a + (p.margin ?? 0), 0);
  }
  reservedMargin() {
    if (!this.leveraged) return 0;
    return this.s.orders.reduce((a, o) => a + this.marginFor(o.symbol, o.lots, o.price, this.levFor(o.symbol, o.leverage)), 0);
  }
  freeMargin() {
    return this.equity() - this.usedMargin() - this.reservedMargin();
  }
  private fee(sym: string, lots: number, px: number) {
    const pct = this.cfg.feePct ?? 0;
    return this.cfg.commissionPerLot * lots + (pct > 0 ? (pct / 100) * this.notional(sym, lots, px) : 0);
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
    if (!(round2(req.lots) > 0)) return { ok: false, error: 'Lot size is below the minimum of 0.01' };
    const lev = this.leveraged ? this.levFor(sym, req.leverage) : undefined;
    const common = {
      symbol: sym, side: req.side, lots: round2(req.lots), sl, tp,
      tags: req.tags ?? [], note: req.note ?? '', trailPips: req.trailPips ?? null, beAtR: req.beAtR ?? null,
      ...(lev ? { leverage: lev } : {}),
    };
    if (lev) {
      const need = this.marginFor(sym, common.lots, px, lev);
      const free = this.freeMargin();
      if (need > free) {
        const max = Math.floor((common.lots * Math.max(0, free) / need) * 100) / 100;
        return { ok: false, error: `Not enough margin: needs $${need.toFixed(2)}, free $${Math.max(0, free).toFixed(2)} at ${lev}×. ${max > 0 ? `The most you can open is ${max.toFixed(2)} lots — ` : ''}widen the stop, lower the risk or raise the leverage.` };
      }
      const liq = this.liqPrice(sym, req.side, px, lev);
      if (sl != null && (req.side === 'long' ? sl <= liq : sl >= liq)) return { ok: false, error: `Stop loss is past the liquidation price (${liq.toFixed(this.spec(sym).digits)}) — lower the leverage or tighten the stop` };
    }
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
    tags: string[]; note: string; trailPips: number | null; beAtR: number | null; orderType: OrderType; leverage?: number;
  }): Position {
    const commission = this.fee(a.symbol, a.lots, a.entry);
    const p: Position = {
      id: this.id(), symbol: a.symbol, side: a.side, lots: a.lots, initialLots: a.lots, entry: a.entry, entryTime: a.time,
      sl: a.sl, tp: a.tp, initialSl: a.sl, commission, realized: 0, mae: 0, mfe: 0, tags: a.tags, note: a.note,
      trailPips: a.trailPips, beAtR: a.beAtR, beDone: false, orderType: a.orderType, partials: [], openedBar: a.time, slMoved: null,
    };
    if (a.leverage) {
      p.leverage = a.leverage;
      p.margin = this.marginFor(a.symbol, a.lots, a.entry, a.leverage);
      p.liq = this.liqPrice(a.symbol, a.side, a.entry, a.leverage);
    }
    this.s.balance -= commission;
    this.s.positions.push(p);
    this.onFill?.(p);
    return p;
  }

  cancelOrder(id: number) {
    this.s.orders = this.s.orders.filter((o) => o.id !== id);
  }

  /**
   * Change a pending order. Returns why the change is refused (nothing is changed then),
   * or null. An entry, stop or target that would make the order invalid is refused, the
   * same way a new order would be.
   */
  modifyOrder(id: number, patch: Partial<Pick<Order, 'price' | 'sl' | 'tp' | 'lots'>>): string | null {
    const o = this.s.orders.find((x) => x.id === id);
    if (!o) return null;
    const next = { ...o, ...patch };
    const dg = this.spec(o.symbol).digits;
    if (!(next.price > 0) || !isFinite(next.price)) return 'Enter a valid price';
    if (!(next.lots > 0)) return 'Lot size must be > 0';
    const bid = this.bid(o.symbol), ask = this.ask(o.symbol);
    const buy = o.side === 'long';
    if (next.sl != null && (buy ? next.sl >= next.price : next.sl <= next.price)) return `Stop loss must be ${buy ? 'below' : 'above'} the entry for a ${buy ? 'buy' : 'sell'}`;
    if (next.tp != null && (buy ? next.tp <= next.price : next.tp >= next.price)) return `Take profit must be ${buy ? 'above' : 'below'} the entry for a ${buy ? 'buy' : 'sell'}`;
    if (patch.price !== undefined && isFinite(bid)) {
      if (o.type === 'limit' && (buy ? next.price >= ask : next.price <= bid)) return `A ${buy ? 'buy' : 'sell'} limit must stay ${buy ? 'below' : 'above'} the current price (${(buy ? ask : bid).toFixed(dg)})`;
      if (o.type === 'stop' && (buy ? next.price <= ask : next.price >= bid)) return `A ${buy ? 'buy' : 'sell'} stop must stay ${buy ? 'above' : 'below'} the current price (${(buy ? ask : bid).toFixed(dg)})`;
    }
    Object.assign(o, patch);
    return null;
  }

  /** Why a stop or target at `price` cannot be set on this position right now, or null when it can. */
  levelError(id: number, kind: 'sl' | 'tp', price: number | null): string | null {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p || price == null) return null;
    if (!(price > 0) || !isFinite(price)) return 'Enter a valid price';
    const buy = p.side === 'long';
    const px = buy ? this.bid(p.symbol) : this.ask(p.symbol); // the price this position would close at
    if (!isFinite(px)) return null;
    const at = px.toFixed(this.spec(p.symbol).digits);
    if (kind === 'sl') {
      if (buy ? price >= px : price <= px) return `Stop loss must be ${buy ? 'below' : 'above'} the current price (${at}) for a ${buy ? 'buy' : 'sell'} — there it would close the trade on the next bar`;
      if (p.liq != null && (buy ? price <= p.liq : price >= p.liq)) return `Stop loss is past the liquidation price (${p.liq.toFixed(this.spec(p.symbol).digits)})`;
    } else if (buy ? price <= px : price >= px) return `Take profit must be ${buy ? 'above' : 'below'} the current price (${at}) for a ${buy ? 'buy' : 'sell'}`;
    return null;
  }

  /**
   * Change a position's stop, target, trail or notes. Returns why a level is refused
   * (nothing is changed then), or null.
   */
  modifyPosition(id: number, patch: { sl?: number | null; tp?: number | null; trailPips?: number | null; note?: string; tags?: string[] }): string | null {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p) return null;
    const err = (patch.sl !== undefined ? this.levelError(id, 'sl', patch.sl) : null) ?? (patch.tp !== undefined ? this.levelError(id, 'tp', patch.tp) : null);
    if (err) return err;
    if (patch.sl !== undefined) {
      if (p.initialSl == null && patch.sl != null) p.initialSl = patch.sl;
      p.sl = patch.sl;
    }
    if (patch.tp !== undefined) p.tp = patch.tp;
    if (patch.trailPips !== undefined) p.trailPips = patch.trailPips;
    if (patch.note !== undefined) p.note = patch.note;
    if (patch.tags !== undefined) p.tags = patch.tags;
    return null;
  }

  /**
   * Move the stop to the entry price. Only possible while the trade is in profit: on a
   * losing trade the entry is on the wrong side of the price and the stop would be hit
   * on the next bar. Returns the reason when refused, or null.
   */
  breakeven(id: number): string | null {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p) return null;
    const err = this.levelError(id, 'sl', p.entry);
    if (err) return `Not in profit yet: a stop at the entry (${p.entry.toFixed(this.spec(p.symbol).digits)}) would close the trade on the next bar`;
    p.sl = p.entry;
    p.slMoved = 'be';
    return null;
  }

  /**
   * Close the position and open the opposite one with the same size. When the new order
   * cannot be placed (not enough margin, trading locked) the position is still closed and
   * the reason is returned.
   */
  reverse(id: number): { ok: true; id: number } | { ok: false; error: string } {
    const p = this.s.positions.find((x) => x.id === id);
    if (!p) return { ok: false, error: 'Position not found' };
    const block = this.blocked?.();
    if (block) return { ok: false, error: block };
    const { symbol, lots, side, leverage } = p;
    this.close(id, 1, 'manual');
    const r = this.place({ symbol, side: side === 'long' ? 'short' : 'long', type: 'market', lots, leverage });
    return r.ok ? r : { ok: false, error: `Position closed, but the opposite order was refused: ${r.error}` };
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
    const comm = this.fee(p.symbol, lots, px);
    this.s.balance += gross - comm;
    if (p.margin) p.margin *= (p.lots - lots) / p.lots;
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

  /** Isolated liquidation: the whole position margin is lost (fill at the bankruptcy price). */
  private liquidate(p: Position, t: number) {
    const lev = p.leverage ?? 1;
    const px = p.side === 'long' ? p.entry * (1 - 1 / lev) : p.entry * (1 + 1 / lev);
    this.close(p.id, 1, 'liq', px, t);
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
    // 1) exits — a liquidation price acts as a stop; whichever stop is nearer to entry fires
    for (const p of [...this.s.positions]) {
      if (p.symbol !== sym || p.openedBar === t) continue;
      const liq = p.liq ?? null;
      if (p.side === 'long') {
        const liqFirst = liq != null && (p.sl == null || liq >= p.sl);
        const stop = liqFirst ? liq : p.sl;
        const hitSl = stop != null && l <= stop;
        const hitTp = p.tp != null && h >= p.tp;
        if (hitSl && (!hitTp || this.cfg.slFirst || o <= stop!)) {
          if (liqFirst) this.liquidate(p, t);
          else this.close(p.id, 1, 'sl', Math.min(stop!, o), t);
        } else if (hitTp) this.close(p.id, 1, 'tp', Math.max(p.tp!, o), t);
      } else {
        const liqFirst = liq != null && (p.sl == null || liq <= p.sl);
        const stop = liqFirst ? liq : p.sl;
        const hitSl = stop != null && h + spr >= stop;
        const hitTp = p.tp != null && l + spr <= p.tp;
        if (hitSl && (!hitTp || this.cfg.slFirst || o + spr >= stop!)) {
          if (liqFirst) this.liquidate(p, t);
          else this.close(p.id, 1, 'sl', Math.max(stop!, o + spr), t);
        } else if (hitTp) this.close(p.id, 1, 'tp', Math.min(p.tp!, o + spr), t);
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
        if (od.leverage && this.marginFor(sym, od.lots, fill, od.leverage) > this.equity() - this.usedMargin()) continue; // not enough margin left: order dropped
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
