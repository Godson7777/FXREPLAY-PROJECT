import { idb } from './store';
import type { Session } from '../engine/replay';

export const listSessions = () => idb.all<Session>('sessions').then((s) => s.sort((a, b) => b.state.updatedAt - a.state.updatedAt));
export const getSession = (id: string) => idb.get<Session>('sessions', id);
export const saveSession = (s: Session) => idb.put('sessions', s.id, JSON.parse(JSON.stringify(s)));
export async function deleteSession(id: string) {
  const s = await getSession(id);
  for (const t of s?.state.broker.trades ?? []) if (t.shot) await idb.del('shots', t.shot);
  await idb.del('sessions', id);
}
export const saveShot = (id: string, dataUrl: string) => idb.put('shots', id, dataUrl);
export const getShot = (id: string) => idb.get<string>('shots', id);
