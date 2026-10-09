import { describe, expect, it } from 'vitest';
import { datasetId, fetchCandles, refreshSource, sourceOf } from '../src/data/providers';
import type { DatasetMeta } from '../src/core/types';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
const noSleep = async () => {};
const MIN = 60;
const T0 = 1_700_000_040; // a whole minute

describe('provider naming', () => {
  it('maps symbols to dataset ids and sources', () => {
    expect(datasetId('binance', 'btcusdt')).toBe('BTCUSDT');
    expect(datasetId('binance-futures', 'BTCUSDT')).toBe('BTCUSDT.P');
    expect(datasetId('bybit-linear', 'ETHUSDT')).toBe('BYBIT-ETHUSDT.P');
    expect(datasetId('okx', 'BTC-USDT-SWAP')).toBe('OKX-BTCUSDTSWAP');
    expect(datasetId('twelvedata', 'XAU/USD')).toBe('XAUUSD');
    expect(sourceOf('bybit-linear')).toBe('bybit');
  });
  it('infers how to refresh older datasets', () => {
    const m = (o: Partial<DatasetMeta>) => ({ id: 'X', symbol: 'X', source: 'csv', resolution: 60, from: 0, to: 0, count: 0, spec: { symbol: 'X', pipSize: 1, contractSize: 1, digits: 2 }, createdAt: 0, ...o }) as DatasetMeta;
    expect(refreshSource(m({ id: 'BTCUSDT.P', source: 'binance' }))).toEqual({ provider: 'binance-futures', symbol: 'BTCUSDT' });
    expect(refreshSource(m({ id: 'HL-ETH', source: 'hyperliquid' }))).toEqual({ provider: 'hyperliquid', symbol: 'ETH' });
    expect(refreshSource(m({ source: 'csv' }))).toBeNull();
    expect(refreshSource(m({ source: 'twelvedata', provider: { provider: 'twelvedata', symbol: 'XAU/USD' } }))).toEqual({ provider: 'twelvedata', symbol: 'XAU/USD' });
  });
});

describe('Bybit', () => {
  it('walks newest-first pages back to the start', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      const end = +new URL(u).searchParams.get('end')!;
      const list = [];
      for (let t = Math.floor(end / 60000) * 60000; t >= 0 && list.length < 1000; t -= 60000) list.push([String(t), '1', '2', '0.5', '1.5', '10', '0']);
      return json({ retCode: 0, retMsg: 'OK', result: { list } });
    }) as typeof fetch;
    const b = await fetchCandles('bybit', 'BTCUSDT', T0, T0 + 1500 * MIN, { fetch: f, sleep: noSleep });
    expect(urls.length).toBe(2);
    expect(urls[0]).toContain('category=spot');
    expect(b.n).toBe(1501);
    expect(b.t[0]).toBe(T0);
    expect(b.t[b.n - 1]).toBe(T0 + 1500 * MIN);
  });
  it('surfaces API errors', async () => {
    const f = (async () => json({ retCode: 10001, retMsg: 'Not supported symbols' })) as unknown as typeof fetch;
    await expect(fetchCandles('bybit-linear', 'NOPE', 0, 600, { fetch: f, sleep: noSleep })).rejects.toThrow(/Bybit: Not supported symbols/);
  });
});

describe('OKX', () => {
  it('pages with `after` until the range is covered', async () => {
    let calls = 0;
    const f = (async (u: string) => {
      calls++;
      const after = +new URL(u).searchParams.get('after')!;
      const data = [];
      for (let t = Math.ceil(after / 60000) * 60000 - 60000; t >= 0 && data.length < 100; t -= 60000) data.push([String(t), '1', '2', '0.5', '1.5', '3', '0', '0', '1']);
      return json({ code: '0', msg: '', data });
    }) as typeof fetch;
    const b = await fetchCandles('okx', 'BTC-USDT', T0, T0 + 250 * MIN, { fetch: f, sleep: noSleep });
    expect(b.n).toBe(251);
    expect(calls).toBe(3);
    expect(b.t[0]).toBe(T0);
  });
});

describe('Twelve Data', () => {
  const page = (endIso: string, n: number) => {
    const end = Date.parse(endIso.replace(' ', 'T') + 'Z') / 1000;
    return Array.from({ length: n }, (_, i) => {
      const t = new Date((end - i * 60) * 1000).toISOString().slice(0, 19).replace('T', ' ');
      return { datetime: t, open: '2000', high: '2001', low: '1999', close: '2000.5' };
    });
  };
  it('needs a key', async () => {
    await expect(fetchCandles('twelvedata', 'XAU/USD', 0, 600, { key: '', fetch: (async () => json({})) as unknown as typeof fetch })).rejects.toThrow(/API key/);
  });
  it('pages backwards, paces requests and waits out a 429', async () => {
    const sleeps: number[] = [];
    let call = 0;
    const f = (async (u: string) => {
      call++;
      const q = new URL(u).searchParams;
      expect(q.get('apikey')).toBe('k');
      expect(q.get('symbol')).toBe('XAU/USD');
      if (call === 2) return json({ status: 'error', code: 429, message: 'run out of API credits for the current minute' });
      const end = q.get('end_date')!;
      const start = Date.parse(q.get('start_date')!.replace(' ', 'T') + 'Z') / 1000;
      const endT = Date.parse(end.replace(' ', 'T') + 'Z') / 1000;
      const n = Math.min(5000, Math.floor((endT - start) / 60) + 1);
      return json({ status: 'ok', values: page(end, n) });
    }) as typeof fetch;
    const b = await fetchCandles('twelvedata', 'XAU/USD', T0, T0 + 7000 * MIN, { key: 'k', fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    expect(b.n).toBe(7001);
    expect(b.t[0]).toBe(T0);
    expect(sleeps).toContain(7600);
    expect(sleeps.filter((x) => x === 5000).length).toBe(12); // 60 s countdown
  });
  it('reports a bad symbol', async () => {
    const f = (async () => json({ status: 'error', code: 400, message: '**symbol** not found: XXX' })) as unknown as typeof fetch;
    await expect(fetchCandles('twelvedata', 'XXX', 0, 600, { key: 'k', fetch: f, sleep: noSleep })).rejects.toThrow(/Twelve Data: \*\*symbol\*\* not found/);
  });
});
