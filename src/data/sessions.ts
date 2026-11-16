import { idb } from './store';
import type { Session } from '../engine/replay';
import type { RegimeTag } from '../analytics/regime';
import { fetchShot, recordDeletion, scheduleSync } from './cloud';
import { removeSessionFromStrategies } from './strategies';

/** The least a stored session must have for every page to open (a hand-edited or cut-off backup may not). */
export function isSession(x: unknown): x is Session {
  const s = x as Session | null;
  const b = s?.state?.broker;
  return (
    !!s &&
    typeof s.id === 'string' &&
    !!s.id &&
    typeof s.name === 'string' &&
    Array.isArray(s.symbols) &&
    s.symbols.every((y) => typeof y === 'string') &&
    isFinite(s.balance) &&
    s.balance > 0 &&
    isFinite(s.start) &&
    !!s.state &&
    isFinite(s.state.updatedAt) &&
    isFinite(s.state.clock) &&
    !!b &&
    isFinite(b.balance) &&
    Array.isArray(b.trades) &&
    Array.isArray(b.positions) &&
    Array.isArray(b.orders) &&
    b.trades.every((t) => !!t && isFinite(t.pnl) && isFinite(t.entryTime) && isFinite(t.exitTime) && typeof t.symbol === 'string')
  );
}

/** Every stored session, newest first. A damaged record is left out: one bad entry must not take the whole app down. */
export const listSessions = () =>
  idb.all<Session>('sessions').then((s) => s.filter(readable).sort((a, b) => (b.state.updatedAt || 0) - (a.state.updatedAt || 0)));
/** Enough of a session for the list pages to draw it (looser than `isSession`, so nothing a page can show is hidden). */
const readable = (s: Session | null | undefined): s is Session =>
  !!s && typeof s.id === 'string' && Array.isArray(s.symbols) && !!s.state?.broker && Array.isArray(s.state.broker.trades) && isFinite(s.balance);
export const getSession = (id: string) => idb.get<Session>('sessions', id);
export async function saveSession(s: Session) {
  await idb.put('sessions', s.id, JSON.parse(JSON.stringify(s)));
  scheduleSync();
}
/** What the replay itself changes: if this differs, the session was played somewhere else. */
const replaySig = (s: Session) => {
  const b = s.state.broker;
  return `${s.state.clock}:${b.trades.length}:${b.positions.length}:${b.orders.length}:${b.balance}`;
};

/** What a tab knows about the stored session: the versions it read or wrote, and the replay it last wrote. */
export interface SavedState {
  versions: number[];
  sig: string;
}
export const savedStateOf = (s: Session): SavedState => ({ versions: [s.state.updatedAt], sig: replaySig(s) });

/**
 * Save from an open replay without destroying work saved elsewhere in the meantime.
 * One transaction:
 *  - the stored copy is one this tab read or wrote itself → save;
 *  - it is someone else's, but the replay did not move (the analytics page in another tab
 *    saved a journal entry) → those fields are taken over, then save;
 *  - it is someone else's and the replay moved (the session is being played in another tab,
 *    was restored from a backup or synced from another device) → nothing is written and
 *    'conflict' is returned.
 * `journalDirty` lists the trades whose journal was edited in this tab since its last save.
 */
export async function saveReplaySession(s: Session, known: SavedState, journalDirty: Set<number>): Promise<'saved' | 'conflict' | 'deleted'> {
  let out: 'saved' | 'conflict' | 'deleted' = 'saved';
  await idb.update<Session>('sessions', s.id, (cur) => {
    if (!cur) {
      out = 'deleted';
      return undefined;
    }
    if (!known.versions.includes(cur.state.updatedAt)) {
      if (replaySig(cur) !== known.sig) {
        out = 'conflict';
        return undefined;
      }
      const theirs = new Map(cur.state.broker.trades.map((t) => [t.id, t]));
      for (const t of s.state.broker.trades) {
        const c = theirs.get(t.id);
        if (!c) continue;
        if (!journalDirty.has(t.id)) {
          t.tags = c.tags ?? [];
          t.note = c.note ?? '';
          t.rating = c.rating;
        }
        if (t.regime === undefined && c.regime !== undefined) t.regime = c.regime;
      }
    }
    s.state.updatedAt = Math.max(Date.now(), cur.state.updatedAt + 1);
    known.versions = [...known.versions.slice(-20), s.state.updatedAt];
    known.sig = replaySig(s);
    return JSON.parse(JSON.stringify(s)) as Session;
  });
  if (out === 'saved') scheduleSync();
  return out;
}

export async function deleteSession(id: string) {
  const s = await getSession(id);
  for (const t of s?.state.broker.trades ?? []) if (t.shot) await idb.del('shots', t.shot);
  await idb.del('sessions', id);
  await recordDeletion(id);
  await removeSessionFromStrategies(id);
}

/**
 * Stores market-regime tags on a session's trades. Runs as one read-modify-write
 * transaction and only fills trades that have no tag yet, so it never overwrites
 * newer changes saved meanwhile (e.g. by a replay open in another tab). The
 * session version (`updatedAt`) is left alone: tags are derived data.
 */
export async function patchRegimes(id: string, tags: Map<number, RegimeTag | null>) {
  await idb.update<Session>('sessions', id, (s) => {
    if (!s) return undefined;
    let changed = false;
    for (const t of s.state.broker.trades) {
      if (t.regime === undefined && tags.has(t.id)) {
        t.regime = tags.get(t.id) ?? null;
        changed = true;
      }
    }
    return changed ? s : undefined;
  });
}

/** Saves a trade's journal fields (one transaction) and returns the new session version. */
export async function patchTradeJournal(id: string, tradeId: number, j: { tags: string[]; note: string; rating?: number }): Promise<number | null> {
  let at: number | null = null;
  await idb.update<Session>('sessions', id, (s) => {
    const t = s?.state.broker.trades.find((x) => x.id === tradeId);
    if (!s || !t) return undefined;
    t.tags = j.tags;
    t.note = j.note;
    t.rating = j.rating;
    at = Date.now();
    s.state.updatedAt = at;
    return s;
  });
  if (at) scheduleSync();
  return at;
}

export const saveShot = (id: string, dataUrl: string) => idb.put('shots', id, dataUrl);
export async function getShot(id: string) {
  return (await idb.get<string>('shots', id)) ?? (await fetchShot(id));
}
