/** Columnar OHLCV storage. Times are UTC epoch seconds, strictly increasing. */
export interface Bars {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  n: number;
}

export interface Candle {
  time: number; // display time (local-shifted seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface InstrumentSpec {
  symbol: string;
  /** size of one pip in price units (EURUSD 0.0001, USDJPY 0.01, XAUUSD 0.1, BTC 1) */
  pipSize: number;
  /** units per 1.00 lot (FX 100000, XAU 100, crypto 1) */
  contractSize: number;
  /** price decimals shown on the chart */
  digits: number;
}

export interface DatasetMeta {
  id: string; // same as symbol key
  symbol: string;
  source: 'csv' | 'binance' | 'synthetic';
  /** base resolution of the stored bars in seconds */
  resolution: number;
  from: number;
  to: number;
  count: number;
  spec: InstrumentSpec;
  createdAt: number;
}

export function emptyBars(cap = 0): Bars {
  return {
    t: new Float64Array(cap),
    o: new Float64Array(cap),
    h: new Float64Array(cap),
    l: new Float64Array(cap),
    c: new Float64Array(cap),
    v: new Float64Array(cap),
    n: 0,
  };
}

export function barsFromRows(rows: number[][]): Bars {
  // rows: [t,o,h,l,c,v]; sorts and de-duplicates by time (last wins)
  rows.sort((a, b) => a[0] - b[0]);
  const b = emptyBars(rows.length);
  let n = 0;
  for (const r of rows) {
    if (!(r[0] > 0) || !isFinite(r[1]) || !isFinite(r[4])) continue;
    const i = n > 0 && b.t[n - 1] === r[0] ? n - 1 : n++;
    b.t[i] = r[0];
    b.o[i] = r[1];
    b.h[i] = Math.max(r[1], r[2], r[3], r[4]);
    b.l[i] = Math.min(r[1], r[2], r[3], r[4]);
    b.c[i] = r[4];
    b.v[i] = r[5] || 0;
  }
  b.n = n;
  return b;
}

export function sliceBars(b: Bars, from: number, to: number): Bars {
  return {
    t: b.t.slice(from, to),
    o: b.o.slice(from, to),
    h: b.h.slice(from, to),
    l: b.l.slice(from, to),
    c: b.c.slice(from, to),
    v: b.v.slice(from, to),
    n: Math.max(0, to - from),
  };
}

export function mergeBars(a: Bars, b: Bars): Bars {
  const rows: number[][] = [];
  for (const x of [a, b]) for (let i = 0; i < x.n; i++) rows.push([x.t[i], x.o[i], x.h[i], x.l[i], x.c[i], x.v[i]]);
  return barsFromRows(rows);
}

/** index of last bar with t <= time, or -1 */
export function indexAtOrBefore(t: ArrayLike<number>, n: number, time: number): number {
  let lo = 0,
    hi = n - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Detect the dominant spacing between bars (the base resolution). */
export function detectResolution(b: Bars): number {
  const counts = new Map<number, number>();
  const lim = Math.min(b.n, 5000);
  for (let i = 1; i < lim; i++) {
    const d = b.t[i] - b.t[i - 1];
    if (d > 0) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = 60,
    bc = -1;
  for (const [d, c] of counts) if (c > bc) (bc = c), (best = d);
  return best;
}

export function guessSpec(symbol: string, samplePrice: number): InstrumentSpec {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isFx = /^[A-Z]{6}$/.test(s) && !/USDT|BUSD|USDC/.test(s);
  if (/XAU/.test(s)) return { symbol, pipSize: 0.1, contractSize: 100, digits: 2 };
  if (/XAG/.test(s)) return { symbol, pipSize: 0.01, contractSize: 5000, digits: 3 };
  if (isFx) {
    const jpy = s.endsWith('JPY');
    return { symbol, pipSize: jpy ? 0.01 : 0.0001, contractSize: 100000, digits: jpy ? 3 : 5 };
  }
  // indices / crypto / anything else: derive from price magnitude
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(samplePrice, 1e-9))));
  const pip = +Math.max(mag / 10000, 1e-8).toPrecision(1);
  const digits = Math.max(0, Math.min(8, Math.round(-Math.log10(pip)) + 2));
  return { symbol, pipSize: pip, contractSize: 1, digits };
}
