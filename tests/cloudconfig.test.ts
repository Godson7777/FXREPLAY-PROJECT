import { describe, expect, it } from 'vitest';
import { normalizeProjectUrl, friendlyError } from '../src/data/cloud';

describe('Supabase project URL', () => {
  const ok = 'https://abcdefghijklmnopqrst.supabase.co';
  it.each([
    [ok],
    [ok + '/'],
    [ok + '/rest/v1/'],
    [ok + '/rest/v1'],
    ['  ' + ok + '/auth/v1  '],
    ['"' + ok + '"'],
    ['abcdefghijklmnopqrst.supabase.co'],
    ['abcdefghijklmnopqrst'],
    ['https://supabase.com/dashboard/project/abcdefghijklmnopqrst/settings/api'],
  ])('normalises %s', (input) => {
    expect(normalizeProjectUrl(input)).toBe(ok);
  });
  it('explains the path error', () => {
    expect(friendlyError(new Error('Invalid path specified in request URL'))).toMatch(/xxxx\.supabase\.co/);
  });
});
