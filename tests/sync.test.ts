import { describe, expect, it } from 'vitest';
import { syncSessions, packDataset, unpackDataset, type Local, type Remote, type RemoteMeta } from '../src/data/sync';
import type { Session } from '../src/engine/replay';
import { generateSynthetic } from '../src/data/synthetic';
import { guessSpec } from '../src/core/types';

const sess = (id: string, updatedAt: number, name = id) => ({ id, name, state: { updatedAt } }) as unknown as Session;

function fakeRemote(init: { s: Session; deleted?: boolean }[] = []) {
  const rows = new Map<string, { s: Session | null; updatedAt: number; deleted: boolean }>();
  for (const r of init) rows.set(r.s.id, { s: r.s, updatedAt: r.s.state.updatedAt, deleted: !!r.deleted });
  const remote: Remote = {
    list: async () => [...rows.entries()].map(([id, r]): RemoteMeta => ({ id, updatedAt: r.updatedAt, deleted: r.deleted })),
    get: async (id) => rows.get(id)?.s ?? null,
    put: async (s) => void rows.set(s.id, { s: structuredClone(s), updatedAt: s.state.updatedAt, deleted: false }),
    tombstone: async (id, at) => void rows.set(id, { s: null, updatedAt: at, deleted: true }),
  };
  return { remote, rows };
}

function fakeLocal(init: Session[] = [], tomb: Record<string, number> = {}) {
  const m = new Map(init.map((s) => [s.id, s]));
  const t = { ...tomb };
  const local: Local = {
    list: async () => [...m.values()],
    save: async (s) => void m.set(s.id, s),
    remove: async (id) => void m.delete(id),
    tombstones: async () => ({ ...t }),
    clearTombstone: async (id) => void delete t[id],
  };
  return { local, m, t };
}

describe('session sync', () => {
  it('pushes new local sessions and pulls new remote ones', async () => {
    const L = fakeLocal([sess('a', 10)]);
    const R = fakeRemote([{ s: sess('b', 20) }]);
    const r = await syncSessions(L.local, R.remote);
    expect(r.pushed).toEqual(['a']);
    expect(r.pulled).toEqual(['b']);
    expect([...L.m.keys()].sort()).toEqual(['a', 'b']);
    expect([...R.rows.keys()].sort()).toEqual(['a', 'b']);
  });

  it('last write wins in both directions', async () => {
    const L = fakeLocal([sess('a', 30, 'local-new'), sess('b', 10, 'local-old')]);
    const R = fakeRemote([{ s: sess('a', 20, 'remote-old') }, { s: sess('b', 40, 'remote-new') }]);
    const r = await syncSessions(L.local, R.remote);
    expect(r.pushed).toEqual(['a']);
    expect(r.pulled).toEqual(['b']);
    expect(R.rows.get('a')!.s!.name).toBe('local-new');
    expect(L.m.get('b')!.name).toBe('remote-new');
    // second sync is a no-op
    const r2 = await syncSessions(L.local, R.remote);
    expect(r2).toEqual({ pushed: [], pulled: [], removedLocal: [], removedRemote: [] });
  });

  it('propagates deletions via tombstones', async () => {
    const L = fakeLocal([], { a: 50 });
    const R = fakeRemote([{ s: sess('a', 40) }]);
    const r = await syncSessions(L.local, R.remote);
    expect(r.removedRemote).toEqual(['a']);
    expect(R.rows.get('a')!.deleted).toBe(true);
    // another device that still has it removes it locally
    const L2 = fakeLocal([sess('a', 40)]);
    const r2 = await syncSessions(L2.local, R.remote);
    expect(r2.removedLocal).toEqual(['a']);
    expect(L2.m.size).toBe(0);
  });

  it('an edit made after a deletion resurrects the session', async () => {
    const L = fakeLocal([], { a: 50 });
    const R = fakeRemote([{ s: sess('a', 60, 'edited-later') }]);
    const r = await syncSessions(L.local, R.remote);
    expect(r.pulled).toEqual(['a']);
    expect(L.m.get('a')!.name).toBe('edited-later');
    expect(L.t).toEqual({});
  });
});

describe('dataset packing', () => {
  it('round-trips bars through gzip', async () => {
    const bars = generateSynthetic({ start: Date.UTC(2024, 0, 1) / 1000, days: 10, price: 1.1, seed: 3 });
    const meta = { id: 'EURUSD', symbol: 'EURUSD', source: 'synthetic' as const, resolution: 60, from: bars.t[0], to: bars.t[bars.n - 1], count: bars.n, spec: guessSpec('EURUSD', 1.1), createdAt: 1 };
    const blob = await packDataset(meta, bars);
    expect(blob.size).toBeLessThan(bars.n * 48 * 0.8);
    const back = await unpackDataset(blob);
    expect(back.meta.symbol).toBe('EURUSD');
    expect(back.bars.n).toBe(bars.n);
    for (const i of [0, 1, 500, bars.n - 1]) {
      expect(back.bars.t[i]).toBe(bars.t[i]);
      expect(back.bars.c[i]).toBe(bars.c[i]);
      expect(back.bars.v[i]).toBe(bars.v[i]);
    }
  });
});
