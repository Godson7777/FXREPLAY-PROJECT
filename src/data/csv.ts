import { barsFromRows, type Bars } from '../core/types';

/**
 * Tolerant OHLCV CSV parser. Handles, among others:
 *  - MT4/MT5 export:     2024.01.02,00:00,1.10420,1.10450,1.10400,1.10430,123
 *  - MT5 tab export:     <DATE>\t<TIME>\t<OPEN>...
 *  - HistData.com:       20240102 000000;1.10420;1.10450;1.10400;1.10430;0
 *  - Dukascopy:          02.01.2024 00:00:00.000,1.10420,...
 *  - Generic w/ header:  time,open,high,low,close,volume  (ISO date or unix s/ms)
 *  - Binance kline CSV:  1704153600000,42283.58,42554.57,42261.02,42475.23,1271.68,...
 * Timestamps are interpreted in `sourceUtcOffsetHours` (default 0 = UTC).
 */
export function parseCsv(text: string, sourceUtcOffsetHours = 0): Bars {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error('File is empty');
  const delim = pickDelim(lines[0]);
  let first = 0;
  let cols = { date: 0, time: -1, o: 1, h: 2, l: 3, c: 4, v: 5 };
  const head = lines[0].split(delim).map((x) => x.trim().replace(/[<>"]/g, '').toLowerCase());
  if (head.some((x) => /open|high|close|date|time/.test(x))) {
    first = 1;
    const find = (re: RegExp) => head.findIndex((x) => re.test(x));
    const date = find(/^(date|time|timestamp|datetime|gmt time|local time|open ?time|dt)$/);
    const time = head.findIndex((x, i) => i !== date && /^time$/.test(x));
    cols = {
      date: date >= 0 ? date : 0,
      time: time >= 0 && head[date] === 'date' ? time : -1,
      o: find(/^open$|^o$/),
      h: find(/^high$|^h$/),
      l: find(/^low$|^l$/),
      c: find(/^close$|^c$/),
      v: find(/vol|^v$/),
    };
    if (cols.o < 0 || cols.c < 0) throw new Error('Could not find open/close columns in header');
  } else {
    // headerless: detect "date,time,o,h,l,c[,v]" vs "datetime,o,h,l,c[,v]"
    const p = lines[0].split(delim).map((x) => x.trim());
    if (p.length >= 6 && /^\d{1,2}:\d{2}/.test(p[1])) cols = { date: 0, time: 1, o: 2, h: 3, l: 4, c: 5, v: 6 };
  }
  const offSec = sourceUtcOffsetHours * 3600;
  const rows: number[][] = [];
  let bad = 0;
  for (let i = first; i < lines.length; i++) {
    const p = lines[i].split(delim);
    const ts = parseStamp(cols.time >= 0 ? `${p[cols.date]} ${p[cols.time]}` : p[cols.date]);
    if (ts === null) {
      bad++;
      continue;
    }
    rows.push([ts - offSec, +p[cols.o], +p[cols.h], +p[cols.l], +p[cols.c], cols.v >= 0 ? +p[cols.v] || 0 : 0]);
  }
  if (!rows.length) throw new Error(`No parseable rows (${bad} bad lines)`);
  return barsFromRows(rows);
}

function pickDelim(line: string): string {
  const cands = [',', ';', '\t', '|'];
  let best = ',', bc = 0;
  for (const d of cands) {
    const c = line.split(d).length;
    if (c > bc) (bc = c), (best = d);
  }
  return best;
}

/** Returns UTC seconds or null. */
export function parseStamp(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().replace(/"/g, '');
  if (/^\d{9,13}(\.\d+)?$/.test(s)) {
    const n = +s;
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  }
  let m: RegExpExecArray | null;
  // 20240102 000000  | 20240102 00:00:00 | 20240102
  if ((m = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2}):?(\d{2})?)?/.exec(s)) && !/[-./]/.test(s.slice(0, 8)))
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
  // 2024.01.02 00:00[:00] | 2024-01-02T00:00:00Z | 2024/01/02 00:00
  if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s)))
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
  // 02.01.2024 00:00:00.000 (Dukascopy, day first) | 01/02/2024 (US, if first part > 12 it's day)
  if ((m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s))) {
    let d = +m[1], mo = +m[2];
    if (s[2] === '/' && d <= 12 && mo <= 31 && mo > 12) [d, mo] = [mo, d];
    return Date.UTC(+m[3], mo - 1, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : Math.floor(t / 1000);
}
