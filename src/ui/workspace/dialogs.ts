import { parseTf } from '../../core/timeframe';
import { ZONES } from '../../core/tz';
import { INDICATORS, indicatorDef } from '../../core/indicators';
import type { OrderType } from '../../engine/broker';
import { type ChartPane, IND_COLORS } from '../chartpane';
import { flipDrawing, posLevels, type Drawing } from '../drawings';
import { posCalc, type PosLevels, type PosSettings } from '../../engine/position';
import { h, money, toast, modal, field, numField } from '../dom';
import type { Workspace } from '../workspace';

export function tfPrompt(ws: Workspace, pane: ChartPane, initial: string) {
  const fav = ws.session.state.favTfs;
  const input = h('input', { type: 'text', value: initial, placeholder: 'e.g. 3m, 7m, 45m, 2H, 6H, 3D, 2W, M', class: 'tf-input' });
  const preview = h('div', { class: 'muted' }, ' ');
  const upd = () => {
    const tf = parseTf(input.value);
    preview.textContent = input.value
      ? tf
        ? `→ ${tf.label}`
        : 'Not a timeframe'
      : 'Any timeframe works: seconds (if your data has them), minutes, hours, days, weeks, months.';
  };
  input.oninput = upd;
  upd();
  const grid = h(
    'div',
    { class: 'tf-grid' },
    ...['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m', '1H', '2H', '3H', '4H', '6H', '8H', '12H', 'D', '2D', 'W', 'M'].map((t) =>
      h('button', { class: `chip${t === pane.cfg.tf ? ' on' : ''}`, onclick: () => apply(t) }, t, fav.includes(t) ? ' ★' : ''),
    ),
  );
  const favBtn = h('button', { class: 'ghost sm' }, '★ Toggle favourite for current');
  favBtn.onclick = () => {
    const t = parseTf(input.value)?.label ?? pane.cfg.tf;
    const i = fav.indexOf(t);
    if (i >= 0) fav.splice(i, 1);
    else fav.push(t);
    ws.renderSide();
    ws.scheduleSave();
    close();
  };
  const apply = (t: string) => {
    if (!pane.setTf(parseTf(t)?.label ?? t)) return toast('Unknown timeframe', 'err');
    close();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') apply(input.value);
  };
  const close = modal('Timeframe', h('div', { class: 'stack' }, input, preview, grid, favBtn));
  requestAnimationFrame(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

export function contextMenu(ws: Workspace, pane: ChartPane, price: number, x: number, y: number) {
  ws.closeMenu();
  const sym = pane.cfg.symbol;
  const br = ws.replay.broker;
  const dg = ws.session.specs[sym]?.digits ?? 5;
  const px = +price.toFixed(dg);
  const buyType: OrderType = px < br.ask(sym) ? 'limit' : 'stop';
  const sellType: OrderType = px > br.bid(sym) ? 'limit' : 'stop';
  const item = (label: string, fn: () => void, cls = '') =>
    h(
      'button',
      {
        class: `menu-item ${cls}`,
        onclick: () => {
          ws.closeMenu();
          fn();
        },
      },
      label,
    );
  const m = h(
    'div',
    { class: 'ctx-menu' },
    h('div', { class: 'menu-head' }, `${sym} @ ${px.toFixed(dg)}`),
    item(`Buy ${buyType} @ ${px.toFixed(dg)}`, () => ws.submit('long', { type: buyType, price: px, sym }), 'up'),
    item(`Sell ${sellType} @ ${px.toFixed(dg)}`, () => ws.submit('short', { type: sellType, price: px, sym }), 'dn'),
    h('div', { class: 'menu-sep' }),
    item('Market buy now', () => ws.submit('long', { type: 'market', price: 0, sym })),
    item('Market sell now', () => ws.submit('short', { type: 'market', price: 0, sym })),
    h('div', { class: 'menu-sep' }),
    item('Horizontal line here', () => {
      ws.drawings(sym).push({
        id: Math.random().toString(36).slice(2, 10),
        type: 'hline',
        pts: [{ t: pane.times[pane.times.length - 1] ?? 0, p: px }],
        color: '#d4a24c',
      });
      ws.drawingsChanged(sym);
    }),
    item('Remove all drawings', () => {
      ws.session.state.drawings[sym] = [];
      ws.drawingsChanged(sym);
    }),
  );
  m.style.left = `${Math.min(x, innerWidth - 220)}px`;
  m.style.top = `${Math.min(y, innerHeight - 260)}px`;
  document.body.append(m);
  ws.menu = m;
  setTimeout(() => document.addEventListener('pointerdown', ws.onDocDown, true));
}

export function drawingSettings(ws: Workspace, pane: ChartPane, d: Drawing) {
  const sym = pane.cfg.symbol;
  const sp = ws.session.specs[sym];
  const dg = sp?.digits ?? 5,
    pip = sp?.pipSize ?? 0.0001;
  const env = ws.posEnv(sym);
  const pos: PosSettings = { ...(d.pos ?? ws.posDefaults()) };
  const lv = posLevels(d);
  const num = (v: number, step: number) => h('input', { type: 'number', value: +v.toFixed(8), step }) as HTMLInputElement;
  const account = num(pos.account ?? ws.replay.broker.s.balance, 100);
  const mode = h(
    'select',
    {},
    h('option', { value: 'pct', selected: pos.riskMode === 'pct' }, 'Risk % of account'),
    h('option', { value: 'usd', selected: pos.riskMode === 'usd' }, 'Risk amount ($)'),
    h('option', { value: 'lots', selected: pos.riskMode === 'lots' }, 'Fixed lots'),
  ) as HTMLSelectElement;
  const risk = num(pos.risk, 0.1);
  const entry = num(lv.entry, Math.pow(10, -dg));
  const slP = num(lv.sl, Math.pow(10, -dg)),
    slPips = num(Math.abs(lv.entry - lv.sl) / pip, 0.1);
  const tpP = num(lv.tp, Math.pow(10, -dg)),
    tpPips = num(Math.abs(lv.tp - lv.entry) / pip, 0.1);
  const out = h('div', { class: 'calc' });
  const dir = () => (d.type === 'long' ? 1 : -1);
  const levels = (): PosLevels => ({ side: d.type === 'short' ? 'short' : 'long', entry: +entry.value, sl: +slP.value, tp: +tpP.value });
  const settings = (): PosSettings => ({ riskMode: mode.value as PosSettings['riskMode'], risk: +risk.value, account: +account.value || undefined });
  const show = () => {
    const c = posCalc(levels(), settings(), env);
    out.innerHTML = `<div><span>Qty</span><b>${c.lots.toFixed(2)} lots</b></div><div><span>R:R</span><b>${c.rr.toFixed(2)}</b></div>
      <div><span>Risk</span><b class="dn">${money(c.riskUsd)}</b></div><div><span>Reward</span><b class="up">${money(c.rewardUsd)}</b></div>
      ${c.invalid ? '<div class="lv"><span>Check</span><b class="dn">Stop or target is on the wrong side of the entry</b></div>' : ''}`;
  };
  // price ↔ pips stay in sync
  const fromSlPips = () => {
    slP.value = String(+(+entry.value - dir() * +slPips.value * pip).toFixed(dg));
    show();
  };
  const fromTpPips = () => {
    tpP.value = String(+(+entry.value + dir() * +tpPips.value * pip).toFixed(dg));
    show();
  };
  slPips.oninput = fromSlPips;
  tpPips.oninput = fromTpPips;
  slP.oninput = () => {
    slPips.value = String(+(Math.abs(+entry.value - +slP.value) / pip).toFixed(1));
    show();
  };
  tpP.oninput = () => {
    tpPips.value = String(+(Math.abs(+tpP.value - +entry.value) / pip).toFixed(1));
    show();
  };
  entry.oninput = () => {
    fromSlPips();
    fromTpPips();
  };
  account.oninput = mode.onchange = risk.oninput = show;
  show();
  const save = h('button', { class: 'primary' }, 'Save');
  const close = modal(
    `${d.type === 'long' ? 'Long' : 'Short'} position`,
    h(
      'div',
      { class: 'stack' },
      h('h4', {}, 'Risk'),
      h(
        'div',
        { class: 'row2' },
        field('Account size ($)', account, 'Defaults to the current balance'),
        field('Risk', h('div', { class: 'join' }, mode, risk)),
      ),
      h('h4', {}, 'Levels'),
      field('Entry price', entry),
      h('div', { class: 'row2' }, field('Profit level (price)', tpP), field('Profit level (pips)', tpPips)),
      h('div', { class: 'row2' }, field('Stop level (price)', slP), field('Stop level (pips)', slPips)),
      out,
      h(
        'div',
        { class: 'row-btns' },
        save,
        h(
          'button',
          {
            class: 'ghost',
            onclick: () => {
              flipDrawing(d);
              ws.drawingsChanged(sym);
              close();
              ws.drawingSettings(pane, d);
            },
          },
          '⇅ Flip to ' + (d.type === 'long' ? 'short' : 'long'),
        ),
      ),
    ),
  );
  save.onclick = () => {
    const l = levels();
    if (posCalc(l, settings(), env).invalid) return toast('The stop and target must be on opposite sides of the entry', 'err');
    d.pts[0].p = l.entry;
    d.pts[1].p = l.sl;
    d.pts[2].p = l.tp;
    d.pos = settings();
    ws.drawingsChanged(sym);
    if (ws.ticket.link === d.id) {
      ws.drawingSelected(pane, d);
    }
    close();
  };
}

export function indicatorsModal(ws: Workspace) {
  const pane = ws.active;
  const list = h('div', { class: 'stack' });
  const render = () => {
    list.innerHTML = '';
    list.append(h('div', { class: 'muted' }, `Indicators on chart ${pane.index + 1} (${pane.cfg.symbol} ${pane.cfg.tf})`));
    for (const cfg of pane.cfg.indicators) {
      const def = indicatorDef(cfg.type)!;
      const row = h('div', { class: 'ind-row' }, h('span', { class: 'dot', style: `background:${cfg.color}` }), h('b', {}, def.label));
      for (const k of Object.keys(def.params)) {
        const i = h('input', { type: 'number', value: cfg.params[k] ?? def.params[k], title: k, class: 'sm' });
        i.onchange = () => {
          cfg.params[k] = +i.value;
          pane.rebuildIndicators();
          ws.scheduleSave();
        };
        row.append(h('label', { class: 'mini-field' }, h('small', {}, k), i));
      }
      row.append(
        h(
          'button',
          {
            class: 'mini danger',
            onclick: () => {
              pane.cfg.indicators = pane.cfg.indicators.filter((x) => x !== cfg);
              pane.rebuildIndicators();
              ws.scheduleSave();
              render();
            },
          },
          'Remove',
        ),
      );
      list.append(row);
    }
    list.append(
      h(
        'div',
        { class: 'chips' },
        ...INDICATORS.map((d) =>
          h(
            'button',
            {
              class: 'chip',
              onclick: () => {
                pane.cfg.indicators.push({
                  id: Math.random().toString(36).slice(2, 8),
                  type: d.type,
                  params: { ...d.params },
                  color: IND_COLORS[pane.cfg.indicators.length % IND_COLORS.length],
                });
                pane.rebuildIndicators();
                ws.scheduleSave();
                render();
              },
            },
            `+ ${d.label}`,
          ),
        ),
      ),
    );
  };
  render();
  modal('Indicators', list, { wide: true });
}

export function settingsModal(ws: Workspace) {
  const s = ws.session;
  const tz = h(
    'select',
    {},
    ...ZONES.concat(ZONES.includes(s.timezone) ? [] : [s.timezone]).map((z) => h('option', { value: z, selected: z === s.timezone }, z)),
  );
  const comm = h('input', { type: 'number', step: 0.01, value: s.commissionPerLot });
  const slFirst = h('input', { type: 'checkbox', checked: s.slFirst });
  const autoShot = h('input', { type: 'checkbox', checked: ws.prefs.autoShot });
  const pauseClose = h('input', { type: 'checkbox', checked: ws.pauseOnClose });
  const specRows = s.symbols.map((sym) => {
    const sp = s.specs[sym];
    const spread = h('input', {
      type: 'number',
      step: 0.1,
      value: s.spreadPips[sym] ?? s.spreadPips['*'] ?? 0,
      class: 'sm',
      'aria-label': `${sym} spread in pips`,
    });
    const pip = h('input', { type: 'number', step: 'any', value: sp.pipSize, class: 'sm', 'aria-label': `${sym} pip size` });
    const cs = h('input', { type: 'number', step: 'any', value: sp.contractSize, class: 'sm', 'aria-label': `${sym} contract size` });
    const dg = h('input', { type: 'number', step: 1, value: sp.digits, class: 'sm', 'aria-label': `${sym} digits` });
    return { sym, spread, pip, cs, dg, row: h('tr', {}, h('td', {}, sym), h('td', {}, spread), h('td', {}, pip), h('td', {}, cs), h('td', {}, dg)) };
  });
  const tbl = h(
    'table',
    { class: 'tbl' },
    h('thead', { html: '<tr><th>Symbol</th><th>Spread (pips)</th><th>Pip size</th><th>Contract / lot</th><th>Digits</th></tr>' }),
    h('tbody', {}, ...specRows.map((r) => r.row)),
  );
  const save = h('button', { class: 'primary' }, 'Save settings');
  const close = modal(
    'Session settings',
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row2' }, field('Chart timezone', tz), field('Commission per lot per side ($)', comm)),
      h('label', { class: 'check' }, slFirst, ' If SL and TP are both touched inside one 1m bar, assume SL first (conservative)'),
      h('label', { class: 'check' }, autoShot, ' Auto-screenshot the chart when a trade closes (journal)'),
      h('label', { class: 'check' }, pauseClose, ' Pause playback when a trade closes'),
      h('h4', {}, 'Instruments'),
      tbl,
      save,
    ),
    { wide: true },
  );
  save.onclick = () => {
    // a pip size of 0 or "−1 digits" would stop this session from ever opening again: check before anything is changed
    let commission: number;
    const next: { sym: string; spread: number; pipSize: number; contractSize: number; digits: number }[] = [];
    try {
      commission = numField(comm, 'Commission', 0, 1000);
      for (const r of specRows)
        next.push({
          sym: r.sym,
          spread: numField(r.spread, `${r.sym} spread`, 0, 10000),
          pipSize: numField(r.pip, `${r.sym} pip size`, 1e-9, 1e6),
          contractSize: numField(r.cs, `${r.sym} contract size`, 1e-9, 1e9),
          digits: numField(r.dg, `${r.sym} digits`, 0, 10, true),
        });
    } catch (e) {
      return toast((e as Error).message, 'err');
    }
    s.timezone = tz.value;
    s.commissionPerLot = commission;
    s.slFirst = slFirst.checked;
    ws.prefs.autoShot = autoShot.checked;
    ws.pauseOnClose = pauseClose.checked;
    for (const r of next) {
      s.spreadPips[r.sym] = r.spread;
      s.specs[r.sym] = { ...s.specs[r.sym], pipSize: r.pipSize, contractSize: r.contractSize, digits: r.digits };
    }
    Object.assign(ws.replay.broker.cfg, { commissionPerLot: s.commissionPerLot, slFirst: s.slFirst, spreadPips: s.spreadPips });
    ws.savePrefs();
    ws.panes.forEach((p) => p.load());
    ws.afterTrade();
    close();
  };
}

export function helpModal(_ws: Workspace) {
  const rows: [string, string][] = [
    ['Space', 'Play / pause'],
    ['→', 'Next candle on the active chart'],
    ['Shift + →', 'Next 1-minute tick'],
    ['Shift + B / Shift + S', 'Market buy / sell with the ticket settings'],
    ['Shift + C', 'Close all positions'],
    ['Type a number / "4h" / "d"', 'Change timeframe of the active chart'],
    ['Alt + T/H/V/R/F/L/S/M', 'Trend, H-line, V-line, Rect, Fib, Long, Short, Measure'],
    ['Esc', 'Cursor tool / close dialog'],
    ['Delete / Backspace', 'Delete the selected drawing'],
    ['1 … 4 (with Alt)', 'Layout with 1–4 charts'],
  ];
  modal('Keyboard shortcuts', h('table', { class: 'tbl' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v))))));
}
