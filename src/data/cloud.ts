import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Session } from '../engine/replay';
import type { DatasetMeta } from '../core/types';
import { idb, listDatasets, loadBars, saveDataset } from './store';
import { syncSessions, packDataset, unpackDataset, type Local, type Remote, type SyncResult } from './sync';

/**
 * Optional cloud layer (Supabase). Without configuration the app is fully
 * local. Config comes from build-time env vars or is pasted in the app.
 */
export interface CloudConfig {
  url: string;
  key: string;
}

const CFG_KEY = 'overflowtrade.cloud';

/**
 * Supabase wants the bare project origin. People often paste the Data API URL
 * (".../rest/v1/"), a dashboard link or just the project ref; accept all of them.
 */
export function normalizeProjectUrl(raw: string): string {
  const s = raw.trim().replace(/^["']|["']$/g, '');
  if (/^[a-z0-9]{15,30}$/.test(s)) return `https://${s}.supabase.co`;
  const dash = /supabase\.com\/dashboard\/project\/([a-z0-9]+)/.exec(s);
  if (dash) return `https://${dash[1]}.supabase.co`;
  try {
    return new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).origin;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

const cleanKey = (k: string) => k.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');

export function cloudConfig(): CloudConfig | null {
  const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (envUrl?.trim() && envKey?.trim()) return { url: normalizeProjectUrl(envUrl), key: cleanKey(envKey) };
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null') as CloudConfig | null;
    return c?.url && c?.key ? { url: normalizeProjectUrl(c.url), key: cleanKey(c.key) } : null;
  } catch {
    return null;
  }
}

export function configFromEnv() {
  return !!(import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
}

/** Turn raw Supabase/network errors into something a trader can act on. */
export function friendlyError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/Invalid path specified/i.test(m)) return 'The Supabase Project URL is wrong — it must look like https://xxxx.supabase.co (nothing after .co).';
  if (/Invalid API key|No API key|invalid.*jwt/i.test(m)) return 'The Supabase key is not accepted — use the Publishable key (sb_publishable_…) or the legacy anon key, never the secret key.';
  if (/Invalid login credentials/i.test(m)) return 'Wrong email or password. No account yet? Use "Create one".';
  if (/Email not confirmed/i.test(m)) return 'Confirm your email first (check your inbox and spam folder), then sign in.';
  if (/rate limit/i.test(m)) return 'Too many emails sent — Supabase\'s built-in mailer is limited. Wait a bit, or turn off "Confirm email" / add your own SMTP in Supabase.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach Supabase — check your internet connection and the Project URL.';
  if (/relation .* does not exist|Could not find the table/i.test(m)) return 'Database tables are missing — run supabase/schema.sql in the Supabase SQL Editor.';
  return m;
}

export function setCloudConfig(c: CloudConfig | null) {
  if (c) localStorage.setItem(CFG_KEY, JSON.stringify({ url: normalizeProjectUrl(c.url), key: cleanKey(c.key) }));
  else localStorage.removeItem(CFG_KEY);
  client = null;
}

let client: SupabaseClient | null = null;
export function sb(): SupabaseClient | null {
  if (client) return client;
  const c = cloudConfig();
  if (!c) return null;
  client = createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true } });
  client.auth.onAuthStateChange((_e, s) => {
    user = s?.user ?? null;
    emit();
  });
  return client;
}

// ---- auth & status ---------------------------------------------------------------

let user: User | null = null;
export type SyncStatus = 'off' | 'signed-out' | 'idle' | 'syncing' | 'error';
let status: SyncStatus = 'off';
let lastError = '';
let lastSync = 0;
let lastChanged = 0; // time of the last sync that changed local data
const listeners = new Set<() => void>();
function emit() {
  if (!cloudConfig()) status = 'off';
  else if (!user) status = 'signed-out';
  else if (status === 'off' || status === 'signed-out') status = 'idle';
  listeners.forEach((l) => l());
}
export function onCloudChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const cloudState = () => ({ status, user, lastError, lastSync, lastChanged, configured: !!cloudConfig() });

export async function initCloud() {
  const c = sb();
  if (!c) return emit();
  const { data } = await c.auth.getSession();
  user = data.session?.user ?? null;
  emit();
  if (user) void syncNow();
}

export async function signIn(email: string, password: string) {
  const c = sb();
  if (!c) throw new Error('Cloud is not configured');
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  user = data.user;
  emit();
  void syncNow();
}

export async function signUp(email: string, password: string): Promise<'signed-in' | 'confirm-email'> {
  const c = sb();
  if (!c) throw new Error('Cloud is not configured');
  const { data, error } = await c.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw error;
  if (data.session) {
    user = data.user;
    emit();
    void syncNow();
    return 'signed-in';
  }
  return 'confirm-email';
}

export async function resetPassword(email: string) {
  const c = sb();
  if (!c) throw new Error('Cloud is not configured');
  const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw error;
}

export async function signOut() {
  await sb()?.auth.signOut();
  user = null;
  emit();
}

// ---- sessions --------------------------------------------------------------------

function remote(c: SupabaseClient): Remote {
  return {
    async list() {
      const { data, error } = await c.from('sessions').select('id, updated_at, deleted');
      if (error) throw error;
      return (data ?? []).map((r) => ({ id: r.id as string, updatedAt: Number(r.updated_at), deleted: !!r.deleted }));
    },
    async get(id) {
      const { data, error } = await c.from('sessions').select('data').eq('id', id).maybeSingle();
      if (error) throw error;
      return (data?.data as Session) ?? null;
    },
    async put(s) {
      const { error } = await c.from('sessions').upsert({ user_id: user!.id, id: s.id, name: s.name, data: s, updated_at: s.state.updatedAt, deleted: false });
      if (error) throw error;
    },
    async tombstone(id, at) {
      const { error } = await c.from('sessions').upsert({ user_id: user!.id, id, name: '', data: {}, updated_at: at, deleted: true });
      if (error) throw error;
    },
  };
}

const TOMB_KEY = 'tombstones';
async function getTombs(): Promise<Record<string, number>> {
  return ((await idb.get<Record<string, number>>('kv', TOMB_KEY)) ?? {}) as Record<string, number>;
}

/** Remember a local delete so the next sync removes it remotely too. */
export async function recordDeletion(id: string) {
  if (!cloudConfig()) return;
  const t = await getTombs();
  t[id] = Date.now();
  await idb.put('kv', TOMB_KEY, t);
  scheduleSync();
}

const local: Local = {
  list: () => idb.all<Session>('sessions'),
  save: async (s) => void (await idb.put('sessions', s.id, s)),
  remove: (id) => idb.del('sessions', id),
  tombstones: getTombs,
  async clearTombstone(id) {
    const t = await getTombs();
    delete t[id];
    await idb.put('kv', TOMB_KEY, t);
  },
};

let syncing: Promise<SyncResult | null> | null = null;
let again = false;

export async function syncNow(): Promise<SyncResult | null> {
  const c = sb();
  if (!c || !user) return null;
  if (syncing) {
    again = true;
    return syncing;
  }
  status = 'syncing';
  listeners.forEach((l) => l());
  syncing = (async () => {
    try {
      const res = await syncSessions(local, remote(c));
      await syncShots(c);
      status = 'idle';
      lastError = '';
      lastSync = Date.now();
      if (res.pulled.length || res.removedLocal.length) lastChanged = lastSync;
      return res;
    } catch (e) {
      status = 'error';
      lastError = friendlyError(e);
      return null;
    } finally {
      syncing = null;
      listeners.forEach((l) => l());
      if (again) {
        again = false;
        scheduleSync();
      }
    }
  })();
  return syncing;
}

let timer = 0;
/** Debounced background sync (called after every local save). */
export function scheduleSync(delay = 4000) {
  if (!user) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), delay);
}

// ---- screenshots -----------------------------------------------------------------

const SHOTS_UP = 'shots-uploaded';

async function syncShots(c: SupabaseClient) {
  const sessions = await idb.all<Session>('sessions');
  const want = sessions.flatMap((s) => s.state.broker.trades.map((t) => t.shot).filter((x): x is string => !!x));
  const done = new Set((await idb.get<string[]>('kv', SHOTS_UP)) ?? []);
  const todo = want.filter((id) => !done.has(id));
  for (const id of todo.slice(0, 50)) {
    const data = await idb.get<string>('shots', id);
    if (!data) continue;
    const { error } = await c.from('shots').upsert({ user_id: user!.id, id, data });
    if (error) throw error;
    done.add(id);
  }
  await idb.put('kv', SHOTS_UP, [...done]);
}

/** Fetch a screenshot that only exists in the cloud. */
export async function fetchShot(id: string): Promise<string | null> {
  const c = sb();
  if (!c || !user) return null;
  const { data } = await c.from('shots').select('data').eq('id', id).maybeSingle();
  const url = (data?.data as string) ?? null;
  if (url) await idb.put('shots', id, url);
  return url;
}

// ---- market data files --------------------------------------------------------------

const BUCKET = 'datasets';
const path = (id: string) => `${user!.id}/${encodeURIComponent(id)}.bin.gz`;

export async function uploadDataset(meta: DatasetMeta, onDone?: () => void) {
  const c = sb();
  if (!c || !user) throw new Error('Sign in first');
  const bars = await loadBars(meta.id);
  if (!bars) throw new Error('No local data');
  const blob = await packDataset(meta, bars);
  // raw bytes (not a Blob, which storage-js would wrap in multipart form data)
  const { error } = await c.storage.from(BUCKET).upload(path(meta.id), await blob.arrayBuffer(), { upsert: true, contentType: 'application/octet-stream' });
  if (error) throw error;
  onDone?.();
  return blob.size;
}

export async function listCloudDatasets(): Promise<{ id: string; size: number; updated: string }[]> {
  const c = sb();
  if (!c || !user) return [];
  const { data, error } = await c.storage.from(BUCKET).list(user.id, { limit: 1000 });
  if (error) throw error;
  return (data ?? [])
    .filter((f) => f.name.endsWith('.bin.gz'))
    .map((f) => ({ id: decodeURIComponent(f.name.replace(/\.bin\.gz$/, '')), size: Number((f.metadata as { size?: number } | null)?.size ?? 0), updated: f.updated_at ?? '' }));
}

export async function downloadDataset(id: string): Promise<DatasetMeta> {
  const c = sb();
  if (!c || !user) throw new Error('Sign in first');
  const { data, error } = await c.storage.from(BUCKET).download(path(id));
  if (error || !data) throw error ?? new Error('Download failed');
  const { meta, bars } = await unpackDataset(data);
  await saveDataset(meta, bars);
  return meta;
}

export async function deleteCloudDataset(id: string) {
  const c = sb();
  if (!c || !user) return;
  await c.storage.from(BUCKET).remove([path(id)]);
}

/** Datasets a set of sessions needs that are missing locally but exist in the cloud. */
export async function restoreMissingData(symbols: string[]): Promise<string[]> {
  if (!user) return [];
  const have = new Set((await listDatasets()).map((d) => d.id));
  const missing = symbols.filter((s) => !have.has(s));
  if (!missing.length) return [];
  const cloud = new Set((await listCloudDatasets()).map((d) => d.id));
  const got: string[] = [];
  for (const m of missing) if (cloud.has(m)) {
    await downloadDataset(m);
    got.push(m);
  }
  return got;
}
