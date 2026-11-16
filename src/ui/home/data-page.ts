import { fmtDate } from './shared';
import { coinPicker } from './session-dialogs';
import type { DatasetMeta } from '../../core/types';
import { tfSeconds } from '../../core/timeframe';
import { parseCsv } from '../../data/csv';
import { generateSynthetic } from '../../data/synthetic';
import { deleteDataset, updateDatasetMeta, getDatasetMeta, loadBars } from '../../data/store';
import { storeBars, canRefresh, refreshDataset } from '../../data/ingest';
import { PROVIDERS, providerInfo, fetchCandles, datasetId, sourceOf, getTdKey, setTdKey, refreshSource, type ProviderId } from '../../data/providers';
import { cloudState, uploadDataset, listCloudDatasets, downloadDataset, deleteCloudDataset } from '../../data/cloud';
import { authModal } from '../cloudui';
import { hlCandles, hlSpec, hlSymbol, pickInterval, HL_MAX_CANDLES, type HlCoin } from '../../data/hyperliquid';
import { barsFromRows } from '../../core/types';
import { h, toast, modal, field, download, numField } from '../dom';
import { pageHead } from '../layout';

function hyperliquidModal(refresh: () => void) {
  let coin: HlCoin | null = null;
  const now = Math.floor(Date.now() / 1000);
  const from = h('input', { type: 'date', value: new Date((now - 30 * 86400) * 1000).toISOString().slice(0, 10) });
  const note = h('small', { class: 'muted' });
  const upd = () => {
    const f = Date.parse(from.value) / 1000;
    if (!isFinite(f)) return void (note.textContent = '');
    const iv = pickInterval(f, now);
    note.textContent = `Hyperliquid only serves the latest ${HL_MAX_CANDLES.toLocaleString('en-US')} candles per interval, so this range downloads as ${iv.id} bars${iv.id === '1m' ? '' : ' (pick a later start for 1-minute data)'}.`;
  };
  from.oninput = upd;
  upd();
  const picker = coinPicker((c) => (coin = c));
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const status = h('div', { class: 'muted small' });
  const go = h('button', { class: 'primary' }, 'Download');
  const ctrl = new AbortController();
  const close = modal(
    'Download from Hyperliquid',
    h('div', { class: 'stack' }, field('Market (perpetuals)', picker), field('From (UTC) — up to now', from), note, bar, status, go),
    { onClose: () => ctrl.abort() },
  );
  go.onclick = async () => {
    if (!coin) return toast('Pick a market first', 'err');
    const c = coin;
    const f = Date.parse(from.value) / 1000;
    if (!isFinite(f) || f >= now) return toast('Pick a start date in the past', 'err');
    go.disabled = true;
    try {
      const iv = pickInterval(f, now);
      const rows = await hlCandles(c.name, iv.id, f, now, {
        signal: ctrl.signal,
        onProgress: (p, n) => {
          (bar.firstChild as HTMLElement).style.width = `${p * 100}%`;
          status.textContent = `${n.toLocaleString('en-US')} bars…`;
        },
      });
      if (!rows.length) throw new Error(`No candles returned for ${c.name}`);
      const bars = barsFromRows(rows);
      const id = hlSymbol(c.name);
      const old = await getDatasetMeta(id);
      if (old && old.resolution !== iv.sec)
        throw new Error(`${id} is already stored as ${tfSeconds(old.resolution).label} bars — delete it first to download ${iv.id} bars.`);
      const meta = await storeBars(id, bars, 'hyperliquid', true, hlSpec(c.name, c.szDecimals, bars.c[bars.n - 1]), {
        provider: 'hyperliquid',
        symbol: c.name,
      });
      toast(`${meta.symbol}: ${meta.count.toLocaleString('en-US')} bars saved`, 'ok');
      close();
      refresh();
    } catch (e) {
      toast(String((e as Error).message ?? e), 'err');
      status.textContent = String((e as Error).message ?? e);
      go.disabled = false;
    }
  };
}

// ---- data manager ------------------------------------------------------------

export function renderData(page: HTMLElement, datasets: DatasetMeta[], refresh: () => void) {
  page.append(
    pageHead({
      eyebrow: 'Market data',
      titleHtml: 'Your market <em>data</em>.',
      compact: true,
      lead: 'Everything is stored in this browser. One-minute data gives exact fills and lets you replay any timeframe. Only real market data (CSV or an exchange/API download) can be ranked on the leaderboard; synthetic data is for practice.',
      actions: [
        h('button', { class: 'primary', onclick: () => importCsvModal(refresh) }, 'Import CSV'),
        h('button', { class: 'primary', onclick: () => exchangeModal(refresh) }, 'Connect exchange / API'),
        h('button', { class: 'ghost', onclick: () => hyperliquidModal(refresh) }, 'Hyperliquid (perps)'),
        datasets.some(canRefresh)
          ? h(
              'button',
              {
                class: 'ghost',
                title: 'Download the newest bars for every dataset that came from an API',
                onclick: (e: Event) => void updateAll(e.target as HTMLButtonElement, datasets, refresh),
              },
              'Update all',
            )
          : null,
        h('button', { class: 'ghost', onclick: () => syntheticModal(refresh) }, 'Generate synthetic'),
      ],
    }),
  );
  const main = h('div', { class: 'wrap page-body' });
  page.append(main);
  const t = h(
    'table',
    { class: 'tbl data-tbl' },
    h('thead', {
      html: '<tr><th>Symbol</th><th>Source</th><th>Base TF</th><th>From (UTC)</th><th>To (UTC)</th><th>Bars</th><th>Pip size</th><th>Contract/lot</th><th>Digits</th><th></th></tr>',
    }),
  );
  const tb = h('tbody');
  for (const d of datasets) {
    const pip = h('input', { type: 'number', step: 'any', value: d.spec.pipSize, class: 'sm' });
    const cs = h('input', { type: 'number', step: 'any', value: d.spec.contractSize, class: 'sm' });
    const dg = h('input', { type: 'number', step: 1, value: d.spec.digits, class: 'sm' });
    const upd = async () => {
      const ps = +pip.value,
        c = +cs.value,
        g = +dg.value;
      if (!(ps > 0) || !isFinite(ps) || !(c > 0) || !isFinite(c) || !Number.isInteger(g) || g < 0 || g > 10) {
        pip.value = String(d.spec.pipSize);
        cs.value = String(d.spec.contractSize);
        dg.value = String(d.spec.digits);
        return toast('Pip size and contract size must be above zero; digits a whole number from 0 to 10', 'err');
      }
      d.spec = { ...d.spec, pipSize: ps, contractSize: c, digits: g };
      await updateDatasetMeta(d);
      toast(`${d.symbol} spec saved (applies to new sessions)`, 'ok');
    };
    pip.onchange = cs.onchange = dg.onchange = upd;
    tb.append(
      h(
        'tr',
        {},
        h('td', {}, h('b', {}, d.symbol)),
        h(
          'td',
          {},
          h(
            'span',
            {
              class: `badge${d.source === 'synthetic' ? '' : ' accent'}`,
              title: d.source === 'synthetic' ? 'Practice data — scored but never ranked' : 'Real market data',
            },
            d.source,
          ),
        ),
        h('td', {}, tfSeconds(d.resolution).label),
        h('td', {}, fmtDate(d.from)),
        h('td', {}, fmtDate(d.to)),
        h('td', {}, d.count.toLocaleString('en-US')),
        h('td', {}, pip),
        h('td', {}, cs),
        h('td', {}, dg),
        h(
          'td',
          { class: 'acts' },
          canRefresh(d)
            ? h(
                'button',
                {
                  class: 'mini',
                  title: `Download bars newer than ${fmtDate(d.to)} from ${providerInfo(refreshSource(d)!.provider).label}`,
                  onclick: (e: Event) => void updateOne(e.target as HTMLButtonElement, d, refresh),
                },
                'Update',
              )
            : null,
          h(
            'button',
            {
              class: 'mini',
              title: 'Upload to your cloud so your other devices can use it',
              onclick: async (e: Event) => {
                if (!cloudState().user) return authModal();
                const b = e.target as HTMLButtonElement;
                b.disabled = true;
                b.textContent = '…';
                try {
                  const size = await uploadDataset(d);
                  toast(`${d.symbol} uploaded (${(size / 1e6).toFixed(1)} MB)`, 'ok');
                  refresh();
                } catch (err) {
                  toast((err as Error).message, 'err');
                  b.disabled = false;
                  b.textContent = 'Upload';
                }
              },
            },
            'Upload',
          ),
          h('button', { class: 'mini', title: 'Download as CSV (UTC)', onclick: () => exportDataset(d) }, 'CSV'),
          h(
            'button',
            {
              class: 'mini danger',
              onclick: async () => {
                if (!confirm(`Delete ${d.symbol} data? Sessions using it will not open.`)) return;
                await deleteDataset(d.id);
                refresh();
              },
            },
            'Delete',
          ),
        ),
      ),
    );
  }
  if (!datasets.length)
    tb.append(
      h('tr', {}, h('td', { colspan: 10, class: 'empty' }, 'No data yet — import a CSV, connect an exchange / data API, or generate synthetic practice data.')),
    );
  t.append(tb);
  main.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, t)));
  if (cloudState().user) main.append(cloudDataCard(datasets, refresh));
  main.append(importGuide(refresh));
  main.append(
    h(
      'section',
      { class: 'card help' },
      h('div', { class: 'card-title' }, h('span', {}, 'Where to get free historical data')),
      h(
        'ul',
        {},
        h('li', {
          html: '<b>Forex 1-minute (free):</b> histdata.com → “ASCII / 1 Minute Bar Quotes”. Their timestamps are EST without DST → use source offset <code>-5</code>.',
        }),
        h('li', { html: '<b>Dukascopy:</b> dukascopy.com Historical Data Feed (or the <code>dukascopy-node</code> CLI) → export 1-minute CSV in UTC.' }),
        h('li', { html: '<b>MetaTrader 4/5:</b> History Center / Symbols → Bars → Export. Timestamps are broker server time (often UTC+2/+3).' }),
        h('li', {
          html: '<b>Crypto (no key):</b> Connect exchange / API → Binance, Bybit or OKX, or the Hyperliquid button. Downloads 1-minute candles straight from the public APIs.',
        }),
        h('li', {
          html: '<b>Forex, gold, indices, stocks:</b> Connect exchange / API → Twelve Data (free key from twelvedata.com), e.g. <code>XAU/USD</code>, <code>EUR/USD</code>, <code>AAPL</code>.',
        }),
        h('li', {
          html: 'Datasets from an API have an <b>Update</b> button that downloads everything newer than the last bar, so a replay never runs out of data.',
        }),
        h('li', {
          html: 'Importing the same symbol again <b>merges</b> the data, so you can add a year at a time. Any base resolution works (1m recommended; 1s/5s/tick-bars work too).',
        }),
      ),
    ),
  );
}

function importCsvModal(refresh: () => void) {
  const file = h('input', { type: 'file', accept: '.csv,.txt,.tsv', multiple: true });
  const sym = h('input', { placeholder: 'e.g. EURUSD (defaults to file name)' });
  const off = h('input', { type: 'number', value: 0, step: 0.5 });
  const merge = h('input', { type: 'checkbox', checked: true });
  const status = h('div', { class: 'muted small' });
  const warn = h('div', { class: 'callout warn hidden' });
  const go = h('button', { class: 'primary' }, 'Import');
  const checkWarn = async () => {
    const symbol = (
      sym.value ||
      (file.files?.[0]?.name ?? '')
        .replace(/\.[^.]+$/, '')
        .replace(/^DAT_ASCII_|_M1.*$/gi, '')
        .split(/[_\s-]/)[0]
    ).toUpperCase();
    const m = symbol ? await getDatasetMeta(symbol) : undefined;
    const show = !!m && m.source === 'synthetic' && merge.checked;
    warn.classList.toggle('hidden', !show);
    warn.textContent = show
      ? `${symbol} already holds synthetic practice data. Merging keeps it marked as synthetic (never ranked). Untick “Merge” to replace it with your real data.`
      : '';
  };
  sym.oninput = file.onchange = merge.onchange = () => void checkWarn();
  const close = modal(
    'Import OHLC CSV',
    h(
      'div',
      { class: 'stack' },
      field('CSV file(s)', file, 'MT4/MT5, HistData, Dukascopy, Binance or any time,open,high,low,close[,volume] layout — auto-detected.'),
      h('div', { class: 'row2' }, field('Symbol', sym), field('Timestamps are in UTC offset (hours)', off, 'HistData: -5 · MT4 servers: often 2 or 3')),
      h('label', { class: 'check' }, merge, ' Merge with existing data for this symbol'),
      warn,
      status,
      go,
    ),
  );
  go.onclick = async () => {
    const files = [...(file.files ?? [])];
    if (!files.length) return toast('Choose a file', 'err');
    go.disabled = true;
    try {
      const offHours = +off.value;
      if (!isFinite(offHours) || Math.abs(offHours) > 14) throw new Error('The UTC offset must be between −14 and +14 hours');
      const seen = new Set<string>();
      for (const f of files) {
        status.textContent = `Parsing ${f.name}…`;
        const symbol = (
          sym.value.trim() ||
          f.name
            .replace(/\.[^.]+$/, '')
            .replace(/^DAT_ASCII_|_M1.*$/gi, '')
            .split(/[_\s-]/)[0]
        )
          .toUpperCase()
          .replace(/[^A-Z0-9:._/-]/g, '');
        if (!symbol) throw new Error(`Type a symbol name for ${f.name}`);
        let bars: ReturnType<typeof parseCsv>;
        try {
          bars = parseCsv(await f.text(), offHours);
        } catch (e) {
          throw new Error(`${f.name}: ${(e as Error).message}`);
        }
        // several files for one symbol are parts of the same history, whatever the tick box says
        const meta = await storeBars(symbol, bars, 'csv', merge.checked || seen.has(symbol));
        seen.add(symbol);
        status.textContent = `${meta.symbol}: ${meta.count.toLocaleString('en-US')} bars`;
      }
      toast('Import complete', 'ok');
      close();
      refresh();
    } catch (e) {
      toast(String((e as Error).message ?? e), 'err');
      status.textContent = String((e as Error).message ?? e);
      go.disabled = false;
      refresh(); // files before the failing one are already stored
    }
  };
}

async function updateOne(btn: HTMLButtonElement, d: DatasetMeta, refresh: () => void) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '…';
  try {
    const { added, meta } = await refreshDataset(d, { onProgress: (_p, n, msg) => (btn.textContent = msg ? '⏳' : `${n.toLocaleString('en-US')}…`) });
    toast(added ? `${d.symbol}: +${added.toLocaleString('en-US')} bars, now up to ${fmtDate(meta.to)}` : `${d.symbol} is already up to date`, 'ok');
    refresh();
  } catch (e) {
    toast(`${d.symbol}: ${(e as Error).message}`, 'err');
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function updateAll(btn: HTMLButtonElement, datasets: DatasetMeta[], refresh: () => void) {
  btn.disabled = true;
  const list = datasets.filter(canRefresh);
  let ok = 0,
    bars = 0;
  for (const [i, d] of list.entries()) {
    btn.textContent = `Updating ${i + 1}/${list.length}…`;
    try {
      bars += (await refreshDataset(d)).added;
      ok++;
    } catch (e) {
      toast(`${d.symbol}: ${(e as Error).message}`, 'err');
    }
  }
  toast(`${ok}/${list.length} datasets updated, +${bars.toLocaleString('en-US')} bars`, ok ? 'ok' : 'err');
  refresh();
}

function exchangeModal(refresh: () => void) {
  const prov = h(
    'select',
    {},
    ...PROVIDERS.filter((p) => p.id !== 'hyperliquid').map((p) => h('option', { value: p.id }, `${p.label}${p.needsKey ? ' (free key)' : ''}`)),
  );
  const sym = h('input', { value: 'BTCUSDT', autocomplete: 'off' });
  const key = h('input', { type: 'password', value: getTdKey(), placeholder: 'Paste your Twelve Data API key', autocomplete: 'off' });
  const keyRow = field(
    'API key',
    key,
    'Stored only in this browser — never synced, uploaded or put in backups. Free key: twelvedata.com → Sign up → API keys.',
  );
  const note = h('small', { class: 'muted' });
  const idNote = h('small', { class: 'muted' });
  const now = Math.floor(Date.now() / 1000);
  const from = h('input', { type: 'date', value: new Date((now - 90 * 86400) * 1000).toISOString().slice(0, 10) });
  const to = h('input', { type: 'date', value: new Date(now * 1000).toISOString().slice(0, 10) });
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const status = h('div', { class: 'muted small' });
  const go = h('button', { class: 'primary' }, 'Download');
  const ctrl = new AbortController();
  const p = () => prov.value as ProviderId;
  const upd = () => {
    const info = providerInfo(p());
    note.textContent = `${info.markets}. ${info.note}`;
    keyRow.classList.toggle('hidden', !info.needsKey);
    sym.placeholder = info.example;
    idNote.textContent = sym.value.trim() ? `Saved as ${datasetId(p(), sym.value)}` : '';
  };
  prov.onchange = () => {
    sym.value = providerInfo(p()).example;
    if (p() === 'twelvedata') from.value = new Date((now - 30 * 86400) * 1000).toISOString().slice(0, 10);
    upd();
  };
  sym.oninput = upd;
  upd();
  const close = modal(
    'Connect an exchange or data API',
    h(
      'div',
      { class: 'stack' },
      h(
        'p',
        { class: 'muted small' },
        'Real candles are downloaded straight from the provider into this browser — no account needed except the free Twelve Data key for forex, gold and stocks. Datasets get an Update button so you can extend them to today later.',
      ),
      field('Provider', prov),
      note,
      h('div', { class: 'row2' }, field('Symbol', sym), keyRow),
      idNote,
      h('div', { class: 'row2' }, field('From (UTC)', from), field('To (UTC)', to)),
      bar,
      status,
      go,
    ),
    { onClose: () => ctrl.abort() },
  );
  go.onclick = async () => {
    const id = p();
    const f = Date.parse(from.value) / 1000,
      t = Math.min(now, Date.parse(to.value) / 1000 + 86400);
    if (!isFinite(f) || !isFinite(t) || t <= f) return toast('Pick a valid date range', 'err');
    if (providerInfo(id).needsKey) {
      if (!key.value.trim()) return toast('Paste your Twelve Data API key first', 'err');
      setTdKey(key.value);
    }
    const dsId = datasetId(id, sym.value);
    const old = await getDatasetMeta(dsId);
    let merge = true;
    if (old?.source === 'synthetic') {
      if (!confirm(`${dsId} currently holds synthetic demo data. Replace it with real ${providerInfo(id).label} data? Sessions on ${dsId} keep their trades.`))
        return;
      merge = false;
    }
    go.disabled = true;
    try {
      const bars = await fetchCandles(id, sym.value, f, t, {
        signal: ctrl.signal,
        key: key.value.trim() || undefined,
        onProgress: (pc, n, msg) => {
          (bar.firstChild as HTMLElement).style.width = `${pc * 100}%`;
          status.textContent = msg ?? `${n.toLocaleString('en-US')} bars…`;
        },
      });
      const symbol = sym.value.trim().toUpperCase();
      const meta = await storeBars(dsId, bars, sourceOf(id), merge, undefined, { provider: id, symbol: id === 'okx' ? symbol : symbol.replace(/\s+/g, '') });
      toast(`${meta.symbol}: ${meta.count.toLocaleString('en-US')} bars saved (${fmtDate(meta.from).slice(0, 10)} → ${fmtDate(meta.to).slice(0, 10)})`, 'ok');
      close();
      refresh();
    } catch (e) {
      const m = String((e as Error).message ?? e);
      toast(m, 'err');
      status.textContent = m;
      go.disabled = false;
    }
  };
}

function syntheticModal(refresh: () => void) {
  const sym = h('input', { value: 'SYNTH' });
  const price = h('input', { type: 'number', value: 1.1, step: 'any' });
  const days = h('input', { type: 'number', value: 180, min: 1, max: 1500 });
  const vol = h('input', { type: 'number', value: 10, step: 1, min: 1 });
  const seed = h('input', { type: 'number', value: Math.floor(Math.random() * 1e6) });
  const start = h('input', { type: 'date', value: '2024-01-01' });
  const go = h('button', { class: 'primary' }, 'Generate');
  const close = modal(
    'Generate synthetic 1-minute data',
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row2' }, field('Symbol', sym), field('Start price', price)),
      h('div', { class: 'row2' }, field('Days', days), field('Annual volatility (%)', vol)),
      h('div', { class: 'row2' }, field('Start date', start), field('Random seed', seed)),
      go,
    ),
  );
  go.onclick = async () => {
    // "days" is one-minute bars × 1,440: an unchecked typo here would freeze the tab
    let cfg: Parameters<typeof generateSynthetic>[0];
    const symbol = sym.value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9:._/-]/g, '');
    try {
      if (!symbol) throw new Error('Type a symbol name');
      const t0 = Date.parse(start.value) / 1000;
      if (!isFinite(t0) || t0 < 0 || t0 > Date.now() / 1000) throw new Error('Pick a start date in the past');
      cfg = {
        start: t0,
        days: numField(days, 'Days', 1, 1500, true),
        price: numField(price, 'Start price', 0.000001, 1e7),
        annualVol: numField(vol, 'Annual volatility (%)', 0.1, 500) / 100,
        seed: Math.floor(Math.abs(+seed.value)) || 1,
      };
    } catch (e) {
      return toast((e as Error).message, 'err');
    }
    go.disabled = true;
    try {
      await storeBars(symbol, generateSynthetic(cfg), 'synthetic');
      toast('Generated', 'ok');
      close();
      refresh();
    } catch (e) {
      go.disabled = false;
      toast(String((e as Error).message ?? e), 'err');
    }
  };
}

/** Step-by-step: how to bring price data in, with a sample file in the accepted layout. */
function importGuide(refresh: () => void) {
  const sample = () => {
    const today = Math.floor(Date.now() / 86400000) * 86400;
    const b = generateSynthetic({ start: today - 2 * 86400, days: 1, price: 1.1, annualVol: 0.08, seed: 7 });
    const lines = ['time,open,high,low,close,volume'];
    for (let i = 0; i < b.n; i++)
      lines.push(
        `${new Date(b.t[i] * 1000).toISOString().slice(0, 19).replace('T', ' ')},${b.o[i].toFixed(5)},${b.h[i].toFixed(5)},${b.l[i].toFixed(5)},${b.c[i].toFixed(5)},${Math.round(b.v[i])}`,
      );
    download('SAMPLE_1m.csv', lines.join('\n'));
  };
  const step = (n: string, title: string, body: HTMLElement | string) =>
    h('div', { class: 'point' }, h('span', { class: 'n' }, n), h('h5', {}, title), typeof body === 'string' ? h('p', {}, body) : body);
  return h(
    'section',
    { class: 'card stack import-guide' },
    h('div', { class: 'card-title' }, h('span', {}, 'How to import price data')),
    h(
      'div',
      { class: 'points' },
      step(
        '01',
        'Get candles',
        h('p', {
          html: 'Download 1-minute bars as CSV — HistData, Dukascopy (<code>npx dukascopy-node</code>), or MT4/MT5 History Center → Export. For crypto, forex, gold and stocks you can skip files: use <b>Connect exchange / API</b> above.',
        }),
      ),
      step(
        '02',
        'Import CSV',
        h('p', {
          html: 'Click <b>Import CSV</b>, pick one or more files, type the symbol (e.g. <code>XAUUSD</code>) and the timezone offset of the timestamps: HistData <code>-5</code>, MT4/MT5 usually <code>2</code> or <code>3</code>, Dukascopy/Binance <code>0</code>. Importing the same symbol again merges the files.',
        }),
      ),
      step(
        '03',
        'Check & replay',
        h('p', {
          html: 'The table shows each symbol with its first and last bar. Create a session with a start date inside that range — the New session form shows the exact window.',
        }),
      ),
    ),
    h('p', {
      class: 'muted small',
      html: 'Accepted columns (auto-detected, header optional): <code>time,open,high,low,close[,volume]</code> · <code>2024.01.02,00:00,o,h,l,c,v</code> (MT4/MT5) · <code>20240102 170000;o;h;l;c;v</code> (HistData) · <code>02.01.2024 00:00:00.000,o,h,l,c,v</code> (Dukascopy) · Unix seconds/ms timestamps (Binance).',
    }),
    h(
      'p',
      { class: 'muted small' },
      'Have a list of closed trades instead (e.g. an FX Replay export)? Use “Import trades” on the Sessions page to get the score and Monte Carlo straight away.',
    ),
    h(
      'div',
      { class: 'row-btns' },
      h('button', { class: 'ghost', onclick: sample }, 'Download sample CSV'),
      h('button', { class: 'primary', onclick: () => importCsvModal(refresh) }, 'Import CSV'),
    ),
  );
}

async function exportDataset(d: DatasetMeta) {
  const b = await loadBars(d.id);
  if (!b) return;
  const lines = ['time,open,high,low,close,volume'];
  for (let i = 0; i < b.n; i++)
    lines.push(`${new Date(b.t[i] * 1000).toISOString().slice(0, 19).replace('T', ' ')},${b.o[i]},${b.h[i]},${b.l[i]},${b.c[i]},${b.v[i]}`);
  download(`${d.symbol}_${tfSeconds(d.resolution).label}.csv`, lines.join('\n'));
}

function cloudDataCard(local: DatasetMeta[], refresh: () => void) {
  const body = h('div', { class: 'muted small' }, 'Loading…');
  const card = h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('span', {}, '☁ Market data in your cloud')), body);
  void listCloudDatasets()
    .then((files) => {
      body.innerHTML = '';
      if (!files.length) {
        body.textContent = 'Nothing uploaded yet — press ☁ next to a symbol above.';
        return;
      }
      const have = new Set(local.map((d) => d.id));
      const t = h('table', { class: 'tbl' }, h('thead', { html: '<tr><th>Symbol</th><th>Size</th><th>Uploaded</th><th>On this device</th><th></th></tr>' }));
      const tb = h('tbody');
      for (const f of files) {
        tb.append(
          h(
            'tr',
            {},
            h('td', {}, h('b', {}, f.id)),
            h('td', {}, `${(f.size / 1e6).toFixed(1)} MB`),
            h('td', {}, f.updated.slice(0, 16).replace('T', ' ')),
            h('td', {}, have.has(f.id) ? '✓' : '—'),
            h(
              'td',
              { class: 'acts' },
              h(
                'button',
                {
                  class: 'mini',
                  onclick: async (e: Event) => {
                    (e.target as HTMLButtonElement).disabled = true;
                    try {
                      const m = await downloadDataset(f.id);
                      toast(`${m.symbol}: ${m.count.toLocaleString('en-US')} bars downloaded`, 'ok');
                      refresh();
                    } catch (err) {
                      toast((err as Error).message, 'err');
                    }
                  },
                },
                have.has(f.id) ? 'Re-download' : 'Download',
              ),
              h(
                'button',
                {
                  class: 'mini danger',
                  onclick: async () => {
                    if (!confirm(`Delete ${f.id} from the cloud? Local copies are kept.`)) return;
                    await deleteCloudDataset(f.id);
                    refresh();
                  },
                },
                'Delete',
              ),
            ),
          ),
        );
      }
      t.append(tb);
      body.append(h('div', { class: 'table-wrap' }, t));
    })
    .catch((e) => (body.textContent = 'Could not list cloud data: ' + (e as Error).message));
  return card;
}
