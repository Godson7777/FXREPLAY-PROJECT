import { barsFromRows, type Bars } from '../core/types';

/**
 * Downloads 1-minute klines from Binance's public REST API (no key needed),
 * paging 1000 candles per request. Runs in the browser (CORS is allowed).
 */
export async function downloadBinance(
  symbol: string,
  from: number,
  to: number,
  onProgress?: (pct: number, bars: number) => void,
  signal?: AbortSignal,
  market: 'spot' | 'futures' = 'spot',
): Promise<Bars> {
  const base = market === 'spot' ? 'https://api.binance.com/api/v3/klines' : 'https://fapi.binance.com/fapi/v1/klines';
  const rows: number[][] = [];
  let cursor = from * 1000;
  const end = to * 1000;
  while (cursor < end) {
    if (signal?.aborted) throw new Error('Cancelled');
    const url = `${base}?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=1m&limit=1000&startTime=${cursor}&endTime=${end}`;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(url, { signal });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    if (!res || !res.ok) throw new Error(`Binance request failed${res ? ` (HTTP ${res.status})` : ''}`);
    const data = (await res.json()) as unknown[][];
    if (!data.length) break;
    for (const k of data) rows.push([Math.floor(+(k[0] as number) / 1000), +(k[1] as string), +(k[2] as string), +(k[3] as string), +(k[4] as string), +(k[5] as string)]);
    const last = +(data[data.length - 1][0] as number);
    cursor = last + 60000;
    onProgress?.(Math.min(1, (cursor - from * 1000) / (end - from * 1000)), rows.length);
  }
  if (!rows.length) throw new Error('No data returned — check the symbol (e.g. BTCUSDT) and dates');
  return barsFromRows(rows);
}
