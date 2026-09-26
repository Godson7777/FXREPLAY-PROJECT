/** Pure indicator math on plain arrays. NaN = no value. */
export interface Series {
  time: ArrayLike<number>;
  o: ArrayLike<number>;
  h: ArrayLike<number>;
  l: ArrayLike<number>;
  c: ArrayLike<number>;
  v: ArrayLike<number>;
  n: number;
}

export interface IndOutput {
  name: string;
  values: Float64Array;
  kind: 'line' | 'hist';
  color?: string;
}

export interface IndicatorDef {
  type: string;
  label: string;
  pane: 'main' | 'sub';
  params: Record<string, number>;
  compute(s: Series, p: Record<string, number>): IndOutput[];
  levels?: number[];
}

export function sma(x: ArrayLike<number>, n: number, len: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (isNaN(v)) continue;
    sum += v;
    cnt++;
    if (cnt > len) sum -= x[i - len];
    if (cnt >= len) out[i] = sum / len;
  }
  return out;
}

export function ema(x: ArrayLike<number>, n: number, len: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  const k = 2 / (len + 1);
  let prev = NaN, seed = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (isNaN(v)) continue;
    if (isNaN(prev)) {
      seed += v;
      cnt++;
      if (cnt === len) prev = seed / len, (out[i] = prev);
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rma(x: ArrayLike<number>, n: number, len: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  let prev = NaN, seed = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (isNaN(v)) continue;
    if (isNaN(prev)) {
      seed += v;
      if (++cnt === len) (prev = seed / len), (out[i] = prev);
    } else out[i] = prev = (prev * (len - 1) + v) / len;
  }
  return out;
}

function stdev(x: ArrayLike<number>, n: number, len: number, m: Float64Array) {
  const out = new Float64Array(n).fill(NaN);
  for (let i = len - 1; i < n; i++) {
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += (x[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / len);
  }
  return out;
}

function trueRange(s: Series) {
  const tr = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const pc = i ? s.c[i - 1] : s.c[i];
    tr[i] = Math.max(s.h[i] - s.l[i], Math.abs(s.h[i] - pc), Math.abs(s.l[i] - pc));
  }
  return tr;
}

export const INDICATORS: IndicatorDef[] = [
  {
    type: 'sma', label: 'SMA', pane: 'main', params: { length: 20 },
    compute: (s, p) => [{ name: `SMA ${p.length}`, values: sma(s.c, s.n, p.length), kind: 'line' }],
  },
  {
    type: 'ema', label: 'EMA', pane: 'main', params: { length: 50 },
    compute: (s, p) => [{ name: `EMA ${p.length}`, values: ema(s.c, s.n, p.length), kind: 'line' }],
  },
  {
    type: 'bb', label: 'Bollinger Bands', pane: 'main', params: { length: 20, mult: 2 },
    compute: (s, p) => {
      const m = sma(s.c, s.n, p.length);
      const sd = stdev(s.c, s.n, p.length, m);
      const up = m.map((x, i) => x + p.mult * sd[i]);
      const dn = m.map((x, i) => x - p.mult * sd[i]);
      return [
        { name: 'BB basis', values: m, kind: 'line' },
        { name: 'BB upper', values: up, kind: 'line' },
        { name: 'BB lower', values: dn, kind: 'line' },
      ];
    },
  },
  {
    type: 'vwap', label: 'VWAP (daily)', pane: 'main', params: {},
    compute: (s) => {
      const out = new Float64Array(s.n).fill(NaN);
      let day = -1, pv = 0, vv = 0;
      for (let i = 0; i < s.n; i++) {
        const d = Math.floor(s.time[i] / 86400);
        if (d !== day) (day = d), (pv = 0), (vv = 0);
        const tp = (s.h[i] + s.l[i] + s.c[i]) / 3;
        const vol = s.v[i] || 1;
        pv += tp * vol;
        vv += vol;
        out[i] = pv / vv;
      }
      return [{ name: 'VWAP', values: out, kind: 'line' }];
    },
  },
  {
    type: 'donchian', label: 'Donchian Channel', pane: 'main', params: { length: 20 },
    compute: (s, p) => {
      const up = new Float64Array(s.n).fill(NaN), dn = new Float64Array(s.n).fill(NaN);
      for (let i = p.length - 1; i < s.n; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let j = i - p.length + 1; j <= i; j++) (hi = Math.max(hi, s.h[j])), (lo = Math.min(lo, s.l[j]));
        up[i] = hi;
        dn[i] = lo;
      }
      return [
        { name: 'DC upper', values: up, kind: 'line' },
        { name: 'DC lower', values: dn, kind: 'line' },
      ];
    },
  },
  {
    type: 'rsi', label: 'RSI', pane: 'sub', params: { length: 14 }, levels: [30, 70],
    compute: (s, p) => {
      const g = new Float64Array(s.n), l = new Float64Array(s.n);
      for (let i = 1; i < s.n; i++) {
        const d = s.c[i] - s.c[i - 1];
        g[i] = Math.max(0, d);
        l[i] = Math.max(0, -d);
      }
      const ag = rma(g, s.n, p.length), al = rma(l, s.n, p.length);
      const out = ag.map((x, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i])));
      return [{ name: `RSI ${p.length}`, values: out, kind: 'line' }];
    },
  },
  {
    type: 'macd', label: 'MACD', pane: 'sub', params: { fast: 12, slow: 26, signal: 9 }, levels: [0],
    compute: (s, p) => {
      const f = ema(s.c, s.n, p.fast), sl = ema(s.c, s.n, p.slow);
      const m = f.map((x, i) => x - sl[i]);
      const sig = ema(m, s.n, p.signal);
      const hist = m.map((x, i) => x - sig[i]);
      return [
        { name: 'Histogram', values: hist, kind: 'hist' },
        { name: 'MACD', values: m, kind: 'line' },
        { name: 'Signal', values: sig, kind: 'line' },
      ];
    },
  },
  {
    type: 'atr', label: 'ATR', pane: 'sub', params: { length: 14 },
    compute: (s, p) => [{ name: `ATR ${p.length}`, values: rma(trueRange(s), s.n, p.length), kind: 'line' }],
  },
  {
    type: 'stoch', label: 'Stochastic', pane: 'sub', params: { k: 14, d: 3, smooth: 3 }, levels: [20, 80],
    compute: (s, p) => {
      const raw = new Float64Array(s.n).fill(NaN);
      for (let i = p.k - 1; i < s.n; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let j = i - p.k + 1; j <= i; j++) (hi = Math.max(hi, s.h[j])), (lo = Math.min(lo, s.l[j]));
        raw[i] = hi === lo ? 50 : ((s.c[i] - lo) / (hi - lo)) * 100;
      }
      const k = sma(raw, s.n, p.smooth);
      return [
        { name: '%K', values: k, kind: 'line' },
        { name: '%D', values: sma(k, s.n, p.d), kind: 'line' },
      ];
    },
  },
  {
    type: 'volume', label: 'Volume', pane: 'sub', params: {},
    compute: (s) => [{ name: 'Volume', values: Float64Array.from({ length: s.n }, (_, i) => s.v[i]), kind: 'hist' }],
  },
];

export const indicatorDef = (type: string) => INDICATORS.find((d) => d.type === type);
