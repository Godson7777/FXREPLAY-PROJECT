import { describe, expect, it } from 'vitest';
import { autoType, firstHit, flipLevels, lotsFor, orient, posCalc } from '../src/engine/position';

const env = { pipSize: 0.0001, balance: 10000, value: (d: number, lots: number) => d * lots * 100000 };
const L = { side: 'long' as const, entry: 1.1, sl: 1.098, tp: 1.105 };

describe('position tool math', () => {
  it('sizes from risk %, $ or lots', () => {
    expect(lotsFor(L, { riskMode: 'pct', risk: 1 }, env)).toBe(0.5); // $100 / ($200 per lot)
    expect(lotsFor(L, { riskMode: 'pct', risk: 2 }, env)).toBe(1);
    expect(lotsFor(L, { riskMode: 'pct', risk: 1, account: 50000 }, env)).toBe(2.5);
    expect(lotsFor(L, { riskMode: 'usd', risk: 50 }, env)).toBe(0.25);
    expect(lotsFor(L, { riskMode: 'lots', risk: 0.333 }, env)).toBe(0.33);
  });
  it('reports pips, %, money and R:R', () => {
    const c = posCalc(L, { riskMode: 'pct', risk: 1 }, env);
    expect(c.slPips).toBeCloseTo(20);
    expect(c.tpPips).toBeCloseTo(50);
    expect(c.rr).toBeCloseTo(2.5);
    expect(c.riskUsd).toBeCloseTo(100);
    expect(c.rewardUsd).toBeCloseTo(250);
    expect(c.tpPct).toBeCloseTo(0.4545, 3);
    expect(c.invalid).toBe(false);
    expect(posCalc({ ...L, side: 'short' }, { riskMode: 'pct', risk: 1 }, env).invalid).toBe(true);
  });
  it('flips and orients around the entry', () => {
    const f = flipLevels(L);
    expect(f.side).toBe('short');
    expect(f.sl).toBeCloseTo(1.102);
    expect(f.tp).toBeCloseTo(1.095);
    expect(flipLevels(f).sl).toBeCloseTo(L.sl);
    const o = orient('short', 1.2, 0.001, 0.003);
    expect(o.sl).toBeCloseTo(1.201);
    expect(o.tp).toBeCloseTo(1.197);
  });
  it('finds the first level touched, never past the clock', () => {
    const bars = [{ h: 1.101, l: 1.099 }, { h: 1.106, l: 1.1 }, { h: 1.1, l: 1.09 }];
    const bar = (n: number) => (i: number) => (i < n ? bars[i] : null);
    expect(firstHit(L, 0, 2, bar(3))).toEqual({ kind: 'tp', index: 1 });
    expect(firstHit(L, 0, 2, bar(1))).toBeNull(); // bar 1 not revealed yet
    expect(firstHit({ ...L, tp: 1.2 }, 0, 2, bar(3))).toEqual({ kind: 'sl', index: 2 });
    expect(firstHit({ ...L, sl: 1.0995, tp: 1.1005 }, 0, 2, bar(3))).toEqual({ kind: 'sl', index: 0 }); // both in one bar → stop
  });
  it('picks market, limit or stop', () => {
    expect(autoType('long', 1.1, 1.0999, 1.1, 0.00005)).toBe('market');
    expect(autoType('long', 1.09, 1.0999, 1.1, 0.00005)).toBe('limit');
    expect(autoType('long', 1.11, 1.0999, 1.1, 0.00005)).toBe('stop');
    expect(autoType('short', 1.11, 1.0999, 1.1, 0.00005)).toBe('limit');
    expect(autoType('short', 1.09, 1.0999, 1.1, 0.00005)).toBe('stop');
  });
});
