import { describe, expect, it } from 'vitest';
import { formatNumber, splitNumber } from '../src/ui/motion';

describe('count-up number parsing', () => {
  it('keeps prefix, suffix, decimals and grouping', () => {
    const p = splitNumber('+$58,416.91')!;
    expect(p).toMatchObject({ pre: '+$', post: '', value: 58416.91, decimals: 2, grouped: true });
    expect(`${p.pre}${formatNumber(p.value, p.decimals, p.grouped)}${p.post}`).toBe('+$58,416.91');
    const q = splitNumber('−7.8%')!;
    expect(q).toMatchObject({ pre: '−', post: '%', value: 7.8, decimals: 1, grouped: false });
    expect(formatNumber(q.value * 0.5, q.decimals, q.grouped)).toBe('3.9');
    expect(splitNumber('+0.09 R')!.post).toBe(' R');
    expect(splitNumber('82')).toMatchObject({ value: 82, decimals: 0 });
  });
  it('leaves text without a number alone', () => {
    expect(splitNumber('—')).toBeNull();
    expect(splitNumber('∞')).toBeNull();
  });
});
