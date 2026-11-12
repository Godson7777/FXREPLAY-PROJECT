import { describe, expect, it } from 'vitest';
import { Broker, newBrokerState, type BrokerConfig } from '../src/engine/broker';
import { rng } from '../src/data/synthetic';

/**
 * Random sequences of everything a trader can do, on random prices. Whatever happens,
 * the books must add up after every single step.
 */
const EUR = { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 };
const BTC = { symbol: 'BTC', pipSize: 1, contractSize: 1, digits: 1 };

function run(seed: number, cfg: Partial<BrokerConfig>, sym: 'EURUSD' | 'BTC', steps = 1500) {
  const rand = rng(seed);
  const spec = sym === 'BTC' ? BTC : EUR;
  const start = 10000;
  const br = new Broker({ initialBalance: start, commissionPerLot: sym === 'BTC' ? 0 : 3.5, spreadPips: { '*': sym === 'BTC' ? 0 : 0.8 }, slFirst: rand() < 0.5, ...cfg }, { [sym]: spec }, newBrokerState(start));
  let px = sym === 'BTC' ? 60000 : 1.1;
  const pip = spec.pipSize, vol = sym === 'BTC' ? 60 : 0.0006;
  let t = 0;
  br.setPrice(sym, t, px);
  let seen = 0, closed = 0;
  const ids = new Set<number>();
  const check = (what: string) => {
    const s = br.s;
    for (; seen < s.trades.length; seen++) {
      const x = s.trades[seen];
      closed += x.pnl;
      if (!(isFinite(x.pnl) && isFinite(x.exit) && x.lots > 0)) throw new Error(`${what}: bad trade #${x.id}`);
      if (x.exitTime < x.entryTime) throw new Error(`${what}: trade #${x.id} exits before it enters`);
      if (x.r != null && !isFinite(x.r)) throw new Error(`${what}: R of #${x.id}`);
      if (ids.has(x.id)) throw new Error(`${what}: duplicate trade id ${x.id}`);
      ids.add(x.id);
    }
    const booked = s.positions.reduce((a, p) => a + p.realized - p.commission, 0);
    expect(s.balance, `${what}: balance`).toBeCloseTo(start + closed + booked, 6);
    expect(br.equity(), `${what}: equity`).toBeCloseTo(s.balance + s.positions.reduce((a, p) => a + br.floating(p), 0), 6);
    for (const p of s.positions) {
      expect(p.lots, `${what}: lots`).toBeGreaterThan(0);
      expect(isFinite(p.entry) && p.entry > 0, `${what}: entry`).toBe(true);
      if (p.margin != null) expect(p.margin, `${what}: margin`).toBeGreaterThanOrEqual(0);
    }
    for (const p of s.positions) if (ids.has(p.id)) throw new Error(`${what}: open position reuses closed id ${p.id}`);
    expect(isFinite(s.balance), `${what}: finite balance`).toBe(true);
  };
  for (let i = 0; i < steps; i++) {
    const a = rand();
    const bid = br.bid(sym), ask = br.ask(sym);
    const side = rand() < 0.5 ? 'long' : 'short';
    const d = side === 'long' ? 1 : -1;
    const dist = (5 + rand() * 40) * pip * (sym === 'BTC' ? 10 : 1);
    const lots = sym === 'BTC' ? +(0.01 + rand() * 0.05).toFixed(2) : +(0.01 + rand() * 0.3).toFixed(2);
    if (a < 0.2) {
      const e = side === 'long' ? ask : bid;
      br.place({ symbol: sym, side, type: 'market', lots, sl: rand() < 0.8 ? e - d * dist : null, tp: rand() < 0.7 ? e + d * dist * 2 : null, trailPips: rand() < 0.15 ? 15 : null, beAtR: rand() < 0.15 ? 1 : null });
    } else if (a < 0.3) {
      const type = rand() < 0.5 ? 'limit' : 'stop';
      const off = dist * (type === 'limit' ? -d : d);
      const price = (side === 'long' ? ask : bid) + off;
      br.place({ symbol: sym, side, type, lots, price, sl: price - d * dist, tp: rand() < 0.5 ? price + d * dist * 1.5 : null });
    } else if (a < 0.36 && br.s.positions.length) {
      const p = br.s.positions[Math.floor(rand() * br.s.positions.length)];
      br.close(p.id, rand() < 0.5 ? 0.5 : 1);
    } else if (a < 0.4 && br.s.positions.length) {
      br.breakeven(br.s.positions[0].id);
    } else if (a < 0.44 && br.s.positions.length) {
      br.reverse(br.s.positions[br.s.positions.length - 1].id);
    } else if (a < 0.5 && br.s.positions.length) {
      const p = br.s.positions[Math.floor(rand() * br.s.positions.length)];
      br.modifyPosition(p.id, { sl: bid + (rand() - 0.5) * dist * 3, tp: rand() < 0.3 ? null : bid + (rand() - 0.5) * dist * 4 });
    } else if (a < 0.54 && br.s.orders.length) {
      const o = br.s.orders[0];
      if (rand() < 0.5) br.cancelOrder(o.id);
      else br.modifyOrder(o.id, { price: o.price + (rand() - 0.5) * dist });
    } else if (a < 0.56) br.closeAll();
    else {
      // a bar, sometimes with a gap
      const o = px + (rand() < 0.05 ? (rand() - 0.5) * vol * 12 : 0);
      const c = o + (rand() - 0.5) * vol * 2;
      const hi = Math.max(o, c) + rand() * vol, lo = Math.min(o, c) - rand() * vol;
      t += 60;
      br.onBar(sym, t, o, hi, Math.max(lo, pip), Math.max(c, pip));
      px = Math.max(c, pip * 10);
    }
    check(`seed ${seed} step ${i}`);
  }
  // a level the broker accepted never sits on the wrong side of the price it was accepted at
  br.closeAll();
  check(`seed ${seed} end`);
  expect(br.s.positions.length).toBe(0);
  return br.s.trades.length;
}

describe('order engine under random use', () => {
  it('keeps the books straight on an unleveraged FX account (20 seeds)', () => {
    let trades = 0;
    for (let seed = 1; seed <= 20; seed++) trades += run(seed, {}, 'EURUSD');
    expect(trades).toBeGreaterThan(500);
  }, 120000);

  it('keeps the books straight with leverage, fees and liquidations (20 seeds)', () => {
    let trades = 0;
    for (let seed = 101; seed <= 120; seed++) trades += run(seed, { leverage: 20, maxLeverage: { BTC: 40 }, feePct: 0.045 }, 'BTC');
    expect(trades).toBeGreaterThan(300);
  }, 120000);
});
