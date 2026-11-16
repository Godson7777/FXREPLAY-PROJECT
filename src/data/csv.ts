import { barsFromRows, type Bars } from '../core/types';

/**
 * Tolerant OHLCV CSV parser. Handles, among others:
 *  - MT4/MT5 export:     2024.01.02,00:00,1.10420,1.10450,1.10400,1.10430,123
 *  - MT5 tab export:     <DATE>\t<TIME>\t<OPEN>...
 *  - HistData.com:       20240102 000000;1.10420;1.10450;1.10400;1.10430;0
 *  - Dukascopy:          02.01.2024 00:00:00.000,1.10420,...
 *  - Generic w/ header:  time,open,high,low,close,volume  (ISO date or unix s/ms)
 *  - TradingView:        2024-01-02T07:00:00+07:00,1.1042,...  (the offset in the stamp is honoured)
 *  - Binance kline CSV:  1704153600000,42283.58,42554.57,42261.02,42475.23,1271.68,...
 *  - Spreadsheet re-saves: quoted fields, ";" with decimal commas, US month/day/year, AM/PM
 * Timestamps without a zone of their own are interpreted in `sourceUtcOffsetHours` (default 0 = UTC).
 */
export function parseCsv(text: string, sourceUtcOffsetHours = 0): Bars {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length);
  if (!lines.length) throw new Error('File is empty');
  const delim = pickDelim(lines[0]);
  let first = 0;
  let cols = { date: 0, time: -1, o: 1, h: 2, l: 3, c: 4, v: 5 };
  const head = splitLine(lines[0], delim).map((x) => x.replace(/[<>"]/g, '').trim().toLowerCase());
  if (head.some((x) => /open|high|close|date|time/.test(x))) {
    first = 1;
    const find = (re: RegExp) => head.findIndex((x) => re.test(x));
    let date = find(/^(date|time|timestamp|datetime|date ?time|date\/time|gmt time|local time|open ?time|dt|dtyyyymmdd)$/);
    if (date < 0) date = find(/date|time/);
    const time = head.findIndex((x, i) => i !== date && /^time$/.test(x));
    cols = {
      date: Math.max(date, 0),
      time: time >= 0 && date >= 0 && /date|dtyyyymmdd/.test(head[date]) && !/time/.test(head[date]) ? time : -1,
      o: find(/^open$|^o$/),
      h: find(/^high$|^h$/),
      l: find(/^low$|^l$/),
      c: find(/^close$|^c$/),
      v: find(/vol|^v$/),
    };
    if (cols.o < 0 || cols.c < 0) throw new Error('Could not find open/close columns in header');
  } else {
    // headerless: detect "date,time,o,h,l,c[,v]" vs "datetime,o,h,l,c[,v]"
    const p = splitLine(lines[0], delim);
    if (p.length >= 6 && /^\d{1,2}:\d{2}/.test(p[1])) cols = { date: 0, time: 1, o: 2, h: 3, l: 4, c: 5, v: 6 };
  }
  const stampOf = (p: string[]) => (cols.time >= 0 ? `${p[cols.date] ?? ''} ${p[cols.time] ?? ''}` : p[cols.date]);

  // One file uses one style. Decide from a sample, so a line is never read differently from its neighbours:
  //  - 01/13/2024 can only be month first; 13/01/2024 only day first
  //  - 42,283.58 means commas group thousands; otherwise a comma inside a number is the decimal mark
  let monthFirst = false,
    usThousands = false;
  const step = Math.max(1, Math.floor((lines.length - first) / 400));
  for (let i = first; i < lines.length; i += step) {
    const p = splitLine(lines[i], delim);
    const m = /^(\d{1,2})[-/](\d{1,2})[-/]\d{4}/.exec((stampOf(p) ?? '').trim());
    if (m && +m[2] > 12 && +m[1] <= 12) monthFirst = true;
    if (!usThousands && p.some((x) => /^-?\d{1,3}(,\d{3})+\.\d+$/.test(x))) usThousands = true;
  }
  const num = (s: string | undefined) => {
    if (s == null) return NaN;
    let x = s.replace(/\s/g, '');
    if (!x) return NaN;
    if (x.includes(','))
      x = usThousands
        ? x.replace(/,/g, '')
        : x.indexOf('.') >= 0 && x.indexOf('.') < x.lastIndexOf(',')
          ? x.replace(/\./g, '').replace(',', '.')
          : x.replace(',', '.');
    return +x;
  };

  const offSec = sourceUtcOffsetHours * 3600;
  const rows: number[][] = [];
  let bad = 0;
  for (let i = first; i < lines.length; i++) {
    const p = splitLine(lines[i], delim);
    const st = stamp(stampOf(p), monthFirst);
    if (st === null) {
      bad++;
      continue;
    }
    // a stamp that names its own zone (or counts seconds since 1970) is already UTC
    rows.push([
      st.abs ? st.t : st.t - offSec,
      num(p[cols.o]),
      cols.h >= 0 ? num(p[cols.h]) : NaN,
      cols.l >= 0 ? num(p[cols.l]) : NaN,
      num(p[cols.c]),
      cols.v >= 0 ? num(p[cols.v]) || 0 : 0,
    ]);
  }
  if (!rows.length) throw new Error(`No parseable rows (${bad} bad lines)`);
  const bars = barsFromRows(rows);
  if (!bars.n) throw new Error('No parseable rows — the file has dates but no usable open/close prices');
  return bars;
}

function pickDelim(line: string): string {
  const cands = [',', ';', '\t', '|'];
  let best = ',',
    bc = 0;
  for (const d of cands) {
    const c = line.split(d).length;
    if (c > bc) (bc = c), (best = d);
  }
  return best;
}

/** Split one line, honouring "quoted fields" (which may hold the separator). */
function splitLine(line: string, delim: string): string[] {
  if (!line.includes('"')) return line.split(delim).map((x) => x.trim());
  const out: string[] = [];
  let cur = '',
    q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') (cur += '"'), i++;
      else q = !q;
    } else if (ch === delim && !q) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const CLOCK = '(?:[ T,]+(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:[.,]\\d+)?)?\\s*([AaPp])?\\.?[Mm]?\\.?)?';
const YMD = new RegExp(`^(\\d{4})[-./](\\d{1,2})[-./](\\d{1,2})${CLOCK}`);
const DMY = new RegExp(`^(\\d{1,2})([-./])(\\d{1,2})[-./](\\d{4})${CLOCK}`);
const ZONED = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;
const hour = (h: string | undefined, ap: string | undefined) => {
  let x = +(h || 0);
  if (ap) x = /p/i.test(ap) ? (x % 12) + 12 : x % 12;
  return x;
};

/**
 * UTC seconds for a date/time string, and whether the string fixed the zone itself
 * (`abs`: a unix time, a trailing Z or a +07:00 style offset).
 */
function stamp(raw: string | undefined, monthFirst = false): { t: number; abs: boolean } | null {
  if (!raw) return null;
  const s = raw.trim().replace(/"/g, '');
  if (/^\d{9,13}(\.\d+)?$/.test(s)) {
    const n = +s;
    return { t: n > 1e11 ? Math.floor(n / 1000) : Math.floor(n), abs: true };
  }
  let m: RegExpExecArray | null;
  if ((m = ZONED.exec(s))) {
    const z = m[7].toUpperCase();
    const off = z === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 3600 + +(z.replace(':', '').slice(3, 5) || 0) * 60);
    return { t: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000 - off, abs: true };
  }
  // 20240102 000000  | 20240102 00:00:00 | 20240102
  if ((m = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2}):?(\d{2})?)?/.exec(s)) && !/[-./]/.test(s.slice(0, 8)))
    return { t: Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000, abs: false };
  // 2024.01.02 00:00[:00] | 2024-01-02T00:00:00 | 2024/01/02 1:05 PM
  if ((m = YMD.exec(s))) return { t: Date.UTC(+m[1], +m[2] - 1, +m[3], hour(m[4], m[7]), +(m[5] || 0), +(m[6] || 0)) / 1000, abs: false };
  // 02.01.2024 00:00:00.000 (day first) | 01/13/2024 (month first: the caller decides per file, a 13 decides per line)
  if ((m = DMY.exec(s))) {
    let d = +m[1],
      mo = +m[3];
    if (m[2] !== '.' && (monthFirst || (d <= 12 && mo > 12))) [d, mo] = [mo, d];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { t: Date.UTC(+m[4], mo - 1, d, hour(m[5], m[8]), +(m[6] || 0), +(m[7] || 0)) / 1000, abs: false };
  }
  // anything else must at least carry a year ("Jan 2, 2024 13:05") — a bare number or word is not a date
  if (!/\d{4}/.test(s)) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : { t: Math.floor(t / 1000), abs: /(Z|GMT|UTC|[+-]\d{2}:?\d{2})\s*$/i.test(s) };
}

/** Returns UTC seconds or null. */
export function parseStamp(raw: string | undefined): number | null {
  return stamp(raw)?.t ?? null;
}
