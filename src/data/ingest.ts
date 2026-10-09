import { detectResolution, guessSpec, mergeBars, type Bars, type DatasetMeta, type InstrumentSpec } from '../core/types';
import { getDatasetMeta, loadBars, saveDataset } from './store';
import { fetchCandles, refreshSource, type FetchOpts } from './providers';

/** Save bars as a dataset, optionally merging into what is stored under the same id. */
export async function storeBars(
  symbol: string, bars: Bars, source: DatasetMeta['source'], merge = false, spec?: InstrumentSpec,
  provider?: DatasetMeta['provider'],
): Promise<DatasetMeta> {
  const id = symbol.toUpperCase();
  const oldMeta = merge ? await getDatasetMeta(id) : undefined;
  if (merge) {
    const old = await loadBars(id);
    if (old) {
      if (oldMeta && oldMeta.resolution !== detectResolution(bars) && bars.n > 1)
        throw new Error(`${id} is stored as ${oldMeta.resolution / 60 >= 1 ? `${oldMeta.resolution / 60}-minute` : `${oldMeta.resolution}s`} bars — the new download has a different resolution. Delete ${id} first or download the same resolution.`);
      bars = mergeBars(old, bars);
      // practice data must never pass as real: a merge with synthetic bars stays synthetic
      if (oldMeta?.source === 'synthetic') source = 'synthetic';
    }
  }
  const meta: DatasetMeta = {
    id, symbol: id, source, resolution: oldMeta?.resolution ?? detectResolution(bars), from: bars.t[0], to: bars.t[bars.n - 1], count: bars.n,
    // keep a spec the user edited; new datasets get one guessed from the symbol and price
    spec: spec ?? oldMeta?.spec ?? guessSpec(id, bars.c[bars.n - 1]), createdAt: oldMeta?.createdAt ?? Date.now(),
    ...(provider ?? oldMeta?.provider ? { provider: provider ?? oldMeta!.provider } : {}),
  };
  await saveDataset(meta, bars);
  return meta;
}

/** True when the dataset knows which API it came from and can download newer bars. */
export const canRefresh = (m: DatasetMeta | undefined) => !!m && m.source !== 'synthetic' && !!refreshSource(m);

/**
 * Download bars newer than the dataset's last bar, up to now, and merge them in.
 * Returns the updated meta and how many bars were added.
 */
export async function refreshDataset(m: DatasetMeta, o: FetchOpts = {}): Promise<{ meta: DatasetMeta; added: number }> {
  const src = refreshSource(m);
  if (!src) throw new Error(`${m.symbol} was imported from a file — import a newer file to extend it.`);
  const now = Math.floor(Date.now() / 1000);
  const from = m.to + m.resolution;
  if (from > now - m.resolution) return { meta: m, added: 0 };
  let bars: Bars;
  try {
    bars = await fetchCandles(src.provider, src.symbol, from, now, { ...o, resolution: m.resolution });
  } catch (e) {
    if (/No candles returned/.test((e as Error).message)) return { meta: m, added: 0 };
    throw e;
  }
  const meta = await storeBars(m.id, bars, m.source, true, m.spec, src);
  return { meta, added: meta.count - m.count };
}
