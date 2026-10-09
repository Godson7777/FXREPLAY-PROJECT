/** Small, dependency-free statistics toolkit used by the analytics engine. */

export const sum = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};
export const mean = (a: ArrayLike<number>) => (a.length ? sum(a) / a.length : 0);

/** Sample variance (n − 1). */
export function variance(a: ArrayLike<number>): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - m) ** 2;
  return s / (n - 1);
}
export const std = (a: ArrayLike<number>) => Math.sqrt(variance(a));

/** Sample skewness g1 = m3 / m2^1.5 (population moments). */
export function skewness(a: ArrayLike<number>): number {
  const n = a.length;
  if (n < 3) return 0;
  const m = mean(a);
  let m2 = 0, m3 = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - m;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  return m2 > 0 ? m3 / m2 ** 1.5 : 0;
}

/** Kurtosis m4 / m2² (NOT excess: a normal distribution gives 3). */
export function kurtosis(a: ArrayLike<number>): number {
  const n = a.length;
  if (n < 4) return 3;
  const m = mean(a);
  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = (a[i] - m) ** 2;
    m2 += d;
    m4 += d * d;
  }
  m2 /= n;
  m4 /= n;
  return m2 > 0 ? m4 / (m2 * m2) : 3;
}

/** Quantile of an ascending-sorted array, linear interpolation (Excel/NumPy "linear"). */
export function quantileSorted(s: ArrayLike<number>, p: number): number {
  const n = s.length;
  if (!n) return NaN;
  if (n === 1) return s[0];
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}
export const quantile = (a: ArrayLike<number>, p: number) => quantileSorted(Float64Array.from(a).sort(), p);
export const median = (a: ArrayLike<number>) => quantile(a, 0.5);

// ---- distributions ---------------------------------------------------------------

/** erf via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
export const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Inverse standard normal CDF (Acklam, relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** ln Γ(x), Lanczos approximation (g = 7). */
export function lnGamma(x: number): number {
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = g[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a, b). */
export function incBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t cumulative distribution function. */
export function tCdf(t: number, df: number): number {
  if (!isFinite(t)) return t > 0 ? 1 : 0;
  if (df <= 0) return NaN;
  const x = df / (df + t * t);
  const tail = 0.5 * incBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - tail : tail;
}

// ---- regression -------------------------------------------------------------------

export function linreg(ys: ArrayLike<number>): { slope: number; intercept: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: n ? ys[0] : 0, r2: 0 };
  const mx = (n - 1) / 2, my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx, dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx ? sxy / sxx : 0;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept: my - slope * mx, r2 };
}

/**
 * Piecewise-linear map from a raw value to points, using anchors sorted by x.
 * Values outside the range clamp to the first/last anchor.
 */
export function lerpAnchors(x: number | null | undefined, anchors: readonly (readonly [number, number])[]): number | null {
  if (x == null || Number.isNaN(x)) return null;
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
