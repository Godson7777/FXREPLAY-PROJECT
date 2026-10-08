import { idb } from './store';
import type { Session } from '../engine/replay';
import type { RegimeTag } from '../analytics/regime';
import { fetchShot, recordDeletion, scheduleSync } from './cloud';
import { removeSessionFromStrategies } from './strategies';

export const listSessions = () => idb.all<Session>('sessions').then((s) => s.sort((a, b) => b.state.updatedAt - a.state.updatedAt));
export const getSession = (id: string) => idb.get<Session>('sessions', id);
export async function saveSession(s: Session) {
  await idb.put('sessions', s.id, JSON.parse(JSON.stringify(s)));
  scheduleSync();
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
