import { idb } from './store';
import type { Session } from '../engine/replay';

/**
 * A strategy groups the sessions where the same rules were traded (any symbols,
 * any periods) into one track record with one Overflow Score. Stored locally as
 * a single array in the key-value store, so no database upgrade is needed.
 */
export interface Strategy {
  id: string;
  name: string;
  author: string;
  timeframe: string;
  description: string;
  sessionIds: string[];
  /** listed on the leaderboard (once it meets the ranking rules) */
  published: boolean;
  createdAt: number;
  updatedAt: number;
}

const KEY = 'strategies';
const AUTHOR_KEY = 'overflowtrade.author';

const byUpdated = (a: Strategy, b: Strategy) => b.updatedAt - a.updatedAt;

export async function listStrategies(): Promise<Strategy[]> {
  const all = (await idb.get<Strategy[]>('kv', KEY)) ?? [];
  return all.map(sanitizeStrategy).filter((s): s is Strategy => s != null).sort(byUpdated);
}

export async function getStrategy(id: string): Promise<Strategy | null> {
  return (await listStrategies()).find((s) => s.id === id) ?? null;
}

/** Inserts or replaces a strategy (matched by id). */
export async function saveStrategy(st: Strategy): Promise<void> {
  await idb.update<Strategy[]>('kv', KEY, (cur) => {
    const list = (cur ?? []).filter((x) => x.id !== st.id);
    list.push(JSON.parse(JSON.stringify(st)) as Strategy);
    return list;
  });
}

export async function deleteStrategy(id: string): Promise<void> {
  await idb.update<Strategy[]>('kv', KEY, (cur) => (cur ?? []).filter((x) => x.id !== id));
}

/** Drops a deleted session from every strategy that referenced it. */
export async function removeSessionFromStrategies(sessionId: string): Promise<void> {
  await idb.update<Strategy[]>('kv', KEY, (cur) => {
    if (!cur?.some((s) => s.sessionIds.includes(sessionId))) return undefined;
    return cur.map((s) => (s.sessionIds.includes(sessionId) ? { ...s, sessionIds: s.sessionIds.filter((x) => x !== sessionId), updatedAt: Date.now() } : s));
  });
}

/** Restore from a backup: a strategy replaces the local copy only when it is newer. */
export async function mergeStrategies(incoming: unknown[]): Promise<number> {
  const clean = incoming.map(sanitizeStrategy).filter((s): s is Strategy => s != null);
  let merged = 0;
  await idb.update<Strategy[]>('kv', KEY, (cur) => {
    const map = new Map((cur ?? []).map((s) => [s.id, s]));
    for (const s of clean) {
      const have = map.get(s.id);
      if (!have || s.updatedAt > have.updatedAt) {
        map.set(s.id, s);
        merged++;
      }
    }
    return [...map.values()];
  });
  return merged;
}

/** Validates an unknown value (e.g. from a backup file) into a Strategy. */
export function sanitizeStrategy(x: unknown): Strategy | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string') return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return {
    id: o.id,
    name: str(o.name, 80) || 'Untitled strategy',
    author: str(o.author, 60),
    timeframe: str(o.timeframe, 40),
    description: str(o.description, 2000),
    sessionIds: Array.isArray(o.sessionIds) ? [...new Set(o.sessionIds.filter((v): v is string => typeof v === 'string'))] : [],
    published: o.published === true,
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
  };
}

/** The strategy's sessions that still exist, oldest first. */
export function strategySessions(st: Strategy, sessions: Session[]): Session[] {
  const ids = new Set(st.sessionIds);
  return sessions.filter((s) => ids.has(s.id)).sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
}

export function getAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAuthor(name: string) {
  try {
    localStorage.setItem(AUTHOR_KEY, name);
  } catch {
    /* private mode */
  }
}
