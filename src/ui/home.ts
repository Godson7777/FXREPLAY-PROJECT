import type { DatasetMeta } from '../core/types';
import { tfSeconds } from '../core/timeframe';
import { ZONES } from '../core/tz';
import { parseCsv } from '../data/csv';
import { generateSynthetic } from '../data/synthetic';
import { listDatasets, deleteDataset, updateDatasetMeta, getDatasetMeta, loadBars } from '../data/store';
import { storeBars, canRefresh, refreshDataset } from '../data/ingest';
import { PROVIDERS, providerInfo, fetchCandles, datasetId, sourceOf, getTdKey, setTdKey, refreshSource, type ProviderId } from '../data/providers';
import { cloudState, uploadDataset, listCloudDatasets, downloadDataset, deleteCloudDataset } from '../data/cloud';
import { authModal } from './cloudui';
import { listSessions, saveSession, deleteSession } from '../data/sessions';
import { computeStats } from '../analytics/stats';
import { newSession, dataWindow, checkRange, type Session } from '../engine/replay';
import { hlCoins, hlCandles, hlSpec, hlSymbol, pickInterval, HL_TAKER_FEE, HL_MAX_CANDLES, type HlCoin } from '../data/hyperliquid';
import { barsFromRows } from '../core/types';
import { PRESETS, type ChallengeRules } from '../engine/rules';
import { idb } from '../data/store';
import { listStrategies, mergeStrategies } from '../data/strategies';
import { reportsFor } from '../analytics/service';
import { h, money, pct, cls, toast, modal, field, dateInputValue, parseDateInput, download, uid } from './dom';
import { pageHead, pageShell, scoreBadge } from './layout';
import { addToStrategyModal } from './strategies';

export { LOGO } from './logo';
export { uid } from './dom';

const fmtDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

export async function renderHome(root: HTMLElement, nav: (h: string) => void, tab: 'sessions' | 'data') {
  const [sessions, datasets] = await Promise.all([listSessions(), listDatasets()]);
  const { page, main } = pageShell(tab);
  root.replaceChildren(page);
  if (tab === 'data') return renderData(main, datasets, () => renderHome(root, nav, 'data'));

  if (!datasets.length && !sessions.length) {
    const demo = h('button', { class: 'primary lg', onclick: async () => {
      demo.disabled = true;
      demo.textContent = 'Generating…';
      try {
        await loadDemo();
        void renderHome(root, nav, 'sessions');
      } catch (e) {
        demo.disabled = false;
        toast(String((e as Error).message ?? e), 'err');
      }
    } }, 'Load demo data');
    main.append(
      h('section', { class: 'hero' }, h('div', { class: 'wrap' },
        h('span', { class: 'pill' }, h('i', {}), 'New: Overflow Score for every backtest'),
        h('h1', { html: 'Replay any market, <em>bar by bar</em>.' }),
        h('p', {}, 'Backtest manually as if it were live: the future stays hidden, any timeframe you can type (7m, 2H, 3D…), multi-chart sync, a real order engine with SL/TP at 1-minute precision — and a quant-grade report that tells you whether your edge is real.'),
        h('div', { class: 'hero-actions' }, h('button', { class: 'ghost lg', onclick: () => nav('#/data') }, 'Import your data'), h('button', { class: 'ghost lg', title: 'Forward-test on the live Hyperliquid market', onclick: () => liveSessionModal(async (s) => { await saveSession(s); nav(`#/replay/${s.id}`); }) }, '● Live market'), demo),
        h('p', { class: 'muted small' }, 'Demo data is synthetic (realistic-looking, generated in your browser) and never ranked. For real history, import CSVs from HistData, Dukascopy or MT4/MT5, or connect Binance, Bybit, OKX, Hyperliquid or Twelve Data (forex & gold) on the Data tab. Live market paper-trades Hyperliquid perps in real time.'))),
      h('section', { class: 'sec alt' }, h('div', { class: 'wrap' },
        h('div', { class: 'sec-head center' }, h('span', { class: 'eyebrow' }, 'Why Overflow Trade'), h('h2', { html: 'Find out if your edge is <em>real</em>.' })),
        h('div', { class: 'points' },
          h('div', { class: 'point' }, h('span', { class: 'n' }, '01'), h('h5', {}, 'Unlimited timeframes'), h('p', {}, 'Any timeframe from one-minute data — 3m, 45m, 6H, 2D — with exact OHLC aggregation and multi-chart sync.')),
          h('div', { class: 'point' }, h('span', { class: 'n' }, '02'), h('h5', {}, '1-minute execution'), h('p', {}, 'Market, limit and stop orders, SL/TP, trailing and break-even stops, spreads and commissions, filled on 1-minute bars.')),
          h('div', { class: 'point' }, h('span', { class: 'n' }, '03'), h('h5', {}, 'The Overflow Score'), h('p', {}, 'Sharpe, drawdown, monthly consistency, market regimes, significance, costs and Monte Carlo — summed up in one score and a leaderboard.')),
        ))),
    );
    return;
  }

  const start = async (s: Session) => { await saveSession(s); nav(`#/replay/${s.id}`); };
  const newBtn = h('button', { class: 'primary', onclick: () => (datasets.length ? newSessionModal(datasets, start) : nav('#/data')) }, '+ New session');
  const liveBtn = h('button', { class: 'ghost', title: 'Forward-test on the live Hyperliquid market', onclick: () => liveSessionModal(start) }, '● Live market');
  main.append(pageHead({
    eyebrow: 'Sessions', titleHtml: 'Your backtesting <em>sessions</em>.', compact: true,
    lead: 'Each session replays the market from a start date with the future hidden. Every closed trade feeds its analytics and Overflow Score; group sessions into a strategy to compete on the leaderboard.',
    actions: [
      newBtn,
      liveBtn,
      h('button', { class: 'ghost', title: 'Download all sessions, strategies, trades, drawings & journal screenshots as one JSON file', onclick: () => exportBackup(sessions) }, 'Backup'),
      h('button', { class: 'ghost', title: 'Restore sessions and strategies from a backup file', onclick: () => importBackup(() => renderHome(root, nav, 'sessions')) }, 'Restore'),
    ],
  }));
  const body = h('div', { class: 'wrap page-body' });
  main.append(body);
  if (!sessions.length) {
    body.append(h('div', { class: 'card empty-state' }, h('h3', {}, 'No sessions yet'), h('p', {}, 'Create a session: pick symbols, a start date and your account size. Everything after the start date stays hidden until you replay it.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => newBtn.click() }, 'Create a session'))));
    return;
  }
  const grid = h('div', { class: 'cards' });
  const badges = new Map<string, HTMLElement>();
  for (const s of sessions) {
    const st = computeStats(s.state.broker.trades, s.balance);
    const bal = s.state.broker.balance;
    const scoreSlot = h('span', {}, scoreBadge(null, '', 'loading'));
    badges.set(s.id, scoreSlot);
    const status = s.state.challenge
      ? h('span', { class: `badge ${s.state.challenge.status}` }, s.state.challenge.status === 'active' ? `Challenge · ${s.rules?.name ?? 'active'}` : s.state.challenge.status === 'passed' ? 'Challenge passed' : 'Challenge failed')
      : s.state.finished ? h('span', { class: 'badge' }, 'Finished') : null;
    const card = h('article', { class: 'scard' },
      h('div', { class: 'scard-head' }, h('div', {}, h('h3', {}, s.name, s.live ? h('span', { class: 'live-badge live', style: 'margin-left:.5rem;vertical-align:middle' }, '● LIVE') : null), h('div', { class: 'by' }, `${s.symbols.join(' · ')} · ${s.live ? 'live since' : 'started'} ${fmtDate(s.start).slice(0, 10)}${s.leverage ? ` · ${s.leverage}×` : ''}`)), scoreSlot),
      status ? h('div', { class: 'badges' }, status) : null,
      h('div', { class: 'muted small' }, `Replay clock: ${fmtDate(s.state.clock - 1)} UTC`),
      h('div', { class: 'scard-stats' },
        h('div', {}, h('span', {}, 'Balance'), h('b', { title: money(bal) }, `$${Math.round(bal).toLocaleString('en-US')}`)),
        h('div', {}, h('span', {}, 'Net'), h('b', { class: cls(bal - s.balance) }, pct((bal - s.balance) / s.balance, 2, true))),
        h('div', {}, h('span', {}, 'Trades'), h('b', {}, String(st.trades))),
        h('div', {}, h('span', {}, 'Win rate'), h('b', {}, st.trades ? pct(st.winRate) : '—')),
        h('div', {}, h('span', {}, 'PF'), h('b', {}, st.trades ? (isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '∞') : '—')),
      ),
      h('div', { class: 'scard-actions' },
        h('button', { class: 'primary', onclick: () => nav(`#/replay/${s.id}`) }, 'Continue'),
        h('button', { class: 'ghost', onclick: () => nav(`#/analytics/${s.id}`) }, 'Analytics'),
        h('button', { class: 'ghost', title: 'Add this session to a strategy', onclick: () => addToStrategyModal(s, sessions, () => renderHome(root, nav, 'sessions')) }, '+ Strategy'),
      ),
      h('div', { class: 'scard-foot' },
        h('button', { class: 'link', type: 'button', title: 'Duplicate the settings into a fresh session', onclick: async () => {
          const copy = newSession({ ...s, id: uid(), name: s.name + ' (copy)', createdAt: Date.now() });
          await saveSession(copy);
          void renderHome(root, nav, 'sessions');
        } }, 'Duplicate'),
        h('button', { class: 'link danger', type: 'button', onclick: async () => {
          if (!confirm(`Delete session "${s.name}" and its ${st.trades} trades?`)) return;
          await deleteSession(s.id);
          void renderHome(root, nav, 'sessions');
        } }, 'Delete'),
      ),
    );
    grid.append(card);
  }
  body.append(grid);
  // scores load in the background (regime tagging may need the market data)
  void reportsFor(sessions.map((s) => [s]), sessions).then((reps) => {
    reps.forEach((r, i) => {
      const slot = badges.get(sessions[i].id);
      if (!slot?.isConnected) return;
      slot.replaceChildren(r ? scoreBadge(r.score.score, r.score.grade, r.score.tier, r.score.label) : scoreBadge(null, '—', 'insufficient'));
    });
  }).catch((e) => {
    console.error(e);
    for (const slot of badges.values()) if (slot.isConnected) slot.replaceChildren(scoreBadge(null, '—', 'insufficient'));
  });
}

async function loadDemo() {
  // the last 365 days up to yesterday, so recent start dates are inside the data
  const today = Math.floor(Date.now() / 86400000) * 86400;
  const start = today - 366 * 86400;
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

// ---- new session -------------------------------------------------------------

function newSessionModal(datasets: DatasetMeta[], done: (s: Session) => void) {
  const name = h('input', { value: `Backtest ${new Date().toISOString().slice(0, 10)}` });
  const boxes = datasets.map((d, i) => ({ d, cb: h('input', { type: 'checkbox', checked: i === 0 }) as HTMLInputElement }));
  const symList = h('div', { class: 'sym-list' }, ...boxes.map(({ d, cb }) =>
    h('label', { class: 'check' }, cb, ` ${d.symbol} `, h('small', { class: 'muted' }, `${fmtDate(d.from).slice(0, 10)} → ${fmtDate(d.to).slice(0, 10)} · ${tfSeconds(d.resolution).label}`))));
  const d0 = datasets[0];
  const defStart = d0.from + Math.min(30 * 86400, (d0.to - d0.from) / 4);
  const start = h('input', { type: 'datetime-local', value: dateInputValue(defStart) });
  const end = h('input', { type: 'datetime-local' });
  const winNote = h('small', { class: 'muted' });
  const getNew = h('button', { class: 'ghost sm hidden', type: 'button' }, 'Download bars up to now');
  const picked = () => boxes.filter((b) => b.cb.checked).map((b) => b.d);
  getNew.onclick = async () => {
    const stale = picked().filter((d) => canRefresh(d) && d.to < Date.now() / 1000 - 3600);
    getNew.disabled = true;
    try {
      for (const [i, d] of stale.entries()) {
        getNew.textContent = `Downloading ${d.symbol} (${i + 1}/${stale.length})…`;
        const { meta } = await refreshDataset(d, { onProgress: (_p, n, msg) => (getNew.textContent = msg ?? `Downloading ${d.symbol}: ${n.toLocaleString('en-US')} bars…`) });
        const box = boxes.find((b) => b.d.id === d.id)!;
        box.d = meta;
        box.cb.parentElement!.querySelector('small')!.textContent = `${fmtDate(meta.from).slice(0, 10)} → ${fmtDate(meta.to).slice(0, 10)} · ${tfSeconds(meta.resolution).label}`;
      }
      toast('Data is up to date', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
    getNew.disabled = false;
    getNew.textContent = 'Download bars up to now';
    updateWindow();
  };
  const updateWindow = () => {
    const syms = picked();
    getNew.classList.toggle('hidden', !syms.some((d) => canRefresh(d) && d.to < Date.now() / 1000 - 3600));
    if (!syms.length) return void (winNote.textContent = 'Pick at least one symbol.');
    const w = dataWindow(syms);
    if (w.from >= w.to) return void (winNote.textContent = 'These symbols have no overlapping dates.');
    winNote.textContent = `Data available: ${fmtDate(w.from).slice(0, 16)} → ${fmtDate(w.to).slice(0, 16)} UTC`;
    start.min = end.min = dateInputValue(w.from);
    start.max = end.max = dateInputValue(w.to);
    const s0 = parseDateInput(start.value);
    if (!isFinite(s0) || s0 < w.from || s0 >= w.to) start.value = dateInputValue(w.from + Math.min(30 * 86400, (w.to - w.from) / 4));
  };
  for (const b of boxes) b.cb.addEventListener('change', updateWindow);
  updateWindow();
  const lev = h('select', {}, h('option', { value: '' }, 'Off — no margin limit'), ...[1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 500].map((x) => h('option', { value: x }, `${x}×`)));
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
    h('div', { class: 'row-btns' }, winNote, getNew),
    h('div', { class: 'row2' }, field('Starting balance ($)', bal), field('Default risk per trade (%)', risk)),
    h('div', { class: 'row2' }, field('Commission / lot / side ($)', comm), field('Spread (pips, editable per symbol later)', spread)),
    h('div', { class: 'row2' }, field('Chart timezone', tz), field('Leverage', lev, 'Isolated margin per position: a position is liquidated (losing its margin) if price moves ~1/leverage against it.')),
    field('Prop firm challenge mode', preset, 'Simulate a funded-account evaluation: profit target, daily & max loss (on equity), minimum trading days.'),
    ruleBox,
    go,
  ), { wide: true });
  go.onclick = () => {
    const syms = picked();
    if (!syms.length) return toast('Pick at least one symbol', 'err');
    const s0 = parseDateInput(start.value);
    const e0 = end.value ? parseDateInput(end.value) : null;
    const bad = checkRange(dataWindow(syms), s0, e0, (t) => fmtDate(t).slice(0, 16));
    if (bad) return toast(bad, 'err');
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
      end: e0, balance: +bal.value, commissionPerLot: +comm.value, ...(lev.value ? { leverage: +lev.value } : {}),
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

// ---- live (Hyperliquid) session -----------------------------------------------

function coinPicker(onPick: (c: HlCoin | null) => void) {
  const search = h('input', { placeholder: 'Search coin (BTC, ETH, SOL…)', autocomplete: 'off' });
  const sel = h('select', { size: 6, class: 'coin-list' }) as HTMLSelectElement;
  const status = h('small', { class: 'muted' }, 'Loading Hyperliquid markets…');
  let coins: HlCoin[] = [];
  const fill = () => {
    const q = search.value.trim().toUpperCase();
    const list = coins.filter((c) => c.name.toUpperCase().includes(q)).slice(0, 300);
    const cur = sel.value;
    sel.replaceChildren(...list.map((c) => h('option', { value: c.name }, `${c.name}  ·  up to ${c.maxLeverage}×`)));
    sel.value = list.some((c) => c.name === cur) ? cur : list[0]?.name ?? '';
    onPick(coins.find((c) => c.name === sel.value) ?? null);
  };
  search.oninput = fill;
  sel.onchange = () => onPick(coins.find((c) => c.name === sel.value) ?? null);
  const load = () => hlCoins().then((c) => {
    coins = c;
    status.textContent = `${c.length} perpetual markets`;
    fill();
    if (coins.some((x) => x.name === 'BTC')) { sel.value = 'BTC'; onPick(coins.find((x) => x.name === 'BTC')!); }
  }).catch((e) => {
    status.replaceChildren(`Could not load markets: ${(e as Error).message}. `, h('button', { class: 'ghost sm', type: 'button', onclick: () => { status.textContent = 'Retrying…'; load(); } }, 'Retry'));
    onPick(null);
  });
  load();
  return h('div', { class: 'stack coin-picker' }, search, sel, status);
}

/** "Liquidation ≈ x% against you" for isolated margin (maintenance = half the margin at max leverage). */
function levText(c: HlCoin, want: number) {
  const l = Math.min(Math.max(1, Math.round(want) || 1), c.maxLeverage);
  return `${c.name}: 1× to ${c.maxLeverage}×, isolated margin. At ${l}× a ${((1 / l - 1 / (2 * c.maxLeverage)) * 100).toFixed(2)}% move against you liquidates the position (you lose its margin).`;
}

function liveSessionModal(done: (s: Session) => void) {
  let coin: HlCoin | null = null;
  const name = h('input', { value: `Live ${new Date().toISOString().slice(0, 10)}` });
  const lev = h('input', { type: 'number', value: 10, min: 1, step: 1 });
  const levNote = h('small', { class: 'muted' });
  const picker = coinPicker((c) => {
    coin = c;
    if (c) {
      lev.max = String(c.maxLeverage);
      if (+lev.value > c.maxLeverage) lev.value = String(c.maxLeverage);
      levNote.textContent = levText(c, +lev.value);
      if (!name.dataset.touched) name.value = `${c.name} live ${new Date().toISOString().slice(0, 10)}`;
    }
  });
  name.oninput = () => (name.dataset.touched = '1');
  lev.oninput = () => coin && (levNote.textContent = levText(coin, +lev.value));
  const bal = h('input', { type: 'number', value: 10000, min: 1, step: 100 });
  const risk = h('input', { type: 'number', value: 1, min: 0.01, step: 0.25 });
  const fee = h('input', { type: 'number', value: HL_TAKER_FEE, min: 0, step: 0.005 });
  const tz = h('select', {}, ...ZONES.map((z) => h('option', { value: z, selected: z === 'Asia/Jakarta' }, z)));
  const status = h('div', { class: 'muted small' });
  const go = h('button', { class: 'primary' }, 'Start live session');
  const close = modal('Live market — Hyperliquid', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Paper-trade the live Hyperliquid perpetuals market in real time: prices stream in tick by tick, nothing can be skipped or replayed, and every trade counts as real-data forward testing. No wallet or key needed — orders are simulated in your browser.'),
    field('Market', picker),
    field('Session name', name),
    h('div', { class: 'row2' }, field('Starting balance ($)', bal), field('Leverage (×)', lev)),
    levNote,
    h('div', { class: 'row2' }, field('Fee per side (% of notional)', fee, 'Hyperliquid base taker fee is 0.045%. Funding payments are not simulated.'), field('Default risk per trade (%)', risk)),
    field('Chart timezone', tz),
    status, go,
  ), { wide: true });
  go.onclick = async () => {
    if (!coin) return toast('Pick a market first', 'err');
    const c = coin;
    const leverage = Math.max(1, Math.min(c.maxLeverage, Math.round(+lev.value || 1)));
    go.disabled = true;
    status.textContent = `Loading recent ${c.name} candles…`;
    try {
      const now = Math.floor(Date.now() / 1000);
      const rows = await hlCandles(c.name, '1m', now - HL_MAX_CANDLES * 60, now);
      if (!rows.length) throw new Error(`No candles returned for ${c.name}`);
      const bars = barsFromRows(rows);
      const id = hlSymbol(c.name);
      const spec = hlSpec(c.name, c.szDecimals, bars.c[bars.n - 1]);
      await storeBars(id, bars, 'hyperliquid', true, spec, { provider: 'hyperliquid', symbol: c.name });
      const s = newSession({
        id: uid(), name: name.value || `${c.name} live`, description: '', symbols: [id], start: now, end: null,
        balance: +bal.value, commissionPerLot: 0, spreadPips: { '*': 0 }, slFirst: true, timezone: tz.value, riskPct: +risk.value,
        createdAt: Date.now(), specs: { [id]: spec }, leverage, maxLeverage: { [id]: c.maxLeverage }, feePct: Math.max(0, +fee.value || 0),
        live: { venue: 'hyperliquid', coin: c.name },
      });
      s.state.panes = s.state.panes.map((p, i) => ({ ...p, tf: ['1m', '5m', '15m', '1H'][i] }));
      try {
        const p = JSON.parse(localStorage.getItem('overflowtrade.prefs') || '{}');
        localStorage.setItem('overflowtrade.prefs', JSON.stringify({ ...p, sizeMode: 'risk%', sizeVal: +risk.value }));
      } catch {
        /* ignore */
      }
      close();
      done(s);
    } catch (e) {
      status.textContent = String((e as Error).message ?? e);
      toast(status.textContent, 'err');
      go.disabled = false;
    }
  };
}

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
  const close = modal('Download from Hyperliquid', h('div', { class: 'stack' },
    field('Market (perpetuals)', picker),
    field('From (UTC) — up to now', from), note,
    bar, status, go,
  ), { onClose: () => ctrl.abort() });
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
      if (old && old.resolution !== iv.sec) throw new Error(`${id} is already stored as ${tfSeconds(old.resolution).label} bars — delete it first to download ${iv.id} bars.`);
      const meta = await storeBars(id, bars, 'hyperliquid', true, hlSpec(c.name, c.szDecimals, bars.c[bars.n - 1]), { provider: 'hyperliquid', symbol: c.name });
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

function renderData(page: HTMLElement, datasets: DatasetMeta[], refresh: () => void) {
  page.append(pageHead({
    eyebrow: 'Market data', titleHtml: 'Your market <em>data</em>.', compact: true,
    lead: 'Everything is stored in this browser. One-minute data gives exact fills and lets you replay any timeframe. Only real market data (CSV or an exchange/API download) can be ranked on the leaderboard; synthetic data is for practice.',
    actions: [
      h('button', { class: 'primary', onclick: () => importCsvModal(refresh) }, 'Import CSV'),
      h('button', { class: 'primary', onclick: () => exchangeModal(refresh) }, 'Connect exchange / API'),
      h('button', { class: 'ghost', onclick: () => hyperliquidModal(refresh) }, 'Hyperliquid (perps)'),
      datasets.some(canRefresh) ? h('button', { class: 'ghost', title: 'Download the newest bars for every dataset that came from an API', onclick: (e: Event) => void updateAll(e.target as HTMLButtonElement, datasets, refresh) }, 'Update all') : null,
      h('button', { class: 'ghost', onclick: () => syntheticModal(refresh) }, 'Generate synthetic'),
    ],
  }));
  const main = h('div', { class: 'wrap page-body' });
  page.append(main);
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
      h('td', {}, h('b', {}, d.symbol)), h('td', {}, h('span', { class: `badge${d.source === 'synthetic' ? '' : ' accent'}`, title: d.source === 'synthetic' ? 'Practice data — scored but never ranked' : 'Real market data' }, d.source)), h('td', {}, tfSeconds(d.resolution).label),
      h('td', {}, fmtDate(d.from)), h('td', {}, fmtDate(d.to)), h('td', {}, d.count.toLocaleString('en-US')),
      h('td', {}, pip), h('td', {}, cs), h('td', {}, dg),
      h('td', { class: 'acts' },
        canRefresh(d) ? h('button', { class: 'mini', title: `Download bars newer than ${fmtDate(d.to)} from ${providerInfo(refreshSource(d)!.provider).label}`, onclick: (e: Event) => void updateOne(e.target as HTMLButtonElement, d, refresh) }, 'Update') : null,
        h('button', { class: 'mini', title: 'Upload to your cloud so your other devices can use it', onclick: async (e: Event) => {
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
        } }, 'Upload'),
        h('button', { class: 'mini', title: 'Download as CSV (UTC)', onclick: () => exportDataset(d) }, 'CSV'), h('button', { class: 'mini danger', onclick: async () => {
        if (!confirm(`Delete ${d.symbol} data? Sessions using it will not open.`)) return;
        await deleteDataset(d.id);
        refresh();
      } }, 'Delete')),
    ));
  }
  if (!datasets.length) tb.append(h('tr', {}, h('td', { colspan: 10, class: 'empty' }, 'No data yet — import a CSV, connect an exchange / data API, or generate synthetic practice data.')));
  t.append(tb);
  main.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, t)));
  if (cloudState().user) main.append(cloudDataCard(datasets, refresh));
  main.append(importGuide(refresh));
  main.append(h('section', { class: 'card help' },
    h('div', { class: 'card-title' }, h('span', {}, 'Where to get free historical data')),
    h('ul', {},
      h('li', { html: '<b>Forex 1-minute (free):</b> histdata.com → “ASCII / 1 Minute Bar Quotes”. Their timestamps are EST without DST → use source offset <code>-5</code>.' }),
      h('li', { html: '<b>Dukascopy:</b> dukascopy.com Historical Data Feed (or the <code>dukascopy-node</code> CLI) → export 1-minute CSV in UTC.' }),
      h('li', { html: '<b>MetaTrader 4/5:</b> History Center / Symbols → Bars → Export. Timestamps are broker server time (often UTC+2/+3).' }),
      h('li', { html: '<b>Crypto (no key):</b> Connect exchange / API → Binance, Bybit or OKX, or the Hyperliquid button. Downloads 1-minute candles straight from the public APIs.' }),
      h('li', { html: '<b>Forex, gold, indices, stocks:</b> Connect exchange / API → Twelve Data (free key from twelvedata.com), e.g. <code>XAU/USD</code>, <code>EUR/USD</code>, <code>AAPL</code>.' }),
      h('li', { html: 'Datasets from an API have an <b>Update</b> button that downloads everything newer than the last bar, so a replay never runs out of data.' }),
      h('li', { html: 'Importing the same symbol again <b>merges</b> the data, so you can add a year at a time. Any base resolution works (1m recommended; 1s/5s/tick-bars work too).' }),
    )));
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
    const symbol = (sym.value || (file.files?.[0]?.name ?? '').replace(/\.[^.]+$/, '').replace(/^DAT_ASCII_|_M1.*$/gi, '').split(/[_\s-]/)[0]).toUpperCase();
    const m = symbol ? await getDatasetMeta(symbol) : undefined;
    const show = !!m && m.source === 'synthetic' && merge.checked;
    warn.classList.toggle('hidden', !show);
    warn.textContent = show ? `${symbol} already holds synthetic practice data. Merging keeps it marked as synthetic (never ranked). Untick “Merge” to replace it with your real data.` : '';
  };
  sym.oninput = file.onchange = merge.onchange = () => void checkWarn();
  const close = modal('Import OHLC CSV', h('div', { class: 'stack' },
    field('CSV file(s)', file, 'MT4/MT5, HistData, Dukascopy, Binance or any time,open,high,low,close[,volume] layout — auto-detected.'),
    h('div', { class: 'row2' }, field('Symbol', sym), field('Timestamps are in UTC offset (hours)', off, 'HistData: -5 · MT4 servers: often 2 or 3')),
    h('label', { class: 'check' }, merge, ' Merge with existing data for this symbol'),
    warn, status, go,
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
  let ok = 0, bars = 0;
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
  const prov = h('select', {}, ...PROVIDERS.filter((p) => p.id !== 'hyperliquid').map((p) => h('option', { value: p.id }, `${p.label}${p.needsKey ? ' (free key)' : ''}`)));
  const sym = h('input', { value: 'BTCUSDT', autocomplete: 'off' });
  const key = h('input', { type: 'password', value: getTdKey(), placeholder: 'Paste your Twelve Data API key', autocomplete: 'off' });
  const keyRow = field('API key', key, 'Stored only in this browser — never synced, uploaded or put in backups. Free key: twelvedata.com → Sign up → API keys.');
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
  const close = modal('Connect an exchange or data API', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Real candles are downloaded straight from the provider into this browser — no account needed except the free Twelve Data key for forex, gold and stocks. Datasets get an Update button so you can extend them to today later.'),
    field('Provider', prov), note,
    h('div', { class: 'row2' }, field('Symbol', sym), keyRow),
    idNote,
    h('div', { class: 'row2' }, field('From (UTC)', from), field('To (UTC)', to)),
    bar, status, go,
  ), { onClose: () => ctrl.abort() });
  go.onclick = async () => {
    const id = p();
    const f = Date.parse(from.value) / 1000, t = Math.min(now, Date.parse(to.value) / 1000 + 86400);
    if (!isFinite(f) || !isFinite(t) || t <= f) return toast('Pick a valid date range', 'err');
    if (providerInfo(id).needsKey) {
      if (!key.value.trim()) return toast('Paste your Twelve Data API key first', 'err');
      setTdKey(key.value);
    }
    const dsId = datasetId(id, sym.value);
    const old = await getDatasetMeta(dsId);
    let merge = true;
    if (old?.source === 'synthetic') {
      if (!confirm(`${dsId} currently holds synthetic demo data. Replace it with real ${providerInfo(id).label} data? Sessions on ${dsId} keep their trades.`)) return;
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
  const strategies = await listStrategies();
  const payload = { app: 'overflowtrade', version: 2, exportedAt: new Date().toISOString(), sessions, strategies, shots };
  download(`overflowtrade-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload), 'application/json');
  toast(`Backed up ${sessions.length} session${sessions.length === 1 ? '' : 's'} and ${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'}`, 'ok');
}

function importBackup(done: () => void) {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as { app?: string; sessions?: Session[]; strategies?: unknown[]; shots?: Record<string, string> };
      if (!['overflowtrade', 'replaylab'].includes(data.app ?? '') || !Array.isArray(data.sessions)) throw new Error('Not an Overflow Trade backup file');
      for (const [k, v] of Object.entries(data.shots ?? {})) await idb.put('shots', k, v);
      for (const s of data.sessions) await saveSession(s);
      const nStrat = Array.isArray(data.strategies) ? await mergeStrategies(data.strategies) : 0;
      const missing = [...new Set(data.sessions.flatMap((s) => s.symbols))];
      const have = new Set((await listDatasets()).map((d) => d.id));
      const need = missing.filter((m) => !have.has(m));
      toast(`Restored ${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'}${nStrat ? ` and ${nStrat} strateg${nStrat === 1 ? 'y' : 'ies'}` : ''}${need.length ? ` — import data for ${need.join(', ')} to open them` : ''}`, need.length ? 'info' : 'ok');
      done();
    } catch (e) {
      toast(String((e as Error).message ?? e), 'err');
    }
  };
  input.click();
}

/** Step-by-step: how to bring price data in, with a sample file in the accepted layout. */
function importGuide(refresh: () => void) {
  const sample = () => {
    const today = Math.floor(Date.now() / 86400000) * 86400;
    const b = generateSynthetic({ start: today - 2 * 86400, days: 1, price: 1.1, annualVol: 0.08, seed: 7 });
    const lines = ['time,open,high,low,close,volume'];
    for (let i = 0; i < b.n; i++) lines.push(`${new Date(b.t[i] * 1000).toISOString().slice(0, 19).replace('T', ' ')},${b.o[i].toFixed(5)},${b.h[i].toFixed(5)},${b.l[i].toFixed(5)},${b.c[i].toFixed(5)},${Math.round(b.v[i])}`);
    download('SAMPLE_1m.csv', lines.join('\n'));
  };
  const step = (n: string, title: string, body: HTMLElement | string) => h('div', { class: 'point' }, h('span', { class: 'n' }, n), h('h5', {}, title), typeof body === 'string' ? h('p', {}, body) : body);
  return h('section', { class: 'card stack import-guide' },
    h('div', { class: 'card-title' }, h('span', {}, 'How to import price data')),
    h('div', { class: 'points' },
      step('01', 'Get candles', h('p', { html: 'Download 1-minute bars as CSV — HistData, Dukascopy (<code>npx dukascopy-node</code>), or MT4/MT5 History Center → Export. For crypto, forex, gold and stocks you can skip files: use <b>Connect exchange / API</b> above.' })),
      step('02', 'Import CSV', h('p', { html: 'Click <b>Import CSV</b>, pick one or more files, type the symbol (e.g. <code>XAUUSD</code>) and the timezone offset of the timestamps: HistData <code>-5</code>, MT4/MT5 usually <code>2</code> or <code>3</code>, Dukascopy/Binance <code>0</code>. Importing the same symbol again merges the files.' })),
      step('03', 'Check & replay', h('p', { html: 'The table shows each symbol with its first and last bar. Create a session with a start date inside that range — the New session form shows the exact window.' })),
    ),
    h('p', { class: 'muted small', html: 'Accepted columns (auto-detected, header optional): <code>time,open,high,low,close[,volume]</code> · <code>2024.01.02,00:00,o,h,l,c,v</code> (MT4/MT5) · <code>20240102 170000;o;h;l;c;v</code> (HistData) · <code>02.01.2024 00:00:00.000,o,h,l,c,v</code> (Dukascopy) · Unix seconds/ms timestamps (Binance).' }),
    h('div', { class: 'row-btns' },
      h('button', { class: 'ghost', onclick: sample }, 'Download sample CSV'),
      h('button', { class: 'primary', onclick: () => importCsvModal(refresh) }, 'Import CSV')),
  );
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
