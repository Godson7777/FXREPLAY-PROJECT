/**
 * Timezone handling. The chart library renders timestamps as UTC, so we shift
 * every displayed timestamp by the zone's UTC offset ("local seconds").
 * Offsets are cached per hour, so DST zones stay cheap.
 */
export type OffsetFn = (utcSec: number) => number;

const fnCache = new Map<string, OffsetFn>();

export function offsetFn(zone: string): OffsetFn {
  const cached = fnCache.get(zone);
  if (cached) return cached;
  let fn: OffsetFn;
  const fixed = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone);
  if (zone === 'UTC' || !zone) fn = () => 0;
  else if (fixed) {
    const off = (fixed[1] === '-' ? -1 : 1) * (+fixed[2] * 3600 + +(fixed[3] || 0) * 60);
    fn = () => off;
  } else {
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      });
    } catch {
      fn = () => 0;
      fnCache.set(zone, fn);
      return fn;
    }
    const hourCache = new Map<number, number>();
    fn = (utc: number) => {
      const hk = Math.floor(utc / 3600);
      let off = hourCache.get(hk);
      if (off === undefined) {
        const p: Record<string, number> = {};
        for (const part of fmt.formatToParts(new Date(hk * 3600 * 1000))) {
          if (part.type !== 'literal') p[part.type] = +part.value;
        }
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) / 1000;
        off = asUtc - hk * 3600;
        if (hourCache.size > 200000) hourCache.clear();
        hourCache.set(hk, off);
      }
      return off;
    };
  }
  fnCache.set(zone, fn);
  return fn;
}

export const ZONES = [
  'UTC',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'Australia/Sydney',
];

/** Convert local-shifted seconds back to UTC (approximate across DST jumps). */
export function localToUtc(local: number, off: OffsetFn): number {
  let u = local - off(local);
  u = local - off(u);
  return u;
}

const pad = (n: number) => String(n).padStart(2, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Format local-shifted seconds. */
export function fmtLocal(local: number, withDow = false): string {
  const d = new Date(local * 1000);
  const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withDow ? `${DOW[d.getUTCDay()]} ${s}` : s;
}

export function fmtDuration(sec: number): string {
  if (!isFinite(sec)) return '—';
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
