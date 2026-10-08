import { guessSpec, detectResolution, mergeBars, type DatasetMeta, type Bars } from '../core/types';
import { tfSeconds } from '../core/timeframe';
import { ZONES } from '../core/tz';
import { parseCsv } from '../data/csv';
import { downloadBinance } from '../data/binance';
import { generateSynthetic } from '../data/synthetic';
import { saveDataset, listDatasets, deleteDataset, loadBars, updateDatasetMeta } from '../data/store';
import { cloudState, uploadDataset, listCloudDatasets, downloadDataset, deleteCloudDataset } from '../data/cloud';
import { cloudButton, authModal } from './cloudui';
import { listSessions, saveSession, deleteSession } from '../data/sessions';
import { computeStats } from '../analytics/stats';
import { newSession, type Session } from '../engine/replay';
import { PRESETS, type ChallengeRules } from '../engine/rules';
import { idb } from '../data/store';
import { h, money, pct, cls, toast, modal, field, dateInputValue, parseDateInput, download, themeButton } from './dom';

export const LOGO = `<svg class="logo-svg" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="otg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#e08a68"/><stop offset="1" stop-color="#c15f3c"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#otg)"/><rect x="7" y="17" width="4" height="8" rx="1" fill="#fff" opacity=".75"/><rect x="14" y="12" width="4" height="13" rx="1" fill="#fff" opacity=".88"/><rect x="21" y="7" width="4" height="18" rx="1" fill="#fff"/><path d="M5 12c3-4 6-4 9-1s6 3 9-2" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;

const fmtDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

export async function renderHome(root: HTMLElement, nav: (h: string) => void, tab: 'sessions' | 'data') {
  const [sessions, datasets] = await Promise.all([listSessions(), listDatasets()]);
  root.innerHTML = '';
  const page = h('div', { class: 'home' });
  root.append(page);
  page.append(
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'logo', html: LOGO }), h('b', {}, 'Overflow Trade'), h('small', {}, 'market replay & backtesting')),
      h('nav', { class: 'nav' },
        h('a', { href: '#/', class: tab === 'sessions' ? 'on' : '' }, 'Sessions'),
        h('a', { href: '#/data', class: tab === 'data' ? 'on' : '' }, `Data (${datasets.length})`),
        h('a', { href: '#/analytics/all' }, 'Analytics'),
      ),
      h('div', { class: 'spacer' }),
      cloudButton(),
      themeButton(),
    ),
  );
  const main = h('main', { class: 'home-main' });
  page.append(main);
  if (tab === 'data') return renderData(main, datasets, () => renderHome(root, nav, 'data'));

  if (!datasets.length && !sessions.length) {
    main.append(h('section', { class: 'hero' },
      h('div', { class: 'eyebrow' }, 'Overflow Trade'),
      h('h1', {}, 'Replay any market, bar by bar.'),
      h('p', {}, 'Backtest manually like it\'s live: hidden future, any timeframe you can type (7m, 2H, 3D…), multi-chart sync, a real order engine with SL/TP at 1-minute precision, and analytics deep enough to find your edge.'),
      h('div', { class: 'hero-actions' },
        h('button', { class: 'primary lg', onclick: async (e: Event) => { (e.target as HTMLButtonElement).disabled = true; await loadDemo(); renderHome(root, nav, 'sessions'); } }, '⚡ Load demo data (EURUSD · GBPUSD · XAUUSD)'),
        h('button', { class: 'ghost lg', onclick: () => nav('#/data') }, 'Import CSV / download BTC, ETH… from Binance'),
      ),
      h('p', { class: 'muted small' }, 'Demo data is synthetic (realistic-looking, generated in your browser). For real history, import CSVs from HistData.com, Dukascopy, MT4/MT5 or download crypto from Binance on the Data tab.'),
    ));
    return;
  }

  main.append(h('div', { class: 'section-head' },
    h('h2', {}, 'Backtesting sessions'),
    h('div', { class: 'row-btns' },
      h('button', { class: 'ghost', title: 'Download all sessions, trades, drawings & journal screenshots as one JSON file', onclick: () => exportBackup(sessions) }, '⭳ Backup'),
      h('button', { class: 'ghost', title: 'Restore sessions from a backup file', onclick: () => importBackup(() => renderHome(root, nav, 'sessions')) }, '⭱ Restore'),
      h('button', { class: 'primary', onclick: () => (datasets.length ? newSessionModal(datasets, async (s) => { await saveSession(s); nav(`#/replay/${s.id}`); }) : nav('#/data')) }, '+ New session'),
    ),
  ));
  if (!sessions.length) {
    main.append(h('div', { class: 'empty-state' }, h('h3', {}, 'No sessions yet'), h('p', {}, 'Create a session: pick symbols, a start date and your account size. Everything after the start date stays hidden until you replay it.')));
    return;
  }
  const grid = h('div', { class: 'cards' });
  for (const s of sessions) {
    const st = computeStats(s.state.broker.trades, s.balance);
    const bal = s.state.broker.balance;
    const card = h('article', { class: 'scard' },
      h('div', { class: 'scard-head' }, h('h3', {}, s.name),
        s.state.challenge
          ? h('span', { class: `badge ${s.state.challenge.status}` }, s.state.challenge.status === 'active' ? `🎯 ${s.rules?.name ?? 'Challenge'}` : s.state.challenge.status.toUpperCase())
          : s.state.finished ? h('span', { class: 'badge' }, 'Finished') : null),
      h('div', { class: 'muted small' }, `${s.symbols.join(' · ')} · started ${fmtDate(s.start).slice(0, 10)}`),
      h('div', { class: 'muted small' }, `Replay clock: ${fmtDate(s.state.clock - 1)} UTC`),
      h('div', { class: 'scard-stats' },
        h('div', {}, h('span', {}, 'Balance'), h('b', {}, money(bal))),
        h('div', {}, h('span', {}, 'Net'), h('b', { class: cls(bal - s.balance) }, pct((bal - s.balance) / s.balance, 2, true))),
        h('div', {}, h('span', {}, 'Trades'), h('b', {}, String(st.trades))),
        h('div', {}, h('span', {}, 'Win rate'), h('b', {}, st.trades ? pct(st.winRate) : '—')),
        h('div', {}, h('span', {}, 'PF'), h('b', {}, st.trades ? st.profitFactor.toFixed(2) : '—')),
      ),
      h('div', { class: 'scard-actions' },
        h('button', { class: 'primary', onclick: () => nav(`#/replay/${s.id}`) }, '▶ Continue'),
        h('button', { class: 'ghost', onclick: () => nav(`#/analytics/${s.id}`) }, '📊 Analytics'),
        h('button', { class: 'ghost', title: 'Duplicate settings into a fresh session', onclick: async () => {
          const copy = newSession({ ...s, id: uid(), name: s.name + ' (copy)', createdAt: Date.now() });
          await saveSession(copy);
          renderHome(root, nav, 'sessions');
        } }, '⧉'),
        h('button', { class: 'ghost danger', title: 'Delete', onclick: async () => {
          if (!confirm(`Delete session "${s.name}" and its ${st.trades} trades?`)) return;
          await deleteSession(s.id);
          renderHome(root, nav, 'sessions');
        } }, '🗑'),
      ),
    );
    grid.append(card);
  }
  main.append(grid);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function loadDemo() {
  const start = Math.floor(Date.UTC(2024, 0, 1) / 1000);
  const defs = [
    { sym: 'EURUSD', price: 1.1, vol: 0.07, seed: 11 },
    { sym: 'GBPUSD', price: 1.27, vol: 0.08, seed: 22 },
    { sym: 'XAUUSD', price: 2050, vol: 0.15, seed: 33 },
  ];
  for (const d of defs) {
    const bars = generateSynthetic({ start, days: 365, price: d.price, annualVol: d.vol, seed: d.seed });
    await storeBars(d.sym, bars, 'synthetic');
  }
  toast('Demo data ready — create a session!', 'ok');
}

async function storeBars(symbol: string, bars: Bars, source: DatasetMeta['source'], merge = false): Promise<DatasetMeta> {
  const id = symbol.toUpperCase();
  if (merge) {
    const old = await loadBars(id);
    if (old) bars = mergeBars(old, bars);
  }
  const meta: DatasetMeta = {
    id, symbol: id, source, resolution: detectResolution(bars), from: bars.t[0], to: bars.t[bars.n - 1], count: bars.n,
    spec: guessSpec(id, bars.c[bars.n - 1]), createdAt: Date.now(),
  };
  await saveDataset(meta, bars);
  return meta;
}

// ---- new session -------------------------------------------------------------

function newSessionModal(datasets: DatasetMeta[], done: (s: Session) => void) {
  const name = h('input', { value: `Backtest ${new Date().toISOString().slice(0, 10)}` });
  const boxes = datasets.map((d, i) => ({ d, cb: h('input', { type: 'checkbox', checked: i === 0 }) }));
  const symList = h('div', { class: 'sym-list' }, ...boxes.map(({ d, cb }) =>
    h('label', { class: 'check' }, cb, ` ${d.symbol} `, h('small', { class: 'muted' }, `${fmtDate(d.from).slice(0, 10)} → ${fmtDate(d.to).slice(0, 10)} · ${tfSeconds(d.resolution).label}`))));
  const d0 = datasets[0];
  const defStart = d0.from + Math.min(30 * 86400, (d0.to - d0.from) / 4);
  const start = h('input', { type: 'datetime-local', value: dateInputValue(defStart) });
  const end = h('input', { type: 'datetime-local' });
  const bal = h('input', { type: 'number', value: 10000, min: 1, step: 100 });
  const risk = h('input', { type: 'number', value: 1, min: 0.01, step: 0.25 });
  const comm = h('input', { type: 'number', value: 3.5, min: 0, step: 0.1 });
  const spread = h('input', { type: 'number', value: 0.8, min: 0, step: 0.1 });
  const tz = h('select', {}, ...ZONES.map((z) => h('option', { value: z, selected: z === 'Asia/Jakarta' }, z)));
  const preset = h('select', {}, h('option', { value: '' }, 'None — free backtesting'), ...PRESETS.map((p, i) => h('option', { value: i }, p.name)), h('option', { value: 'custom' }, 'Custom rules…'));
  const target = h('input', { type: 'number', value: 10, step: 0.5, min: 0 });
  const daily = h('input', { type: 'number', value: 5, step: 0.5, min: 0 });
  const total = h('input', { type: 'number', value: 10, step: 0.5, min: 0 });
  const days = h('input', { type: 'number', value: 4, step: 1, min: 0 });
  const trailing = h('input', { type: 'checkbox' });
  const stop = h('input', { type: 'checkbox', checked: true });
  const ruleBox = h('div', { class: 'stack hidden' },
    h('div', { class: 'row2' }, field('Profit target (%)', target), field('Max daily loss (%)', daily)),
    h('div', { class: 'row2' }, field('Max total loss (%)', total), field('Min trading days', days)),
    h('label', { class: 'check' }, trailing, ' Trailing max loss (follows the equity high)'),
    h('label', { class: 'check' }, stop, ' Close everything and lock trading when a limit is breached'),
  );
  preset.onchange = () => {
    ruleBox.classList.toggle('hidden', !preset.value);
    const p = PRESETS[+preset.value];
    if (preset.value && preset.value !== 'custom' && p) {
      target.value = String(p.profitTarget);
      daily.value = String(p.maxDailyLoss);
      total.value = String(p.maxTotalLoss);
      days.value = String(p.minTradingDays);
      trailing.checked = p.trailingDrawdown;
      stop.checked = p.stopOnBreach;
      name.value = `${p.name} ${new Date().toISOString().slice(0, 10)}`;
    }
  };
  const go = h('button', { class: 'primary' }, 'Create & start replay');
  const close = modal('New backtesting session', h('div', { class: 'stack' },
    field('Session name', name),
    field('Symbols (all stay time-synchronised)', symList),
    h('div', { class: 'row2' }, field('Start (UTC) — history before this is visible', start), field('End (optional, UTC)', end)),
    h('div', { class: 'row2' }, field('Starting balance ($)', bal), field('Default risk per trade (%)', risk)),
    h('div', { class: 'row2' }, field('Commission / lot / side ($)', comm), field('Spread (pips, editable per symbol later)', spread)),
    field('Chart timezone', tz),
    field('Prop firm challenge mode', preset, 'Simulate a funded-account evaluation: profit target, daily & max loss (on equity), minimum trading days.'),
    ruleBox,
    go,
  ), { wide: true });
  go.onclick = () => {
    const syms = boxes.filter((b) => b.cb.checked).map((b) => b.d);
    if (!syms.length) return toast('Pick at least one symbol', 'err');
    const s0 = parseDateInput(start.value);
    if (!isFinite(s0)) return toast('Invalid start date', 'err');
    const rules: ChallengeRules | null = preset.value
      ? {
          name: preset.value === 'custom' ? 'Custom challenge' : PRESETS[+preset.value].name,
          profitTarget: +target.value, maxDailyLoss: +daily.value, maxTotalLoss: +total.value, minTradingDays: +days.value,
          trailingDrawdown: trailing.checked, stopOnBreach: stop.checked,
        }
      : null;
    const s = newSession({
      rules,
      id: uid(), name: name.value || 'Session', description: '', symbols: syms.map((d) => d.id), start: s0,
      end: end.value ? parseDateInput(end.value) : null, balance: +bal.value, commissionPerLot: +comm.value,
      spreadPips: { '*': +spread.value }, slFirst: true, timezone: tz.value, riskPct: +risk.value, createdAt: Date.now(),
      specs: Object.fromEntries(syms.map((d) => [d.id, d.spec])),
    });
    try {
      const p = JSON.parse(localStorage.getItem('overflowtrade.prefs') || '{}');
      localStorage.setItem('overflowtrade.prefs', JSON.stringify({ ...p, sizeMode: 'risk%', sizeVal: +risk.value }));
    } catch {
      /* ignore */
    }
    close();
    done(s);
  };
}

// ---- data manager ------------------------------------------------------------

function renderData(main: HTMLElement, datasets: DatasetMeta[], refresh: () => void) {
  main.append(h('div', { class: 'section-head' }, h('h2', {}, 'Market data'),
    h('div', { class: 'row-btns' },
      h('button', { class: 'primary', onclick: () => importCsvModal(refresh) }, '⭱ Import CSV'),
      h('button', { class: 'ghost', onclick: () => binanceModal(refresh) }, '⭳ Binance (crypto)'),
      h('button', { class: 'ghost', onclick: () => syntheticModal(refresh) }, '✦ Generate synthetic'),
    )));
  const t = h('table', { class: 'tbl data-tbl' }, h('thead', { html: '<tr><th>Symbol</th><th>Source</th><th>Base TF</th><th>From (UTC)</th><th>To (UTC)</th><th>Bars</th><th>Pip size</th><th>Contract/lot</th><th>Digits</th><th></th></tr>' }));
  const tb = h('tbody');
  for (const d of datasets) {
    const pip = h('input', { type: 'number', step: 'any', value: d.spec.pipSize, class: 'sm' });
    const cs = h('input', { type: 'number', step: 'any', value: d.spec.contractSize, class: 'sm' });
    const dg = h('input', { type: 'number', step: 1, value: d.spec.digits, class: 'sm' });
    const upd = async () => {
      d.spec = { ...d.spec, pipSize: +pip.value, contractSize: +cs.value, digits: +dg.value };
      await updateDatasetMeta(d);
      toast(`${d.symbol} spec saved (applies to new sessions)`, 'ok');
    };
    pip.onchange = cs.onchange = dg.onchange = upd;
    tb.append(h('tr', {},
      h('td', {}, h('b', {}, d.symbol)), h('td', {}, d.source), h('td', {}, tfSeconds(d.resolution).label),
      h('td', {}, fmtDate(d.from)), h('td', {}, fmtDate(d.to)), h('td', {}, d.count.toLocaleString('en-US')),
      h('td', {}, pip), h('td', {}, cs), h('td', {}, dg),
      h('td', { class: 'acts' },
        h('button', { class: 'mini', title: 'Upload to your cloud so other devices can use it', onclick: async (e: Event) => {
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
            b.textContent = '☁';
          }
        } }, '☁'),
        h('button', { class: 'mini', title: 'Download as CSV (UTC)', onclick: () => exportDataset(d) }, 'CSV'), h('button', { class: 'mini danger', onclick: async () => {
        if (!confirm(`Delete ${d.symbol} data? Sessions using it will not open.`)) return;
        await deleteDataset(d.id);
        refresh();
      } }, 'Delete')),
    ));
  }
  if (!datasets.length) tb.append(h('tr', {}, h('td', { colspan: 10, class: 'empty' }, 'No data yet.')));
  t.append(tb);
  main.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, t)));
  if (cloudState().user) main.append(cloudDataCard(datasets, refresh));
  main.append(h('section', { class: 'card help' },
    h('h3', {}, 'Where to get free historical data'),
    h('ul', {},
      h('li', { html: '<b>Forex 1-minute (free):</b> histdata.com → “ASCII / 1 Minute Bar Quotes”. Their timestamps are EST without DST → use source offset <code>-5</code>.' }),
      h('li', { html: '<b>Dukascopy:</b> dukascopy.com Historical Data Feed (or the <code>dukascopy-node</code> CLI) → export 1-minute CSV in UTC.' }),
      h('li', { html: '<b>MetaTrader 4/5:</b> History Center / Symbols → Bars → Export. Timestamps are broker server time (often UTC+2/+3).' }),
      h('li', { html: '<b>Crypto:</b> use the Binance button — downloads 1-minute candles straight from the public API.' }),
      h('li', { html: 'Importing the same symbol again <b>merges</b> the data, so you can add a year at a time. Any base resolution works (1m recommended; 1s/5s/tick-bars work too).' }),
    )));
}

function importCsvModal(refresh: () => void) {
  const file = h('input', { type: 'file', accept: '.csv,.txt,.tsv', multiple: true });
  const sym = h('input', { placeholder: 'e.g. EURUSD (defaults to file name)' });
  const off = h('input', { type: 'number', value: 0, step: 0.5 });
  const merge = h('input', { type: 'checkbox', checked: true });
  const status = h('div', { class: 'muted small' });
  const go = h('button', { class: 'primary' }, 'Import');
  const close = modal('Import OHLC CSV', h('div', { class: 'stack' },
    field('CSV file(s)', file, 'MT4/MT5, HistData, Dukascopy, Binance or any time,open,high,low,close[,volume] layout — auto-detected.'),
    h('div', { class: 'row2' }, field('Symbol', sym), field('Timestamps are in UTC offset (hours)', off, 'HistData: -5 · MT4 servers: often 2 or 3')),
    h('label', { class: 'check' }, merge, ' Merge with existing data for this symbol'),
    status, go,
  ));
  go.onclick = async () => {
    const files = [...(file.files ?? [])];
    if (!files.length) return toast('Choose a file', 'err');
    go.disabled = true;
    try {
      for (const f of files) {
        status.textContent = `Parsing ${f.name}…`;
        const bars = parseCsv(await f.text(), +off.value);
        const symbol = (sym.value || f.name.replace(/\.[^.]+$/, '').replace(/^DAT_ASCII_|_M1.*$/gi, '').split(/[_\s-]/)[0]).toUpperCase();
        const meta = await storeBars(symbol, bars, 'csv', merge.checked);
        status.textContent = `${meta.symbol}: ${meta.count.toLocaleString('en-US')} bars`;
      }
      toast('Import complete', 'ok');
      close();
      refresh();
    } catch (e) {
      toast(String((e as Error).message ?? e), 'err');
      status.textContent = String(e);
      go.disabled = false;
    }
  };
}

function binanceModal(refresh: () => void) {
  const sym = h('input', { value: 'BTCUSDT' });
  const market = h('select', {}, h('option', { value: 'spot' }, 'Spot'), h('option', { value: 'futures' }, 'USDⓈ-M Futures'));
  const now = Math.floor(Date.now() / 1000);
  const from = h('input', { type: 'date', value: new Date((now - 90 * 86400) * 1000).toISOString().slice(0, 10) });
  const to = h('input', { type: 'date', value: new Date(now * 1000).toISOString().slice(0, 10) });
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const status = h('div', { class: 'muted small' }, '~43,000 bars per month; each request fetches 1,000.');
  const go = h('button', { class: 'primary' }, 'Download');
  const ctrl = new AbortController();
  const close = modal('Download from Binance', h('div', { class: 'stack' },
    h('div', { class: 'row2' }, field('Symbol', sym), field('Market', market)),
    h('div', { class: 'row2' }, field('From (UTC)', from), field('To (UTC)', to)),
    bar, status, go,
  ), { onClose: () => ctrl.abort() });
  go.onclick = async () => {
    go.disabled = true;
    try {
      const f = Date.parse(from.value) / 1000, t = Date.parse(to.value) / 1000 + 86400;
      const bars = await downloadBinance(sym.value.trim(), f, t, (p, n) => {
        (bar.firstChild as HTMLElement).style.width = `${p * 100}%`;
        status.textContent = `${n.toLocaleString('en-US')} bars…`;
      }, ctrl.signal, market.value as 'spot' | 'futures');
      const meta = await storeBars(sym.value.trim() + (market.value === 'futures' ? '.P' : ''), bars, 'binance', true);
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

function syntheticModal(refresh: () => void) {
  const sym = h('input', { value: 'SYNTH' });
  const price = h('input', { type: 'number', value: 1.1, step: 'any' });
  const days = h('input', { type: 'number', value: 180, min: 1, max: 1500 });
  const vol = h('input', { type: 'number', value: 10, step: 1, min: 1 });
  const seed = h('input', { type: 'number', value: Math.floor(Math.random() * 1e6) });
  const start = h('input', { type: 'date', value: '2024-01-01' });
  const go = h('button', { class: 'primary' }, 'Generate');
  const close = modal('Generate synthetic 1-minute data', h('div', { class: 'stack' },
    h('div', { class: 'row2' }, field('Symbol', sym), field('Start price', price)),
    h('div', { class: 'row2' }, field('Days', days), field('Annual volatility (%)', vol)),
    h('div', { class: 'row2' }, field('Start date', start), field('Random seed', seed)),
    go,
  ));
  go.onclick = async () => {
    go.disabled = true;
    const bars = generateSynthetic({ start: Date.parse(start.value) / 1000, days: +days.value, price: +price.value, annualVol: +vol.value / 100, seed: +seed.value });
    await storeBars(sym.value, bars, 'synthetic');
    toast('Generated', 'ok');
    close();
    refresh();
  };
}

// ---- backup / restore --------------------------------------------------------

async function exportBackup(sessions: Session[]) {
  const shots: Record<string, string> = {};
  for (const s of sessions) for (const t of s.state.broker.trades) if (t.shot) {
    const u = await idb.get<string>('shots', t.shot);
    if (u) shots[t.shot] = u;
  }
  const payload = { app: 'overflowtrade', version: 1, exportedAt: new Date().toISOString(), sessions, shots };
  download(`overflowtrade-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload), 'application/json');
  toast(`Backed up ${sessions.length} sessions`, 'ok');
}

function importBackup(done: () => void) {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as { app?: string; sessions?: Session[]; shots?: Record<string, string> };
      if (!['overflowtrade', 'replaylab'].includes(data.app ?? '') || !Array.isArray(data.sessions)) throw new Error('Not an Overflow Trade backup file');
      for (const [k, v] of Object.entries(data.shots ?? {})) await idb.put('shots', k, v);
      for (const s of data.sessions) await saveSession(s);
      const missing = [...new Set(data.sessions.flatMap((s) => s.symbols))];
      const have = new Set((await listDatasets()).map((d) => d.id));
      const need = missing.filter((m) => !have.has(m));
      toast(`Restored ${data.sessions.length} sessions${need.length ? ` — import data for ${need.join(', ')} to open them` : ''}`, need.length ? 'info' : 'ok');
      done();
    } catch (e) {
      toast(String((e as Error).message ?? e), 'err');
    }
  };
  input.click();
}

async function exportDataset(d: DatasetMeta) {
  const b = await loadBars(d.id);
  if (!b) return;
  const lines = ['time,open,high,low,close,volume'];
  for (let i = 0; i < b.n; i++) lines.push(`${new Date(b.t[i] * 1000).toISOString().slice(0, 19).replace('T', ' ')},${b.o[i]},${b.h[i]},${b.l[i]},${b.c[i]},${b.v[i]}`);
  download(`${d.symbol}_${tfSeconds(d.resolution).label}.csv`, lines.join('\n'));
}

function cloudDataCard(local: DatasetMeta[], refresh: () => void) {
  const body = h('div', { class: 'muted small' }, 'Loading…');
  const card = h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('span', {}, '☁ Market data in your cloud')), body);
  void listCloudDatasets().then((files) => {
    body.innerHTML = '';
    if (!files.length) {
      body.textContent = 'Nothing uploaded yet — press ☁ next to a symbol above.';
      return;
    }
    const have = new Set(local.map((d) => d.id));
    const t = h('table', { class: 'tbl' }, h('thead', { html: '<tr><th>Symbol</th><th>Size</th><th>Uploaded</th><th>On this device</th><th></th></tr>' }));
    const tb = h('tbody');
    for (const f of files) {
      tb.append(h('tr', {},
        h('td', {}, h('b', {}, f.id)), h('td', {}, `${(f.size / 1e6).toFixed(1)} MB`), h('td', {}, f.updated.slice(0, 16).replace('T', ' ')),
        h('td', {}, have.has(f.id) ? '✓' : '—'),
        h('td', { class: 'acts' },
          h('button', { class: 'mini', onclick: async (e: Event) => {
            (e.target as HTMLButtonElement).disabled = true;
            try {
              const m = await downloadDataset(f.id);
              toast(`${m.symbol}: ${m.count.toLocaleString('en-US')} bars downloaded`, 'ok');
              refresh();
            } catch (err) {
              toast((err as Error).message, 'err');
            }
          } }, have.has(f.id) ? 'Re-download' : 'Download'),
          h('button', { class: 'mini danger', onclick: async () => {
            if (!confirm(`Delete ${f.id} from the cloud? Local copies are kept.`)) return;
            await deleteCloudDataset(f.id);
            refresh();
          } }, 'Delete'),
        )));
    }
    t.append(tb);
    body.append(h('div', { class: 'table-wrap' }, t));
  }).catch((e) => (body.textContent = 'Could not list cloud data: ' + (e as Error).message));
  return card;
}
