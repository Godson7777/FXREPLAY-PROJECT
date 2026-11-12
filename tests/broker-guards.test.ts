import { describe, expect, it } from 'vitest';
import { Broker, newBrokerState, type BrokerConfig } from '../src/engine/broker';

const EUR = { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 };
const mk = (cfg: Partial<BrokerConfig> = {}, bal = 10000) => {
  const br = new Broker({ initialBalance: bal, commissionPerLot: 0, spreadPips: { '*': 1 }, slFirst: true, ...cfg }, { EURUSD: EUR }, newBrokerState(bal));
  br.setPrice('EURUSD', 0, 1.1); // bid 1.10000, ask 1.10010
  return br;
};
const open = (br: Broker, side: 'long' | 'short', sl: number | null = null, tp: number | null = null) => {
  const r = br.place({ symbol: 'EURUSD', side, type: 'market', lots: 0.1, sl, tp });
  if (!r.ok) throw new Error(r.error);
  return r.id;
};

describe('levels that would close the trade at once are refused', () => {
  it('breakeven only while the trade is in profit', () => {
    const br = mk();
    const id = open(br, 'long', 1.098);
    br.setPrice('EURUSD', 60, 1.0995); // below the entry: losing
    expect(br.breakeven(id)).toMatch(/Not in profit yet/);
    expect(br.s.positions[0].sl).toBe(1.098); // unchanged
    br.onBar('EURUSD', 120, 1.0995, 1.0996, 1.0994, 1.0995);
    expect(br.s.positions.length).toBe(1); // and still open on the next bar
    br.setPrice('EURUSD', 180, 1.102); // in profit
    expect(br.breakeven(id)).toBeNull();
    expect(br.s.positions[0].sl).toBeCloseTo(1.1001);
    expect(br.s.positions[0].slMoved).toBe('be');
  });

  it('breakeven on a short compares with the ask', () => {
    const br = mk();
    const id = open(br, 'short', 1.102);
    br.setPrice('EURUSD', 60, 1.1005); // ask 1.1006 > entry 1.1000: losing
    expect(br.breakeven(id)).toMatch(/Not in profit yet/);
    br.setPrice('EURUSD', 120, 1.098);
    expect(br.breakeven(id)).toBeNull();
  });

  it('a stop or target on the wrong side of the price is refused and nothing changes', () => {
    const br = mk();
    const long = open(br, 'long', 1.098, 1.104);
    expect(br.modifyPosition(long, { sl: 1.1005 })).toMatch(/Stop loss must be below the current price/);
    expect(br.modifyPosition(long, { tp: 1.0995 })).toMatch(/Take profit must be above the current price/);
    expect(br.s.positions[0]).toMatchObject({ sl: 1.098, tp: 1.104 });
    expect(br.modifyPosition(long, { sl: 1.099, tp: 1.105 })).toBeNull();
    expect(br.s.positions[0]).toMatchObject({ sl: 1.099, tp: 1.105 });
    expect(br.modifyPosition(long, { sl: null, tp: null })).toBeNull(); // removing a level is always allowed
    const short = open(br, 'short', 1.102, 1.096);
    expect(br.modifyPosition(short, { sl: 1.1 })).toMatch(/Stop loss must be above the current price/);
    expect(br.modifyPosition(short, { tp: 1.1005 })).toMatch(/Take profit must be below the current price/);
    expect(br.modifyPosition(short, { sl: 1.1015 })).toBeNull();
    expect(br.modifyPosition(long, { sl: NaN })).toMatch(/valid price/);
  });

  it('a pending order cannot be dragged into an invalid shape', () => {
    const br = mk();
    const r = br.place({ symbol: 'EURUSD', side: 'long', type: 'limit', lots: 0.1, price: 1.098, sl: 1.096, tp: 1.102 });
    expect(r.ok).toBe(true);
    const id = br.s.orders[0].id;
    expect(br.modifyOrder(id, { price: 1.1005 })).toMatch(/buy limit must stay below/);
    expect(br.modifyOrder(id, { sl: 1.0985 })).toMatch(/Stop loss must be below the entry/);
    expect(br.modifyOrder(id, { tp: 1.0975 })).toMatch(/Take profit must be above the entry/);
    expect(br.modifyOrder(id, { price: 1.0955 })).toMatch(/Stop loss must be below the entry/); // entry under its own stop
    expect(br.s.orders[0]).toMatchObject({ price: 1.098, sl: 1.096, tp: 1.102 });
    expect(br.modifyOrder(id, { price: 1.0975 })).toBeNull();
    expect(br.modifyOrder(id, { sl: null })).toBeNull();
    const s = br.place({ symbol: 'EURUSD', side: 'short', type: 'stop', lots: 0.1, price: 1.098 });
    expect(s.ok).toBe(true);
    expect(br.modifyOrder(br.s.orders[1].id, { price: 1.1005 })).toMatch(/sell stop must stay below/);
  });
});

describe('reverse and size guards', () => {
  it('reverse reports when the opposite order is refused', () => {
    const br = new Broker({ initialBalance: 1000, commissionPerLot: 0, spreadPips: {}, slFirst: true, leverage: 10, maxLeverage: { '*': 20 } }, { EURUSD: EUR }, newBrokerState(1000));
    br.setPrice('EURUSD', 0, 1.1);
    const r0 = br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 0.09 }); // margin 990 of 1000
    expect(r0.ok).toBe(true);
    br.setPrice('EURUSD', 60, 1.095); // −$45: equity 955, the reverse needs $985.50
    const r = br.reverse(br.s.positions[0].id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Position closed, but the opposite order was refused: Not enough margin/);
    expect(br.s.positions.length).toBe(0);
    expect(br.s.trades.length).toBe(1);
  });

  it('reverse is refused outright while trading is locked', () => {
    const br = mk();
    const id = open(br, 'long');
    br.blocked = () => 'Challenge failed: max loss';
    const r = br.reverse(id);
    expect(r).toEqual({ ok: false, error: 'Challenge failed: max loss' });
    expect(br.s.positions.length).toBe(1); // not closed
  });

  it('reverse flips the position', () => {
    const br = mk();
    const id = open(br, 'long');
    const r = br.reverse(id);
    expect(r.ok).toBe(true);
    expect(br.s.positions.length).toBe(1);
    expect(br.s.positions[0].side).toBe('short');
    expect(br.s.positions[0].lots).toBe(0.1);
  });

  it('a size that rounds to zero lots is refused', () => {
    const br = mk();
    const r = br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 0.004 });
    expect(r).toEqual({ ok: false, error: 'Lot size is below the minimum of 0.01' });
    expect(br.s.positions.length).toBe(0);
    expect(br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 0.005 }).ok).toBe(true); // rounds to 0.01
  });
});

import { quoteInfo, quoteToUsd } from '../src/engine/broker';

describe('dollar value of pairs not quoted in USD', () => {
  it('classifies symbols', () => {
    expect(quoteInfo('EURUSD').kind).toBe('usd');
    expect(quoteInfo('XAUUSD').kind).toBe('usd');
    expect(quoteInfo('BTCUSDT').kind).toBe('usd');
    expect(quoteInfo('USDJPY')).toEqual({ kind: 'inverse', ccy: 'JPY' });
    expect(quoteInfo('EURJPY')).toEqual({ kind: 'cross', ccy: 'JPY' });
    expect(quoteInfo('EUR/GBP')).toEqual({ kind: 'cross', ccy: 'GBP' });
    expect(quoteInfo('HL-BTC').kind).toBe('other');
    expect(quoteInfo('GER40').kind).toBe('other');
  });

  it('converts a cross with the session USD pair when there is one, else roughly', () => {
    const EJ = { symbol: 'EURJPY', pipSize: 0.01, contractSize: 100000, digits: 3 };
    const UJ = { symbol: 'USDJPY', pipSize: 0.01, contractSize: 100000, digits: 3 };
    const br = new Broker({ initialBalance: 10000, commissionPerLot: 0, spreadPips: {}, slFirst: true }, { EURJPY: EJ, USDJPY: UJ }, newBrokerState(10000));
    br.setPrice('EURJPY', 0, 160);
    // one lot, 100 pips (1.00 JPY) = 100,000 JPY ≈ $670 at the rough rate, not $100,000
    expect(br.value('EURJPY', 1, 1, 160)).toBeCloseTo(670, 0);
    expect(br.conversion('EURJPY')).toMatchObject({ ccy: 'JPY', exact: false });
    br.setPrice('USDJPY', 0, 150);
    expect(br.value('EURJPY', 1, 1, 160)).toBeCloseTo(100000 / 150, 4);
    expect(br.conversion('EURJPY')).toMatchObject({ ccy: 'JPY', exact: true });
    expect(br.conversion('USDJPY')).toBeNull();
    expect(quoteToUsd('USDJPY', 150)).toBeCloseTo(1 / 150);
    expect(quoteToUsd('EURUSD', 1.1)).toBe(1);
  });
});
