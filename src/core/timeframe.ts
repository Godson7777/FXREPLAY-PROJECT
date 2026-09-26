import type { Bars } from './types';
import type { OffsetFn } from './tz';

export type TfUnit = 's' | 'm' | 'h' | 'D' | 'W' | 'M';

export interface Timeframe {
  unit: TfUnit;
  n: number;
  /** nominal length in seconds (months = 30d) */
  sec: number;
  label: string;
}

const UNIT_SEC: Record<TfUnit, number> = { s: 1, m: 60, h: 3600, D: 86400, W: 604800, M: 2592000 };

/**
 * Parse ANY timeframe string. Examples:
 *  "45s" "1" "7m" "13" "90m" "2h" "4H" "D" "3D" "W" "2W" "M" "3M" "12M"
 * Lowercase `m` = minutes, uppercase `M` = months (TradingView convention).
 * A bare number means minutes.
 */
export function parseTf(input: string): Timeframe | null {
  const s = input.trim();
  const m = /^(\d+)?\s*([smhHdDwWM]|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months)?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  if (!(n >= 1 && n <= 100000)) return null;
  let u = m[2] || 'm';
  const map: Record<string, TfUnit> = {
    s: 's', m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
    h: 'h', H: 'h', hour: 'h', hours: 'h',
    d: 'D', D: 'D', day: 'D', days: 'D',
    w: 'W', W: 'W', week: 'W', weeks: 'W',
    M: 'M', month: 'M', months: 'M',
  };
  const unit = map[u];
  if (!unit) return null;
  return makeTf(unit, n);
}

export function makeTf(unit: TfUnit, n: number): Timeframe {
  const label = unit === 's' ? `${n}s` : unit === 'm' ? `${n}m` : unit === 'h' ? `${n}H` : `${n === 1 ? '' : n}${unit}`;
  return { unit, n, sec: UNIT_SEC[unit] * n, label };
}

export function tfSeconds(sec: number): Timeframe {
  if (sec % 86400 === 0) return makeTf('D', sec / 86400);
  if (sec % 3600 === 0) return makeTf('h', sec / 3600);
  if (sec % 60 === 0) return makeTf('m', sec / 60);
  return makeTf('s', sec);
}

/** Bucket start (local seconds) for a local timestamp. */
export function bucketKey(local: number, tf: Timeframe): number {
  const sec = tf.sec;
  switch (tf.unit) {
    case 's':
    case 'm':
    case 'h': {
      if (86400 % sec === 0) return Math.floor(local / sec) * sec;
      // non-divisor intraday frames (7m, 13m, 5h...) restart at each day boundary
      const day = Math.floor(local / 86400) * 86400;
      return day + Math.floor((local - day) / sec) * sec;
    }
    case 'D':
      return Math.floor(local / sec) * sec;
    case 'W': {
      const days = Math.floor(local / 86400);
      const monday = days - ((days + 3) % 7); // 1970-01-01 was a Thursday
      const wk = Math.floor(monday / 7);
      return (monday - (((wk % tf.n) + tf.n) % tf.n) * 7) * 86400;
    }
    case 'M': {
      const d = new Date(local * 1000);
      let mi = d.getUTCFullYear() * 12 + d.getUTCMonth();
      mi -= mi % tf.n;
      return Date.UTC(Math.floor(mi / 12), mi % 12, 1) / 1000;
    }
  }
}

/** Full aggregation of a base series into a timeframe. */
export interface Agg {
  tf: Timeframe;
  n: number;
  time: Float64Array; // display key (local seconds)
  start: Int32Array; // first base index of each candle
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  baseToAgg: Int32Array;
}

export function aggregate(b: Bars, tf: Timeframe, off: OffsetFn): Agg {
  const N = b.n;
  const cap = N; // worst case: 1:1
  const time = new Float64Array(cap);
  const start = new Int32Array(cap);
  const o = new Float64Array(cap), h = new Float64Array(cap), l = new Float64Array(cap), c = new Float64Array(cap), v = new Float64Array(cap);
  const baseToAgg = new Int32Array(N);
  let k = -1;
  let cur = -Infinity;
  for (let i = 0; i < N; i++) {
    const t = b.t[i];
    let key = bucketKey(t + off(t), tf);
    if (key < cur) key = cur; // DST fall-back: merge into previous bucket
    if (key !== cur) {
      k++;
      cur = key;
      time[k] = key;
      start[k] = i;
      o[k] = b.o[i];
      h[k] = b.h[i];
      l[k] = b.l[i];
      c[k] = b.c[i];
      v[k] = b.v[i];
    } else {
      if (b.h[i] > h[k]) h[k] = b.h[i];
      if (b.l[i] < l[k]) l[k] = b.l[i];
      c[k] = b.c[i];
      v[k] += b.v[i];
    }
    baseToAgg[i] = k;
  }
  const n = k + 1;
  return {
    tf, n,
    time: time.slice(0, n), start: start.slice(0, n),
    o: o.slice(0, n), h: h.slice(0, n), l: l.slice(0, n), c: c.slice(0, n), v: v.slice(0, n),
    baseToAgg,
  };
}

/** The (possibly still-forming) candle k as seen when the replay cursor is at base index `cursor`. */
export function partialCandle(b: Bars, a: Agg, k: number, cursor: number) {
  const s = a.start[k];
  const e = Math.min(cursor, k + 1 < a.n ? a.start[k + 1] - 1 : b.n - 1);
  if (e === (k + 1 < a.n ? a.start[k + 1] - 1 : b.n - 1)) {
    return { time: a.time[k], open: a.o[k], high: a.h[k], low: a.l[k], close: a.c[k], volume: a.v[k] };
  }
  let hi = -Infinity, lo = Infinity, vol = 0;
  for (let i = s; i <= e; i++) {
    if (b.h[i] > hi) hi = b.h[i];
    if (b.l[i] < lo) lo = b.l[i];
    vol += b.v[i];
  }
  return { time: a.time[k], open: b.o[s], high: hi, low: lo, close: b.c[e], volume: vol };
}

export const DEFAULT_TFS = ['1m', '5m', '15m', '30m', '1H', '4H', 'D', 'W'];
