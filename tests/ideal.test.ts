import { describe, expect, it } from 'vitest';
import { EXPLAIN } from '../src/analytics/explain';
import { IDEAL } from '../src/analytics/ideal';

describe('ideal picture for every guide', () => {
  it('covers every "How to read" entry with a caption pair and a reason', () => {
    for (const id of Object.keys(EXPLAIN)) {
      const d = IDEAL[id as keyof typeof IDEAL];
      expect(d, id).toBeTruthy();
      expect(d.good.length, id).toBeGreaterThan(3);
      expect(d.bad.length, id).toBeGreaterThan(3);
      expect(d.why.length, id).toBeGreaterThan(40);
    }
    expect(Object.keys(IDEAL).sort()).toEqual(Object.keys(EXPLAIN).sort());
  });
});
