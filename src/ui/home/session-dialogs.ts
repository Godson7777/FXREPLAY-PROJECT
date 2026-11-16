import { fmtDate } from './shared';
import type { DatasetMeta } from '../../core/types';
import { tfSeconds } from '../../core/timeframe';
import { ZONES } from '../../core/tz';
import { storeBars, canRefresh, refreshDataset } from '../../data/ingest';
import { saveSession } from '../../data/sessions';
import { newSession, dataWindow, checkRange, type Session } from '../../engine/replay';
import { hlCoins, hlCandles, hlSpec, hlSymbol, coinLabel, HL_TAKER_FEE, HL_MAX_CANDLES, type HlCoin } from '../../data/hyperliquid';
import { barsFromRows } from '../../core/types';
import { parseTradeCsv, importedSession, type TradeImport } from '../../data/tradeimport';
import { PRESETS, type ChallengeRules } from '../../engine/rules';
import { h, money, pct, cls, toast, modal, field, dateInputValue, parseDateInput, uid, numField } from '../dom';

// ---- new session -------------------------------------------------------------

export function newSessionModal(datasets: DatasetMeta[], done: (s: Session) => void) {
  const name = h('input', { value: `Backtest ${new Date().toISOString().slice(0, 10)}` });
  const boxes = datasets.map((d, i) => ({ d, cb: h('input', { type: 'checkbox', checked: i === 0 }) as HTMLInputElement }));
  const symList = h(
    'div',
    { class: 'sym-list' },
    ...boxes.map(({ d, cb }) =>
      h(
        'label',
        { class: 'check' },
        cb,
        ` ${d.symbol} `,
        h('small', { class: 'muted' }, `${fmtDate(d.from).slice(0, 10)} → ${fmtDate(d.to).slice(0, 10)} · ${tfSeconds(d.resolution).label}`),
      ),
    ),
  );
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
        const { meta } = await refreshDataset(d, {
          onProgress: (_p, n, msg) => (getNew.textContent = msg ?? `Downloading ${d.symbol}: ${n.toLocaleString('en-US')} bars…`),
        });
        const box = boxes.find((b) => b.d.id === d.id)!;
        box.d = meta;
        box.cb.parentElement!.querySelector('small')!.textContent =
          `${fmtDate(meta.from).slice(0, 10)} → ${fmtDate(meta.to).slice(0, 10)} · ${tfSeconds(meta.resolution).label}`;
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
  const lev = h(
    'select',
    {},
    h('option', { value: '' }, 'Off — no margin limit'),
    ...[1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 500].map((x) => h('option', { value: x }, `${x}×`)),
  );
  const bal = h('input', { type: 'number', value: 10000, min: 1, step: 100 });
  const risk = h('input', { type: 'number', value: 1, min: 0.01, step: 0.25 });
  const comm = h('input', { type: 'number', value: 3.5, min: 0, step: 0.1 });
  const spread = h('input', { type: 'number', value: 0.8, min: 0, step: 0.1 });
  const tz = h('select', {}, ...ZONES.map((z) => h('option', { value: z, selected: z === 'Asia/Jakarta' }, z)));
  const preset = h(
    'select',
    {},
    h('option', { value: '' }, 'None — free backtesting'),
    ...PRESETS.map((p, i) => h('option', { value: i }, p.name)),
    h('option', { value: 'custom' }, 'Custom rules…'),
  );
  const target = h('input', { type: 'number', value: 10, step: 0.5, min: 0 });
  const daily = h('input', { type: 'number', value: 5, step: 0.5, min: 0 });
  const total = h('input', { type: 'number', value: 10, step: 0.5, min: 0 });
  const days = h('input', { type: 'number', value: 4, step: 1, min: 0 });
  const trailing = h('input', { type: 'checkbox' });
  const stop = h('input', { type: 'checkbox', checked: true });
  const ruleBox = h(
    'div',
    { class: 'stack hidden' },
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
  const close = modal(
    'New backtesting session',
    h(
      'div',
      { class: 'stack' },
      field('Session name', name),
      field('Symbols (all stay time-synchronised)', symList),
      h('div', { class: 'row2' }, field('Start (UTC) — history before this is visible', start), field('End (optional, UTC)', end)),
      h('small', { class: 'muted' }, 'Start and end are typed in UTC. Inside the replay, the chart and the trade log use the chart timezone chosen below.'),
      h('div', { class: 'row-btns' }, winNote, getNew),
      h('div', { class: 'row2' }, field('Starting balance ($)', bal), field('Default risk per trade (%)', risk)),
      h('div', { class: 'row2' }, field('Commission / lot / side ($)', comm), field('Spread (pips, editable per symbol later)', spread)),
      h(
        'div',
        { class: 'row2' },
        field('Chart timezone', tz),
        field('Leverage', lev, 'Isolated margin per position: a position is liquidated (losing its margin) if price moves ~1/leverage against it.'),
      ),
      field('Prop firm challenge mode', preset, 'Simulate a funded-account evaluation: profit target, daily & max loss (on equity), minimum trading days.'),
      ruleBox,
      go,
    ),
    { wide: true },
  );
  go.onclick = () => {
    const syms = picked();
    if (!syms.length) return toast('Pick at least one symbol', 'err');
    const s0 = parseDateInput(start.value);
    const e0 = end.value ? parseDateInput(end.value) : null;
    const bad = checkRange(dataWindow(syms), s0, e0, (t) => fmtDate(t).slice(0, 16));
    if (bad) return toast(bad, 'err');
    // an account of $0, a negative spread or a 0% loss limit would make every later number meaningless
    let balance: number,
      riskPct: number,
      commission: number,
      spreadPips: number,
      rules: ChallengeRules | null = null;
    try {
      balance = numField(bal, 'Starting balance', 1, 1e9);
      riskPct = numField(risk, 'Risk per trade (%)', 0.01, 100);
      commission = numField(comm, 'Commission', 0, 1000);
      spreadPips = numField(spread, 'Spread (pips)', 0, 1000);
      if (preset.value)
        rules = {
          name: preset.value === 'custom' ? 'Custom challenge' : PRESETS[+preset.value].name,
          profitTarget: numField(target, 'Profit target (%)', 0.1, 1000),
          maxDailyLoss: numField(daily, 'Max daily loss (%) — 0 for none', 0, 100),
          maxTotalLoss: numField(total, 'Max total loss (%)', 0.1, 100),
          minTradingDays: numField(days, 'Min trading days', 0, 365, true),
          trailingDrawdown: trailing.checked,
          stopOnBreach: stop.checked,
        };
    } catch (e) {
      return toast((e as Error).message, 'err');
    }
    const s = newSession({
      rules,
      id: uid(),
      name: name.value.trim().slice(0, 80) || 'Session',
      description: '',
      symbols: syms.map((d) => d.id),
      start: s0,
      end: e0,
      balance,
      commissionPerLot: commission,
      ...(lev.value ? { leverage: +lev.value } : {}),
      spreadPips: { '*': spreadPips },
      slFirst: true,
      timezone: tz.value,
      riskPct,
      createdAt: Date.now(),
      specs: Object.fromEntries(syms.map((d) => [d.id, d.spec])),
    });
    try {
      const p = JSON.parse(localStorage.getItem('overflowtrade.prefs') || '{}');
      localStorage.setItem('overflowtrade.prefs', JSON.stringify({ ...p, sizeMode: 'risk%', sizeVal: riskPct }));
    } catch {
      /* ignore */
    }
    close();
    done(s);
  };
}

// ---- import a trade history ----------------------------------------------------

export function importTradesModal(nav: (h: string) => void) {
  const file = h('input', { type: 'file', accept: '.csv,.txt,.tsv' }) as HTMLInputElement;
  const name = h('input', { placeholder: 'Defaults to the file name' }) as HTMLInputElement;
  const bal = h('input', { type: 'number', min: 1, step: 100, value: 10000 }) as HTMLInputElement;
  const off = h('input', { type: 'number', step: 0.5, value: 0 }) as HTMLInputElement;
  const tz = h('select', {}, ...ZONES.map((z) => h('option', { value: z, selected: z === 'Asia/Jakarta' }, z))) as HTMLSelectElement;
  const preview = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Pick a CSV to see a preview.'));
  const go = h('button', { class: 'primary', disabled: true }, 'Import & analyse') as HTMLButtonElement;
  let text = '',
    parsed: TradeImport | null = null,
    balTouched = false;
  bal.oninput = () => (balTouched = true);
  const read = () => {
    if (!text) return;
    try {
      parsed = parseTradeCsv(text, { utcOffsetHours: +off.value || 0 });
    } catch (e) {
      parsed = null;
      go.disabled = true;
      preview.replaceChildren(h('div', { class: 'callout bad' }, String((e as Error).message ?? e)));
      return;
    }
    const p = parsed;
    if (p.initialBalance && !balTouched) bal.value = String(p.initialBalance);
    const n = p.trades.length,
      wins = p.trades.filter((t) => t.pnl > 0).length;
    const net = p.trades.reduce((a, t) => a + t.pnl, 0);
    const kv = (k: string, v: string, c = '') => h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: c }, v));
    preview.replaceChildren(
      h(
        'div',
        { class: 'callout' },
        h('b', {}, p.format === 'fxreplay' ? 'FX Replay export detected' : 'Trade list detected'),
        ` — ${n} closed trade${n === 1 ? '' : 's'} read from ${p.rows} row${p.rows === 1 ? '' : 's'}.`,
      ),
      h(
        'div',
        { class: 'kv-grid' },
        kv('Symbols', p.symbols.join(', ')),
        kv('Period', `${fmtDate(p.from).slice(0, 10)} → ${fmtDate(p.to).slice(0, 10)}`),
        kv('Win rate', pct(wins / n)),
        kv('Net P&L', money(net, true), cls(net)),
        kv('With stop loss', `${p.trades.filter((t) => t.risk != null).length} of ${n}`),
      ),
      p.warnings.length
        ? h(
            'details',
            { class: 'small' },
            h('summary', {}, `${p.warnings.length} row${p.warnings.length === 1 ? '' : 's'} skipped`),
            h('ul', {}, ...p.warnings.slice(0, 50).map((w) => h('li', {}, w))),
          )
        : '',
    );
    go.disabled = false;
  };
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    text = await f.text();
    if (!name.value) name.value = f.name.replace(/\.[^.]+$/, '');
    read();
  };
  off.oninput = read;
  const close = modal(
    'Import trades',
    h(
      'div',
      { class: 'stack' },
      h(
        'p',
        { class: 'muted small' },
        'Bring in closed trades from FX Replay (Analytics → export CSV) or any CSV with open/close time, symbol, side, entry and exit price, size and profit. You get the full report, Monte Carlo and the Overflow Score. Imported trades show an “Imported” badge on the leaderboard.',
      ),
      field('Trade history CSV', file),
      preview,
      h('div', { class: 'row2' }, field('Session name', name), field('Starting balance ($)', bal, 'Read from the file when it has it')),
      h(
        'div',
        { class: 'row2' },
        field('Timestamps are in UTC offset (hours)', off, 'FX Replay exports your chart time — e.g. 7 for Jakarta, 0 for UTC'),
        field('Show times in', tz),
      ),
      go,
    ),
    { wide: true },
  );
  go.onclick = async () => {
    if (!parsed) return;
    const b = +bal.value;
    if (!(b > 0) || !isFinite(b) || b > 1e12) return toast('Enter the starting balance (a number above 0)', 'err');
    go.disabled = true;
    const s = importedSession(parsed, {
      id: uid(),
      name: name.value.trim().slice(0, 80) || 'Imported trades',
      balance: b,
      file: file.files?.[0]?.name ?? 'trades.csv',
      timezone: tz.value,
    });
    await saveSession(s);
    toast(`${parsed.trades.length} trades imported — crunching the numbers…`, 'ok');
    close();
    nav(`#/analytics/${s.id}`);
  };
}

// ---- live (Hyperliquid) session -----------------------------------------------

export function coinPicker(onPick: (c: HlCoin | null) => void) {
  const search = h('input', { placeholder: 'Search market (BTC, ETH, GOLD, TSLA…)', autocomplete: 'off' });
  const sel = h('select', { size: 6, class: 'coin-list' }) as HTMLSelectElement;
  const status = h('small', { class: 'muted' }, 'Loading Hyperliquid markets…');
  let coins: HlCoin[] = [];
  const fill = () => {
    const q = search.value.trim().toUpperCase();
    const list = coins.filter((c) => c.name.toUpperCase().includes(q)).slice(0, 300);
    const cur = sel.value;
    sel.replaceChildren(...list.map((c) => h('option', { value: c.name }, `${coinLabel(c.name)}  ·  up to ${c.maxLeverage}×`)));
    sel.value = list.some((c) => c.name === cur) ? cur : (list[0]?.name ?? '');
    onPick(coins.find((c) => c.name === sel.value) ?? null);
  };
  search.oninput = fill;
  sel.onchange = () => onPick(coins.find((c) => c.name === sel.value) ?? null);
  const load = () =>
    hlCoins()
      .then((c) => {
        coins = c;
        const own = c.filter((x) => !x.dex).length;
        status.textContent = `${c.length} perpetual markets${c.length > own ? ` · ${own} crypto, ${c.length - own} builder markets (gold, stocks, indices…)` : ''}`;
        fill();
        if (coins.some((x) => x.name === 'BTC')) {
          sel.value = 'BTC';
          onPick(coins.find((x) => x.name === 'BTC')!);
        }
      })
      .catch((e) => {
        status.replaceChildren(
          `Could not load markets: ${(e as Error).message}. `,
          h(
            'button',
            {
              class: 'ghost sm',
              type: 'button',
              onclick: () => {
                status.textContent = 'Retrying…';
                load();
              },
            },
            'Retry',
          ),
        );
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

export function liveSessionModal(done: (s: Session) => void) {
  let coin: HlCoin | null = null;
  const name = h('input', { value: `Live ${new Date().toISOString().slice(0, 10)}` });
  const lev = h('input', { type: 'number', value: 10, min: 1, step: 1 });
  const levNote = h('small', { class: 'muted' });
  const dexNote = h('small', { class: 'muted' });
  const picker = coinPicker((c) => {
    coin = c;
    if (c) {
      lev.max = String(c.maxLeverage);
      if (+lev.value > c.maxLeverage) lev.value = String(c.maxLeverage);
      levNote.textContent = levText(c, +lev.value);
      dexNote.textContent = c.dex
        ? `${coinLabel(c.name)} is a builder-deployed market on the "${c.dex}" dex: it follows its own trading hours (it can be quiet or closed at weekends) and its fees can differ from the 0.045% default.`
        : '';
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
  const close = modal(
    'Live market — Hyperliquid',
    h(
      'div',
      { class: 'stack' },
      h(
        'p',
        { class: 'muted small' },
        'Paper-trade the live Hyperliquid perpetuals market in real time: prices stream in tick by tick, nothing can be skipped or replayed, and every trade counts as real-data forward testing. No wallet or key needed — orders are simulated in your browser.',
      ),
      field('Market', picker),
      field('Session name', name),
      h('div', { class: 'row2' }, field('Starting balance ($)', bal), field('Leverage (×)', lev)),
      levNote,
      dexNote,
      h(
        'div',
        { class: 'row2' },
        field('Fee per side (% of notional)', fee, 'Hyperliquid base taker fee is 0.045%. Funding payments are not simulated.'),
        field('Default risk per trade (%)', risk),
      ),
      field('Chart timezone', tz),
      status,
      go,
    ),
    { wide: true },
  );
  go.onclick = async () => {
    if (!coin) return toast('Pick a market first', 'err');
    const c = coin;
    const leverage = Math.max(1, Math.min(c.maxLeverage, Math.round(+lev.value || 1)));
    let balance: number, riskPct: number;
    try {
      balance = numField(bal, 'Starting balance', 1, 1e9);
      riskPct = numField(risk, 'Risk per trade (%)', 0.01, 100);
      numField(fee, 'Fee per side (%)', 0, 5);
    } catch (e) {
      return toast((e as Error).message, 'err');
    }
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
        id: uid(),
        name: name.value.trim().slice(0, 80) || `${c.name} live`,
        description: '',
        symbols: [id],
        start: now,
        end: null,
        balance,
        commissionPerLot: 0,
        spreadPips: { '*': 0 },
        slFirst: true,
        timezone: tz.value,
        riskPct,
        createdAt: Date.now(),
        specs: { [id]: spec },
        leverage,
        maxLeverage: { [id]: c.maxLeverage },
        feePct: Math.max(0, +fee.value || 0),
        live: { venue: 'hyperliquid', coin: c.name },
      });
      s.state.panes = s.state.panes.map((p, i) => ({ ...p, tf: ['1m', '5m', '15m', '1H'][i] }));
      try {
        const p = JSON.parse(localStorage.getItem('overflowtrade.prefs') || '{}');
        // start with a stop about 0.5% from price, so the first order fits the margin
        const slPips = Math.max(1, Math.round((bars.c[bars.n - 1] * 0.005) / spec.pipSize));
        localStorage.setItem('overflowtrade.prefs', JSON.stringify({ ...p, sizeMode: 'risk%', sizeVal: riskPct, slPips }));
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
