import { describe, expect, it } from 'vitest';
import { Broker, newBrokerState } from '../src/engine/broker';
import { evaluate, markTradingDay, newChallengeState, type ChallengeRules } from '../src/engine/rules';
import { offsetFn } from '../src/core/tz';

const spec = { EURUSD: { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 } };
const utc = offsetFn('UTC');
const rules: ChallengeRules = { name: 't', profitTarget: 10, maxDailyLoss: 5, maxTotalLoss: 10, minTradingDays: 2, trailingDrawdown: false, stopOnBreach: true };
const D = 86400;

function setup(r = rules) {
  const br = new Broker({ initialBalance: 10000, commissionPerLot: 0, spreadPips: {}, slFirst: true }, spec, newBrokerState(10000));
  const st = newChallengeState(10000);
  br.onFill = (p) => markTradingDay(st, p.entryTime, utc);
  br.setPrice('EURUSD', D, 1.1);
  return { br, st, ev: (t: number) => evaluate(r, st, br, 10000, t, utc) };
}

describe('challenge rules', () => {
  it('counts a loss taken before the first bar of the session', () => {
    const { br, st, ev } = setup();
    br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1 });
    br.setPrice('EURUSD', D, 1.0945);
    br.closeAll(); // -550$ realised before any bar was checked
    expect(ev(D + 60)).toBe('failed');
    expect(st.reason).toMatch(/Daily loss/);
  });

  it('counts a loss in the first minute of a new day against that day', () => {
    const { br, st, ev } = setup();
    ev(D + 60);
    br.setPrice('EURUSD', 2 * D - 60, 1.1);
    br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1 });
    expect(ev(2 * D - 60)).toBeNull(); // 23:59, flat result so far
    br.onBar('EURUSD', 2 * D, 1.1, 1.1, 1.0945, 1.0945); // 00:00 next day: -550$ in one bar
    expect(ev(2 * D)).toBe('failed');
    expect(st.reason).toMatch(/Daily loss/);
  });

  it('fails on daily loss measured on equity (floating included)', () => {
    const { br, st, ev } = setup();
    ev(D);
    br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1 });
    br.onBar('EURUSD', D + 60, 1.1, 1.1, 1.0949, 1.0949); // -510$ floating
    expect(ev(D + 60)).toBe('failed');
    expect(st.reason).toMatch(/Daily loss/);
    expect(br.s.positions.length).toBe(0); // stop on breach closes everything
  });

  it('resets the daily reference each day and fails on total loss', () => {
    const { br, st, ev } = setup();
    const lose = (day: number, to: number) => {
      br.setPrice('EURUSD', day * D, 1.1);
      br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1 });
      br.onBar('EURUSD', day * D + 60, 1.1, 1.1, to, to);
      return ev(day * D + 60);
    };
    ev(D);
    expect(lose(1, 1.096)).toBeNull(); // -400 floating, under the 500 daily limit
    br.closeAll();
    expect(lose(2, 1.096)).toBeNull(); // new day: reference is 9600, so -400 is fine again
    br.closeAll();
    expect(br.s.balance).toBeCloseTo(9200);
    expect(lose(3, 1.0979)).toBe('failed'); // -210 today, but equity 8990 < 9000
    expect(st.reason).toMatch(/Max loss/);
  });

  it('passes only after the minimum trading days and with flat positions', () => {
    const { br, st, ev } = setup();
    ev(D);
    br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1 });
    br.onBar('EURUSD', D + 60, 1.1, 1.111, 1.1, 1.111);
    br.closeAll();
    expect(br.s.balance).toBeCloseTo(11100);
    expect(ev(D + 60)).toBeNull(); // only 1 trading day
    br.setPrice('EURUSD', 2 * D, 1.111);
    br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 0.01 });
    br.onBar('EURUSD', 2 * D + 60, 1.111, 1.111, 1.111, 1.111);
    expect(ev(2 * D + 60)).toBeNull(); // position still open
    br.closeAll();
    expect(ev(2 * D + 120)).toBe('passed');
    expect(st.tradingDays.length).toBe(2);
  });

  it('trailing drawdown follows the equity high', () => {
    const { br, ev } = setup({ ...rules, maxDailyLoss: 0, trailingDrawdown: true, profitTarget: 50 });
    ev(D);
    br.place({ symbol: 'EURUSD', side: 'long', type: 'market', lots: 1 });
    br.onBar('EURUSD', D + 60, 1.1, 1.105, 1.1, 1.105); // +500 → high 10500, floor 9500
    expect(ev(D + 60)).toBeNull();
    br.onBar('EURUSD', D + 120, 1.105, 1.105, 1.0949, 1.0949); // equity 9490
    expect(ev(D + 120)).toBe('failed');
  });
});
