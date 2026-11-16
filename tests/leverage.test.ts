import { describe, expect, it } from 'vitest';
import { Broker, newBrokerState, type BrokerConfig } from '../src/engine/broker';

const BTC = { symbol: 'BTC', pipSize: 1, contractSize: 1, digits: 1 };
const mk = (cfg: Partial<BrokerConfig> = {}, bal = 10000) => {
  const br = new Broker(
    { initialBalance: bal, commissionPerLot: 0, spreadPips: {}, slFirst: true, leverage: 10, maxLeverage: { BTC: 40 }, ...cfg },
    { BTC },
    newBrokerState(bal),
  );
  br.setPrice('BTC', 0, 100000);
  return br;
};

describe('leverage & isolated margin', () => {
  it('computes margin and liquidation price', () => {
    const br = mk();
    const r = br.place({ symbol: 'BTC', side: 'long', type: 'market', lots: 0.5 });
    expect(r.ok).toBe(true);
    const p = br.s.positions[0];
    expect(p.leverage).toBe(10);
    expect(p.margin).toBeCloseTo(5000);
    // 1/10 − 1/80 = 0.0875 below entry
    expect(p.liq).toBeCloseTo(100000 * (1 - 0.0875));
    expect(br.freeMargin()).toBeCloseTo(5000);
  });

  it('rejects orders that need more margin than is free', () => {
    const br = mk();
    const r = br.place({ symbol: 'BTC', side: 'long', type: 'market', lots: 1.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Not enough margin: needs \$15000\.00, free \$10000\.00 at 10×/);
  });

  it('clamps leverage to the symbol maximum', () => {
    const br = mk();
    br.place({ symbol: 'BTC', side: 'short', type: 'market', lots: 0.1, leverage: 100 });
    expect(br.s.positions[0].leverage).toBe(40);
  });

  it('liquidates and loses the whole margin', () => {
    const br = mk();
    br.place({ symbol: 'BTC', side: 'long', type: 'market', lots: 0.5 });
    br.onBar('BTC', 60, 99000, 99500, 90000, 91000);
    expect(br.s.positions.length).toBe(0);
    const t = br.s.trades[0];
    expect(t.exitReason).toBe('liq');
    expect(t.pnl).toBeCloseTo(-5000);
    expect(br.s.balance).toBeCloseTo(5000);
  });

  it('a stop nearer than the liquidation price fires first', () => {
    const br = mk();
    br.place({ symbol: 'BTC', side: 'short', type: 'market', lots: 0.5, sl: 102000 });
    br.onBar('BTC', 60, 100500, 115000, 100000, 112000);
    expect(br.s.trades[0].exitReason).toBe('sl');
    expect(br.s.trades[0].pnl).toBeCloseTo(-1000);
  });

  it('refuses a stop beyond the liquidation price', () => {
    const br = mk();
    const r = br.place({ symbol: 'BTC', side: 'long', type: 'market', lots: 0.1, sl: 80000 });
    expect(r.ok).toBe(false);
  });

  it('charges a % of notional fee on both sides', () => {
    const br = mk({ feePct: 0.05 });
    br.place({ symbol: 'BTC', side: 'long', type: 'market', lots: 0.1 });
    br.setPrice('BTC', 60, 110000);
    br.close(br.s.positions[0].id);
    const t = br.s.trades[0];
    expect(t.commission).toBeCloseTo(5 + 5.5);
    expect(t.pnl).toBeCloseTo(1000 - 10.5);
  });

  it('halves the margin on a half close', () => {
    const br = mk();
    br.place({ symbol: 'BTC', side: 'long', type: 'market', lots: 0.5 });
    br.close(br.s.positions[0].id, 0.5);
    expect(br.s.positions[0].margin).toBeCloseTo(2500);
  });

  it('leaves unleveraged accounts unchanged', () => {
    const br = mk({ leverage: undefined });
    expect(br.place({ symbol: 'BTC', side: 'long', type: 'market', lots: 5 }).ok).toBe(true);
    const p = br.s.positions[0];
    expect(p.leverage).toBeUndefined();
    expect(p.liq).toBeUndefined();
    br.onBar('BTC', 60, 99000, 99500, 50000, 60000);
    expect(br.s.positions.length).toBe(1);
  });

  it('a full-size position cannot leave the account below zero when it is liquidated', () => {
    const EUR = { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 };
    const br = new Broker(
      { initialBalance: 10000, commissionPerLot: 3.5, spreadPips: { '*': 0 }, slFirst: true, leverage: 500 },
      { EURUSD: EUR },
      newBrokerState(10000),
    );
    br.setPrice('EURUSD', 0, 1.1);
    // 45.45 lots need $9,999 of margin and $159 in commission: more than the account holds
    const all = br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 45.45 });
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.error).toMatch(/plus \$159\.\d\d in fees/);
    const most = +(/most you can open is ([\d.]+)/.exec(all.ok ? '' : all.error)?.[1] ?? 0);
    expect(most).toBeGreaterThan(40);
    expect(br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: most }).ok).toBe(true);
    const p = br.s.positions[0];
    const margin = p.margin!;
    expect(br.s.balance).toBeGreaterThanOrEqual(margin);
    br.onBar('EURUSD', 60, 1.1, 1.1, 1.09, 1.09); // far through the liquidation price
    expect(br.s.positions.length).toBe(0);
    expect(br.s.trades[0].exitReason).toBe('liq');
    expect(br.s.balance).toBeGreaterThanOrEqual(0);
    // lost: the margin and the entry commission, nothing on top
    expect(-br.s.trades[0].pnl).toBeCloseTo(margin + 3.5 * most, 1);
  });
});
