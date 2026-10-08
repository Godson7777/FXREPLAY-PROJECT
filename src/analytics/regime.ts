import { aggregate, parseTf, type Agg } from '../core/timeframe';
import { offsetFn } from '../core/tz';
import { indexAtOrBefore, type Bars } from '../core/types';

/**
 * Market-regime classification on the 4-hour chart (UTC-aligned).
 *
 *  Trend:      ADX(14) ≥ 20 → trending; direction from +DI vs −DI. ADX < 20 → ranging.
 *  Volatility: ATR(14) as % of price, ranked against the previous 500 four-hour bars
 *              → bottom third = low, top third = high, otherwise normal.
 *
 * A trade is tagged with the regime of the last *completed* 4H bar before its
 * entry, so no future information leaks into the classification.
 */
export type Trend = 'up' | 'down' | 'range';
export type Vol = 'low' | 'normal' | 'high';
export interface RegimeTag {
  trend: Trend;
  vol: Vol;
  adx: number;
  atrPct: number;
}

export const TREND_LABEL: Record<Trend, string> = { up: 'Uptrend', down: 'Downtrend', range: 'Ranging' };
export const VOL_LABEL: Record<Vol, string> = { low: 'Low volatility', normal: 'Normal volatility', high: 'High volatility' };
export const TRENDS: Trend[] = ['up', 'down', 'range'];
export const VOLS: Vol[] = ['low', 'normal', 'high'];

export const ADX_TREND = 20;
const P = 14;
const RANK_WINDOW = 500;
const RANK_MIN = 50;

export interface RegimeSeries {
  agg: Agg;
  adx: Float64Array;
  pdi: Float64Array;
  mdi: Float64Array;
  atrPct: Float64Array;
  volRank: Float64Array;
  ready: Uint8Array;
}

export function regimeSeries(b: Bars): RegimeSeries {
  const agg = aggregate(b, parseTf('4H')!, offsetFn('UTC'));
  const n = agg.n;
  const adx = new Float64Array(n).fill(NaN), pdi = new Float64Array(n).fill(NaN), mdi = new Float64Array(n).fill(NaN);
  const atrPct = new Float64Array(n).fill(NaN), volRank = new Float64Array(n).fill(NaN);
  const ready = new Uint8Array(n);
  let trS = 0, pS = 0, mS = 0, dxSum = 0, adxPrev = NaN;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(agg.h[i] - agg.l[i], Math.abs(agg.h[i] - agg.c[i - 1]), Math.abs(agg.l[i] - agg.c[i - 1]));
    const up = agg.h[i] - agg.h[i - 1], dn = agg.l[i - 1] - agg.l[i];
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    if (i <= P) {
      trS += tr;
      pS += pdm;
      mS += mdm;
      if (i < P) continue;
    } else {
      trS = trS - trS / P + tr;
      pS = pS - pS / P + pdm;
      mS = mS - mS / P + mdm;
    }
    const pd = trS ? (100 * pS) / trS : 0, md = trS ? (100 * mS) / trS : 0;
    pdi[i] = pd;
    mdi[i] = md;
    atrPct[i] = agg.c[i] > 0 ? trS / P / agg.c[i] : NaN;
    const dx = pd + md ? (100 * Math.abs(pd - md)) / (pd + md) : 0;
    if (i < 2 * P - 1) dxSum += dx;
    else if (i === 2 * P - 1) {
      dxSum += dx;
      adxPrev = dxSum / P;
      adx[i] = adxPrev;
    } else {
      adxPrev = (adxPrev * (P - 1) + dx) / P;
      adx[i] = adxPrev;
    }
  }
  // volatility percentile rank against the trailing window (inclusive)
  for (let i = 0; i < n; i++) {
    const v = atrPct[i];
    if (isNaN(v)) continue;
    let below = 0, cnt = 0;
    for (let j = Math.max(0, i - RANK_WINDOW + 1); j <= i; j++) {
      const w = atrPct[j];
      if (isNaN(w)) continue;
      cnt++;
      if (w < v) below++;
    }
    if (cnt >= RANK_MIN) volRank[i] = below / (cnt - 1 || 1);
    if (!isNaN(adx[i]) && !isNaN(volRank[i])) ready[i] = 1;
  }
  return { agg, adx, pdi, mdi, atrPct, volRank, ready };
}

export function classify(adx: number, pdi: number, mdi: number, rank: number): { trend: Trend; vol: Vol } {
  const trend: Trend = adx >= ADX_TREND ? (pdi >= mdi ? 'up' : 'down') : 'range';
  const vol: Vol = rank < 1 / 3 ? 'low' : rank > 2 / 3 ? 'high' : 'normal';
  return { trend, vol };
}

/** Regime at entry: uses the last completed 4H bar strictly before the entry's bar. */
export function tagAt(rs: RegimeSeries, b: Bars, entryUtc: number): RegimeTag | null {
  const bi = indexAtOrBefore(b.t, b.n, entryUtc);
  if (bi < 0) return null;
  const k = rs.agg.baseToAgg[bi] - 1;
  if (k < 0 || !rs.ready[k]) return null;
  const { trend, vol } = classify(rs.adx[k], rs.pdi[k], rs.mdi[k], rs.volRank[k]);
  return { trend, vol, adx: +rs.adx[k].toFixed(1), atrPct: +rs.atrPct[k].toFixed(6) };
}
