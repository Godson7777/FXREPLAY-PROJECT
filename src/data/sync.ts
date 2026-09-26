import type { Bars, DatasetMeta } from '../core/types';
import type { Session } from '../engine/replay';

/**
 * Last-write-wins session sync between the local IndexedDB store and a remote.
 * `state.updatedAt` (ms) is the version. Deletions are tombstones on both sides,
 * so a session deleted on one device disappears on the others, unless it was
 * edited somewhere after the delete (then the edit wins and it comes back).
 */
export interface RemoteMeta {
  id: string;
  updatedAt: number;
  deleted: boolean;
}

export interface Remote {
  list(): Promise<RemoteMeta[]>;
  get(id: string): Promise<Session | null>;
  put(s: Session): Promise<void>;
  tombstone(id: string, at: number): Promise<void>;
}

export interface Local {
  list(): Promise<Session[]>;
  save(s: Session): Promise<void>;
  remove(id: string): Promise<void>;
  tombstones(): Promise<Record<string, number>>;
  clearTombstone(id: string): Promise<void>;
}

export interface SyncResult {
  pushed: string[];
  pulled: string[];
  removedLocal: string[];
  removedRemote: string[];
}

export async function syncSessions(local: Local, remote: Remote): Promise<SyncResult> {
  const res: SyncResult = { pushed: [], pulled: [], removedLocal: [], removedRemote: [] };
  const R = new Map((await remote.list()).map((r) => [r.id, r]));
  const L = new Map((await local.list()).map((s) => [s.id, s]));
  const T = await local.tombstones();

  const pull = async (id: string) => {
    const s = await remote.get(id);
    if (!s) return;
    await local.save(s);
    L.set(id, s);
    res.pulled.push(id);
  };

  // 1) local deletions
  for (const [id, at] of Object.entries(T)) {
    const r = R.get(id);
    if (r && !r.deleted) {
      if (r.updatedAt > at) await pull(id); // edited elsewhere after we deleted it
      else {
        await remote.tombstone(id, at);
        R.set(id, { id, updatedAt: at, deleted: true });
        res.removedRemote.push(id);
      }
    }
    await local.clearTombstone(id);
  }

  // 2) remote → local
  for (const r of R.values()) {
    const l = L.get(r.id);
    if (r.deleted) {
      if (l && l.state.updatedAt <= r.updatedAt) {
        await local.remove(r.id);
        L.delete(r.id);
        res.removedLocal.push(r.id);
      }
      continue;
    }
    if (!l || r.updatedAt > l.state.updatedAt) await pull(r.id);
  }

  // 3) local → remote
  for (const l of L.values()) {
    const r = R.get(l.id);
    if (res.pulled.includes(l.id)) continue;
    if (!r || l.state.updatedAt > r.updatedAt) {
      await remote.put(l);
      res.pushed.push(l.id);
    }
  }
  return res;
}

// ---- binary packing for market data files ---------------------------------------


/** [u32 metaLen][meta JSON][t][o][h][l][c][v] as float64, then gzip. */
export async function packDataset(meta: DatasetMeta, b: Bars): Promise<Blob> {
  const mj = new TextEncoder().encode(JSON.stringify(meta));
  const head = new Uint8Array(4 + mj.length + ((8 - ((4 + mj.length) % 8)) % 8));
  new DataView(head.buffer).setUint32(0, mj.length, true);
  head.set(mj, 4);
  const parts: BlobPart[] = [head];
  // delta-encode timestamps: gzip compresses repeated 60s steps extremely well
  const dt = new Float64Array(b.n);
  for (let i = 0; i < b.n; i++) dt[i] = i ? b.t[i] - b.t[i - 1] : b.t[0];
  for (const arr of [dt, b.o, b.h, b.l, b.c, b.v]) parts.push(arr.slice(0, b.n).buffer);
  const raw = new Blob(parts);
  return new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export async function unpackDataset(blob: Blob): Promise<{ meta: DatasetMeta; bars: Bars }> {
  const buf = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const len = new DataView(buf).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as DatasetMeta;
  let off = 4 + len + ((8 - ((4 + len) % 8)) % 8);
  const n = (buf.byteLength - off) / 8 / 6;
  const take = () => {
    const a = new Float64Array(buf.slice(off, off + n * 8));
    off += n * 8;
    return a;
  };
  const t = take();
  for (let i = 1; i < n; i++) t[i] += t[i - 1];
  const bars: Bars = { t, o: take(), h: take(), l: take(), c: take(), v: take(), n };
  return { meta, bars };
}
