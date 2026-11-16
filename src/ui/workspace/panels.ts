import { fmtLocal, offsetFn, localToUtc } from '../../core/tz';
import { indicatorDef } from '../../core/indicators';
import type { ChartPane, CrosshairInfo } from '../chartpane';
import { TOOL_INFO, isPosTool, type DrawingType } from '../drawings';
import { listDatasets, loadBars } from '../../data/store';
import { indexAtOrBefore } from '../../core/types';
import { h, money, num, cls, toast, field, parseDateInput, dateInputValue } from '../dom';
import type { Workspace } from '../workspace';
import { type Panel, PANELS, nextUtcHour } from './shared';

export function buildRail(ws: Workspace) {
  const rail = h('div', { class: 'rail', role: 'toolbar', 'aria-label': 'Panels' });
  for (const p of PANELS) {
    const b = h(
      'button',
      { class: 'rail-btn', 'data-panel': p.id, title: p.title, 'aria-label': p.title },
      h('span', { class: 'ri' }, p.icon),
      h('small', {}, p.label),
    );
    b.onclick = () => ws.openPanel(p.id, true);
    rail.append(b);
  }
  return rail;
}

export function buildSheet(ws: Workspace) {
  ws.sheetBody = h('div', { class: 'sheet-body' });
  const handle = h('div', { class: 'sheet-handle', title: 'Swipe down to close' }, h('i', {}));
  ws.sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-label': 'Order ticket', 'aria-hidden': 'true' },
    handle,
    h(
      'div',
      { class: 'sheet-head' },
      h('b', {}, 'Order'),
      h('button', { class: 'ghost sm', 'aria-label': 'Close the order sheet', onclick: () => ws.closeSheet() }, '✕'),
    ),
    ws.sheetBody,
  );
  // swipe down on the handle closes the sheet
  let y0: number | null = null;
  handle.addEventListener('pointerdown', (e) => {
    y0 = e.clientY;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    ws.sheet.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`;
  });
  const up = (e: PointerEvent) => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    y0 = null;
    ws.sheet.style.transform = '';
    if (dy > 60) ws.closeSheet();
  };
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  const bid = h('b', { 'data-tb': 'bid' }),
    ask = h('b', { 'data-tb': 'ask' });
  ws.tradeBar = h(
    'div',
    { class: 'trade-bar' },
    h('button', { class: 'tb-sell', title: 'Sell at market with the ticket settings', onclick: () => ws.submit('short') }, h('small', {}, 'SELL'), bid),
    ws.session.live ? null : h('button', { class: 'tb-play', 'aria-label': 'Play / pause', onclick: () => ws.togglePlay() }, '▶'),
    h('button', { class: 'tb-order', onclick: () => (ws.sheetOpen ? ws.closeSheet() : ws.openSheet()) }, 'Order ▴'),
    h('button', { class: 'tb-buy', title: 'Buy at market with the ticket settings', onclick: () => ws.submit('long') }, h('small', {}, 'BUY'), ask),
  );
}

export function renderTradeBar(ws: Workspace) {
  if (!ws.tradeBar || !ws.active) return;
  const br = ws.replay.broker,
    sym = ws.active.cfg.symbol;
  const dg = ws.session.specs[sym]?.digits ?? 5;
  const b = ws.tradeBar.querySelector('[data-tb=bid]'),
    a = ws.tradeBar.querySelector('[data-tb=ask]');
  if (b) b.textContent = br.bid(sym).toFixed(dg);
  if (a) a.textContent = br.ask(sym).toFixed(dg);
  const play = ws.tradeBar.querySelector('.tb-play');
  if (play) play.textContent = ws.playing ? '❚❚' : '▶';
  ws.flashPrice(sym, br.bid(sym));
  const ord = ws.tradeBar.querySelector('.tb-order');
  if (ord) ord.textContent = ws.sheetOpen ? 'Order ▾' : 'Order ▴';
}

export function openSheet(ws: Workspace) {
  ws.sheetOpen = true;
  ws.sheet.classList.add('open');
  ws.sheet.setAttribute('aria-hidden', 'false');
  ws.renderOrder();
  ws.renderTradeBar();
  // keep the chart in view above the sheet
  ws.grid.scrollIntoView({ block: 'start', behavior: 'smooth' });
  ws.panes.forEach((p) => p.redraw());
}

export function closeSheet(ws: Workspace, redraw = true) {
  if (!ws.sheetOpen) return;
  ws.sheetOpen = false;
  ws.sheet.classList.remove('open');
  ws.sheet.setAttribute('aria-hidden', 'true');
  ws.renderTradeBar();
  if (redraw) ws.panes.forEach((p) => p.redraw());
}

/** ✕ on the chart's order preview box */
export function previewClosed(ws: Workspace) {
  ws.prefs.preview = false;
  ws.savePrefs();
  toast('Order preview hidden — turn it back on with “Show on chart” in the order ticket.', 'info');
  ws.panes.forEach((p) => p.redraw());
  ws.renderSide();
}

/** Show a side panel; clicking the active one again collapses the side area. */
export function openPanel(ws: Workspace, id: Panel, toggle = false) {
  const pr = ws.prefs;
  if (id === 'order' && ws.mobile) {
    ws.sheetOpen ? ws.closeSheet() : ws.openSheet();
    return;
  }
  if (toggle && pr.panel === id && !pr.sideCollapsed) pr.sideCollapsed = true;
  else {
    pr.panel = id;
    pr.sideCollapsed = false;
  }
  ws.savePrefs();
  ws.renderSide();
  // the newly shown panel fades in
  ws.right.classList.remove('panel-in');
  void ws.right.offsetWidth;
  ws.right.classList.add('panel-in');
  ws.panes.forEach((p) => p.redraw());
}

export function renderSide(ws: Workspace) {
  if (!ws.active) return;
  const pr = ws.prefs;
  ws.rail?.querySelectorAll<HTMLButtonElement>('.rail-btn').forEach((b) => {
    const on =
      ws.mobile && b.dataset.panel === 'order' ? ws.sheetOpen : b.dataset.panel === pr.panel && !pr.sideCollapsed && !(ws.mobile && pr.panel === 'order');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  ws.renderTradeBar();
  const mobileOrder = ws.mobile && (pr.panel === 'order' || pr.sideCollapsed);
  ws.right.classList.toggle('hidden', pr.sideCollapsed || mobileOrder);
  if (ws.mobile && ws.sheetOpen) ws.renderOrder();
  if (pr.sideCollapsed || mobileOrder) return;
  if (pr.panel === 'goto') return ws.renderGoto();
  if (pr.panel === 'watch') return ws.renderWatch();
  if (pr.panel === 'tree') return ws.renderTree();
  if (pr.panel === 'data') return ws.renderData();
  if (!ws.mobile) ws.renderOrder();
}

export function panelHead(_ws: Workspace, title: string, sub?: string) {
  return h('div', { class: 'card-title' }, h('span', {}, title), sub ? h('small', { class: 'muted' }, sub) : null);
}

export function renderGoto(ws: Workspace) {
  if (ws.right.contains(document.activeElement)) return;
  const off = offsetFn(ws.tz);
  const now = ws.replay.clock;
  const input = h('input', { type: 'datetime-local', class: 'jump', id: 'gotoAt', value: dateInputValue(now - 1 + off(now - 1)) });
  const go = h(
    'button',
    {
      class: 'primary',
      onclick: () => {
        if (!input.value) return;
        const utc = localToUtc(parseDateInput(input.value), off);
        if (utc <= ws.replay.clock) return toast('You can only move forward in time — no peeking at the past outcome.', 'err');
        ws.jump(utc);
      },
    },
    'Go',
  );
  const q = (label: string, title: string, fn: () => void) => h('button', { class: 'ghost sm', title, onclick: fn }, label);
  const tfSec = ws.active.tf.sec;
  const nextMonday = () => {
    let t = Math.floor(now / 86400) * 86400 + 86400;
    while (new Date(t * 1000).getUTCDay() !== 1) t += 86400;
    return t;
  };
  const end = ws.replay.dataEnd();
  ws.right.innerHTML = '';
  ws.right.append(
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Go to', `Now ${fmtLocal(now - 1 + off(now - 1), true)}`),
      h('p', { class: 'muted small' }, 'Jump forward only. Every bar on the way is processed, so orders, stops and targets fill exactly as they would have.'),
      field(`Date & time (${ws.tz})`, h('div', { class: 'join' }, input, go)),
      h('small', { class: 'muted' }, `Data ends ${fmtLocal(end + off(end)).slice(0, 16)}`),
    ),
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Skip ahead'),
      h(
        'div',
        { class: 'chips' },
        q(`+10 bars`, `Skip 10 ${ws.active.tf.label} candles`, () => ws.jump(now + 10 * tfSec)),
        q(`+50 bars`, `Skip 50 ${ws.active.tf.label} candles`, () => ws.jump(now + 50 * tfSec)),
        q('+1H', 'Skip 1 hour', () => ws.jump(now + 3600)),
        q('+4H', 'Skip 4 hours', () => ws.jump(now + 4 * 3600)),
        q('+1D', 'Skip 1 day', () => ws.jump(now + 86400)),
        q('+1W', 'Skip 1 week', () => ws.jump(now + 7 * 86400)),
      ),
    ),
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Next session open'),
      h(
        'div',
        { class: 'chips' },
        q('Tokyo', 'Next Tokyo open (00:00 UTC)', () => ws.jump(nextUtcHour(now, 0))),
        q('London', 'Next London open (07:00 UTC)', () => ws.jump(nextUtcHour(now, 7))),
        q('New York', 'Next New York open (13:30 UTC)', () => ws.jump(nextUtcHour(now, 13.5))),
        q('Next week', 'Next Monday 00:00 UTC', () => ws.jump(nextMonday())),
      ),
    ),
  );
}

export function renderWatch(ws: Workspace) {
  if (ws.right.contains(document.activeElement)) return;
  const br = ws.replay.broker;
  const off = offsetFn(ws.tz);
  const rows = ws.session.symbols.map((sym) => {
    const b = ws.replay.data[sym];
    const sp = ws.session.specs[sym];
    const dg = sp?.digits ?? 5;
    const bid = br.bid(sym);
    const c = ws.replay.clock - 1;
    const dayStart = Math.floor((c + off(c)) / 86400) * 86400 - off(c);
    const i0 = b ? Math.max(0, indexAtOrBefore(b.t, b.n, dayStart - 1) + 1) : -1;
    const open = b && i0 >= 0 && i0 < b.n ? b.o[i0] : NaN;
    const ch = isFinite(open) && open ? ((bid - open) / open) * 100 : NaN;
    const active = ws.active.cfg.symbol === sym;
    return h(
      'button',
      {
        class: `watch-row${active ? ' on' : ''}`,
        title: `Show ${sym} on the active chart`,
        onclick: () => {
          ws.active.setSymbol(sym);
          ws.renderSide();
        },
      },
      h('b', {}, sym),
      h('span', { class: 'num' }, isFinite(bid) ? bid.toFixed(dg) : '—'),
      h('span', { class: `num ${isFinite(ch) ? (ch >= 0 ? 'up' : 'dn') : 'muted'}` }, isFinite(ch) ? `${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(2)}%` : '—'),
      h('small', { class: 'muted' }, `spread ${num((br.ask(sym) - bid) / (sp?.pipSize ?? 1), 1)}`),
    );
  });
  const addSel = h('select', { id: 'watchAdd' }, h('option', { value: '' }, 'Loading datasets…')) as HTMLSelectElement;
  const add = h('button', { class: 'ghost', disabled: true }, 'Add') as HTMLButtonElement;
  void listDatasets().then((ds) => {
    const c = ws.replay.clock;
    const ok = ds.filter((d) => !ws.session.symbols.includes(d.id) && d.from < c && d.to > c);
    addSel.replaceChildren(
      h('option', { value: '' }, ok.length ? 'Add a symbol…' : 'No other dataset covers this date'),
      ...ok.map((d) => h('option', { value: d.id }, `${d.symbol} · ${d.source}`)),
    );
    add.disabled = !ok.length;
    add.onclick = async () => {
      const meta = ok.find((d) => d.id === addSel.value);
      if (!meta) return;
      add.disabled = true;
      const bars = await loadBars(meta.id);
      if (!bars) return toast(`Could not load ${meta.id}`, 'err');
      ws.replay.addSymbol(meta.id, bars, meta.spec);
      ws.panes.forEach((p) => p.renderHeader());
      ws.active.setSymbol(meta.id);
      ws.scheduleSave();
      toast(`${meta.id} added — it replays in sync from ${fmtLocal(c - 1 + offsetFn(ws.tz)(c - 1)).slice(0, 16)}`, 'ok');
      ws.renderSide();
    };
  });
  ws.right.innerHTML = '';
  ws.right.append(
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Watchlist', `${ws.session.symbols.length} symbol${ws.session.symbols.length === 1 ? '' : 's'}`),
      h(
        'div',
        { class: 'watch' },
        h('div', { class: 'watch-head' }, h('span', {}, 'Symbol'), h('span', {}, 'Bid'), h('span', {}, 'Day'), h('span', {}, '')),
        ...rows,
      ),
    ),
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Add to this session'),
      h(
        'p',
        { class: 'muted small' },
        'Any stored dataset that covers the current replay date. It joins the replay clock, so every symbol stays time-synchronised.',
      ),
      h('div', { class: 'join' }, addSel, add),
    ),
  );
}

export function renderTree(ws: Workspace) {
  if (ws.right.contains(document.activeElement)) return;
  const sym = ws.active.cfg.symbol;
  const dg = ws.session.specs[sym]?.digits ?? 5;
  const ds = ws.drawings(sym);
  const br = ws.replay.broker;
  const icon = (t: DrawingType) => TOOL_INFO.find((x) => x.type === t)?.icon ?? '•';
  const name = (t: DrawingType) => (TOOL_INFO.find((x) => x.type === t)?.title ?? t).replace(/\s*\(.*$/, '');
  const btn = (label: string, title: string, fn: () => void, extra = '') =>
    h('button', { class: `mini${extra}`, title, 'aria-label': title, onclick: fn }, label);
  const drawRows = ds.map((d) =>
    h(
      'div',
      { class: `tree-row${ws.active.layer.selected === d ? ' on' : ''}${d.hidden ? ' off' : ''}` },
      h('span', { class: 'dot', style: `background:${d.color}` }),
      h(
        'button',
        {
          class: 'tree-name',
          title: 'Select on the chart',
          onclick: () => {
            if (d.hidden) d.hidden = false;
            ws.active.layer.selected = d;
            ws.drawingsChanged(sym);
            ws.renderSide();
          },
        },
        `${icon(d.type)} ${name(d.type)}`,
        h('small', { class: 'muted' }, ` ${isPosTool(d) ? `@ ${d.pts[0].p.toFixed(dg)}` : d.pts.length ? d.pts[0].p.toFixed(dg) : ''}`),
      ),
      btn(d.hidden ? '◌' : '◉', d.hidden ? 'Show' : 'Hide', () => {
        d.hidden = !d.hidden;
        if (d.hidden && ws.active.layer.selected === d) ws.active.layer.selected = null;
        ws.drawingsChanged(sym);
        ws.renderSide();
      }),
      btn(d.locked ? '🔒' : '🔓', d.locked ? 'Unlock' : 'Lock', () => {
        d.locked = !d.locked;
        ws.drawingsChanged(sym);
        ws.renderSide();
      }),
      btn(
        '✕',
        'Delete',
        () => {
          ds.splice(ds.indexOf(d), 1);
          if (ws.active.layer.selected === d) ws.active.layer.selected = null;
          ws.drawingsChanged(sym);
          ws.renderSide();
        },
        ' danger',
      ),
    ),
  );
  const indRows = ws.active.cfg.indicators.map((cfg) =>
    h(
      'div',
      { class: 'tree-row' },
      h('span', { class: 'dot', style: `background:${cfg.color}` }),
      h(
        'span',
        { class: 'tree-name' },
        `ƒ ${indicatorDef(cfg.type)?.label ?? cfg.type}`,
        h('small', { class: 'muted' }, ` ${Object.values(cfg.params).join(', ')}`),
      ),
      btn(
        '✕',
        'Remove indicator',
        () => {
          ws.active.cfg.indicators = ws.active.cfg.indicators.filter((x) => x !== cfg);
          ws.active.rebuildIndicators();
          ws.scheduleSave();
          ws.renderSide();
        },
        ' danger',
      ),
    ),
  );
  const tradeRows = [
    ...br.s.positions
      .filter((p) => p.symbol === sym)
      .map((p) =>
        h(
          'div',
          { class: 'tree-row' },
          h('span', { class: `dot ${p.side === 'long' ? 'bg-up' : 'bg-dn'}` }),
          h(
            'span',
            { class: 'tree-name' },
            `${p.side === 'long' ? 'BUY' : 'SELL'} ${p.lots} @ ${p.entry.toFixed(dg)}`,
            h('small', { class: `${cls(br.floating(p))}` }, ` ${money(br.floating(p), true)}`),
          ),
          btn('✕', `Close position #${p.id}`, () => ws.lineAction('close', p.id), ' danger'),
        ),
      ),
    ...br.s.orders
      .filter((o) => o.symbol === sym)
      .map((o) =>
        h(
          'div',
          { class: 'tree-row' },
          h('span', { class: 'dot', style: 'background:#d4a24c' }),
          h('span', { class: 'tree-name' }, `${o.side === 'long' ? 'BUY' : 'SELL'} ${o.type.toUpperCase()} ${o.lots} @ ${o.price.toFixed(dg)}`),
          btn('✕', `Cancel order #${o.id}`, () => ws.lineAction('cancel', o.id), ' danger'),
        ),
      ),
  ];
  const empty = (t: string) => h('p', { class: 'muted small' }, t);
  ws.right.innerHTML = '';
  ws.right.append(
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Drawings', `${sym} · all timeframes`),
      ...(drawRows.length ? drawRows : [empty('No drawings on this symbol yet — pick a tool on the left.')]),
      ds.length
        ? h(
            'div',
            { class: 'row-btns' },
            h(
              'button',
              {
                class: 'ghost sm',
                onclick: () => {
                  ds.forEach((d) => (d.hidden = false));
                  ws.drawingsChanged(sym);
                  ws.renderSide();
                },
              },
              'Show all',
            ),
            h(
              'button',
              {
                class: 'ghost sm',
                onclick: () => {
                  ds.forEach((d) => (d.hidden = true));
                  ws.active.layer.selected = null;
                  ws.drawingsChanged(sym);
                  ws.renderSide();
                },
              },
              'Hide all',
            ),
          )
        : null,
    ),
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Indicators', `Chart ${ws.active.index + 1} · ${ws.active.cfg.tf}`),
      ...(indRows.length ? indRows : [empty('No indicators — add them with ƒx Indicators.')]),
    ),
    h('section', { class: 'card stack' }, ws.panelHead('Orders & positions', sym), ...(tradeRows.length ? tradeRows : [empty('Nothing open on this symbol.')])),
  );
}

export function renderData(ws: Workspace) {
  const p = ws.active;
  const info = ws.dataInfo ?? p.lastInfo();
  const dg = ws.session.specs[p.cfg.symbol]?.digits ?? 5;
  const row = (k: string, v: string, c = '') => h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: c }, v));
  const fx = (v: number) =>
    isFinite(v) ? (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toFixed(Math.max(2, Math.min(dg, 6)))) : '—';
  ws.right.innerHTML = '';
  if (!info) {
    ws.right.append(h('section', { class: 'card' }, ws.panelHead('Data window'), h('p', { class: 'muted small' }, 'No candle yet.')));
    return;
  }
  const ch = info.c - info.o;
  ws.right.append(
    h(
      'section',
      { class: 'card stack' },
      ws.panelHead('Data window', ws.dataInfo ? 'Under the cursor' : 'Latest candle'),
      row('Symbol', `${p.cfg.symbol} · ${p.tf.label}`),
      row('Time', fmtLocal(info.t, true)),
      row('Open', info.o.toFixed(dg)),
      row('High', info.h.toFixed(dg)),
      row('Low', info.l.toFixed(dg)),
      row('Close', info.c.toFixed(dg), ch >= 0 ? 'up' : 'dn'),
      row('Change', `${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(dg)} (${((ch / info.o) * 100).toFixed(2)}%)`, ch >= 0 ? 'up' : 'dn'),
      row('Range', `${(info.h - info.l).toFixed(dg)} · ${((info.h - info.l) / (ws.session.specs[p.cfg.symbol]?.pipSize ?? 1)).toFixed(1)} pips`),
      info.v ? row('Volume', info.v.toLocaleString('en-US', { maximumFractionDigits: 2 })) : null,
    ),
    info.ind.length
      ? h(
          'section',
          { class: 'card stack' },
          ws.panelHead('Indicators'),
          ...info.ind.map((x) =>
            h(
              'div',
              { class: 'kv' },
              h('span', {}, h('i', { class: 'dot', style: `background:${x.color}` }), ` ${x.label}`),
              h('b', {}, x.values.map(fx).join(' · ')),
            ),
          ),
        )
      : '',
  );
}

export function crosshairData(ws: Workspace, pane: ChartPane, info: CrosshairInfo | null) {
  if (pane !== ws.active) return;
  ws.dataInfo = info;
  if (ws.prefs.panel === 'data' && !ws.prefs.sideCollapsed) ws.renderData();
}
