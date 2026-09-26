import { emptyBars, type Bars } from '../core/types';

/** Seeded PRNG (mulberry32) so demo datasets are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Realistic-looking 1-minute FX data: GBM with intraday volatility seasonality
 * (Asia quiet, London/NY active), volatility clustering (GARCH-ish) and
 * slow trend regimes. Weekends are skipped like a real FX feed.
 */
export function generateSynthetic(opts: {
  start: number; // UTC seconds
  days: number;
  price: number;
  annualVol?: number;
  seed?: number;
  resolution?: number;
  weekends?: boolean;
}): Bars {
  const res = opts.resolution ?? 60;
  const rand = rng(opts.seed ?? 42);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const total = Math.floor((opts.days * 86400) / res);
  const b = emptyBars(total);
  const baseVol = (opts.annualVol ?? 0.08) / Math.sqrt((365 * 86400) / res);
  let p = opts.price;
  let volState = 1;
  let drift = 0;
  let n = 0;
  const start = Math.floor(opts.start / res) * res;
  for (let i = 0; i < total; i++) {
    const t = start + i * res;
    const d = new Date(t * 1000);
    const dow = d.getUTCDay();
    const hr = d.getUTCHours() + d.getUTCMinutes() / 60;
    if (!opts.weekends) {
      if (dow === 6 || (dow === 5 && hr >= 21) || (dow === 0 && hr < 21)) continue;
    }
    // intraday seasonality
    const season =
      0.45 +
      0.9 * Math.exp(-(((hr - 8.5) / 2.2) ** 2)) +
      1.1 * Math.exp(-(((hr - 14) / 2.5) ** 2)) +
      0.25 * Math.exp(-(((hr - 1) / 2) ** 2));
    if (i % Math.max(1, Math.floor(86400 / res)) === 0) drift = drift * 0.8 + gauss() * baseVol * 0.006;
    volState = Math.max(0.3, Math.min(4, volState * 0.995 + 0.005 + (rand() < 0.002 ? gauss() * 1.5 : 0)));
    const sigma = baseVol * season * volState;
    const o = p;
    const steps = 4;
    let hi = o, lo = o, x = o;
    for (let s = 0; s < steps; s++) {
      x *= Math.exp(drift / steps + (sigma / Math.sqrt(steps)) * gauss());
      if (x > hi) hi = x;
      if (x < lo) lo = x;
    }
    p = x;
    b.t[n] = t;
    b.o[n] = o;
    b.h[n] = hi;
    b.l[n] = lo;
    b.c[n] = x;
    b.v[n] = Math.round(50 + 400 * season * volState * rand());
    n++;
  }
  b.n = n;
  return b;
}
