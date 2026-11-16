import { listDatasets } from '../../data/store';
import { listSessions, saveSession, isSession } from '../../data/sessions';
import type { Session } from '../../engine/replay';
import { idb } from '../../data/store';
import { listStrategies, mergeStrategies } from '../../data/strategies';
import { h, toast, download } from '../dom';

// ---- backup / restore --------------------------------------------------------

export async function exportBackup(sessions: Session[]) {
  const shots: Record<string, string> = {};
  for (const s of sessions)
    for (const t of s.state.broker.trades)
      if (t.shot) {
        const u = await idb.get<string>('shots', t.shot);
        if (u) shots[t.shot] = u;
      }
  const strategies = await listStrategies();
  const payload = { app: 'overflowtrade', version: 2, exportedAt: new Date().toISOString(), sessions, strategies, shots };
  download(`overflowtrade-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload), 'application/json');
  toast(
    `Backed up ${sessions.length} session${sessions.length === 1 ? '' : 's'} and ${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'}`,
    'ok',
  );
}

export function importBackup(done: () => void) {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as { app?: string; sessions?: Session[]; strategies?: unknown[]; shots?: Record<string, string> };
      if (!['overflowtrade', 'replaylab'].includes(data.app ?? '') || !Array.isArray(data.sessions)) throw new Error('Not an Overflow Trade backup file');
      const good = data.sessions.filter(isSession);
      const damaged = data.sessions.length - good.length;
      if (!good.length && data.sessions.length) throw new Error('This backup holds no readable sessions');
      // a backup is a snapshot: a session that was continued since then is newer on this device
      const local = new Map((await listSessions()).map((s) => [s.id, s]));
      const older = good.filter((s) => (local.get(s.id)?.state.updatedAt ?? 0) > s.state.updatedAt);
      const replaceNewer =
        older.length > 0 &&
        confirm(
          `${older.length} session${older.length === 1 ? '' : 's'} in this backup ${older.length === 1 ? 'is' : 'are'} older than the copy on this device:\n\n${older
            .slice(0, 8)
            .map((s) => `• ${s.name} (${s.state.broker.trades.length} trades in the backup, ${local.get(s.id)!.state.broker.trades.length} on this device)`)
            .join('\n')}${older.length > 8 ? '\n…' : ''}\n\nOK = go back to the backup copy.\nCancel = keep the newer copy on this device.`,
        );
      const take = good.filter((s) => replaceNewer || !older.includes(s));
      for (const [k, v] of Object.entries(data.shots ?? {})) if (typeof v === 'string') await idb.put('shots', k, v);
      for (const s of take) await saveSession(s);
      const nStrat = Array.isArray(data.strategies) ? await mergeStrategies(data.strategies) : 0;
      const missing = [...new Set(take.flatMap((s) => s.symbols))];
      const have = new Set((await listDatasets()).map((d) => d.id));
      const need = missing.filter((m) => !have.has(m));
      const kept = good.length - take.length;
      toast(
        `Restored ${take.length} session${take.length === 1 ? '' : 's'}${nStrat ? ` and ${nStrat} strateg${nStrat === 1 ? 'y' : 'ies'}` : ''}` +
          (kept ? ` — kept ${kept} newer cop${kept === 1 ? 'y' : 'ies'} on this device` : '') +
          (damaged ? ` — skipped ${damaged} damaged entr${damaged === 1 ? 'y' : 'ies'}` : '') +
          (need.length ? ` — import data for ${need.join(', ')} to open them` : ''),
        need.length || damaged ? 'info' : 'ok',
      );
      done();
    } catch (e) {
      toast(String((e as Error).message ?? e), 'err');
    }
  };
  input.click();
}
