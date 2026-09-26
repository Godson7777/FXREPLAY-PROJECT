import { idb } from './store';
import type { Session } from '../engine/replay';
import { fetchShot, recordDeletion, scheduleSync } from './cloud';

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
}
export const saveShot = (id: string, dataUrl: string) => idb.put('shots', id, dataUrl);
export async function getShot(id: string) {
  return (await idb.get<string>('shots', id)) ?? (await fetchShot(id));
}
