import { describe, expect, it } from 'vitest';
import { niceTicks } from '../src/ui/charts';

describe('axis ticks', () => {
  it('gives round ticks', () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(9800, 10250).length).toBeGreaterThan(2);
  });
  it('never hangs on a flat or float-noise range', () => {
    const t0 = performance.now();
    const t = niceTicks(10000, 10000 + 1e-11);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(t.length).toBeGreaterThan(1);
    expect(t.length).toBeLessThan(20);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
    expect(niceTicks(10, 0)).toEqual([0, 2, 4, 6, 8, 10]);
  });
});
