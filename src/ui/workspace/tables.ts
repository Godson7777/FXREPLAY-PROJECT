import { flash } from '../motion';
import { fmtLocal, fmtDuration, offsetFn } from '../../core/tz';
import type { Trade } from '../../engine/broker';
import { getShot } from '../../data/sessions';
import { h, patchChildren, money, num, cls, toast, modal, field } from '../dom';
import type { Workspace } from '../workspace';
import { kv, emptyRow } from './shared';

export function applyBottom(ws: Workspace) {
  const c = ws.prefs.bottomCollapsed;
  ws.bottom.classList.toggle('collapsed', c);
  ws.bottom.style.height = c ? '' : `${Math.round(ws.prefs.bottomH)}px`;
  const t = ws.bottom.querySelector<HTMLButtonElement>('.bottom-toggle');
  if (t) {
    t.textContent = c ? '▴' : '▾';
    t.title = c ? 'Show the panel (swipe up or `)' : 'Hide the panel (swipe down or `)';
  }
}

export function toggleBottom(ws: Workspace, open = ws.prefs.bottomCollapsed) {
  ws.prefs.bottomCollapsed = !open;
  ws.applyBottom();
  ws.savePrefs();
}

export function initBottomGestures(ws: Workspace) {
  const el = ws.bottom;
  let start: { y: number; h: number; t: number; id: number } | null = null;
  let dragging = false;
  let lastH = 0;
  const maxH = () => Math.max(120, Math.round(window.innerHeight * 0.6));
  el.addEventListener('pointerdown', (e) => {
    const tgt = e.target as HTMLElement;
    if (e.button !== 0 || !tgt.closest('.bottom-handle, .tabs') || tgt.closest('.bottom-toggle, input, select')) return;
    start = { y: e.clientY, h: el.getBoundingClientRect().height, t: performance.now(), id: e.pointerId };
    dragging = false;
    // track on window: the pointer leaves the panel as soon as it is dragged upwards
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
  const move = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = start.y - e.clientY;
    if (!dragging) {
      if (Math.abs(dy) < 6) return;
      dragging = true;
      el.classList.add('resizing');
      el.classList.remove('collapsed');
    }
    lastH = Math.max(36, Math.min(maxH(), start.h + dy));
    el.style.height = `${lastH}px`;
  };
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const s0 = start;
    start = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!dragging) return;
    dragging = false;
    el.classList.remove('resizing');
    const dy = s0.y - e.clientY;
    const fast = performance.now() - s0.t < 300 && Math.abs(dy) > 30;
    // swallow the click that follows a drag so a tab under the finger isn't toggled
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    el.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
    if ((fast && dy < 0) || lastH < 90) {
      ws.prefs.bottomCollapsed = true;
      if (s0.h >= 90) ws.prefs.bottomH = s0.h;
    } else {
      ws.prefs.bottomCollapsed = false;
      ws.prefs.bottomH = fast && dy > 0 ? Math.max(lastH, ws.prefs.bottomH, 210) : lastH;
    }
    ws.applyBottom();
    ws.savePrefs();
  };
}

/** Green/red blink on the quotes when the price moves (not during fast playback, where it would strobe). */
export function flashPrice(ws: Workspace, sym: string, px: number) {
  const last = ws.lastPx;
  ws.lastPx = { sym, px };
  if (!last || last.sym !== sym || last.px === px || (ws.playing && ws.prefs.speed > 5)) return;
  const dir = px > last.px ? 'up' : 'dn';
  queueMicrotask(() => {
    ws.root.querySelectorAll('[data-live=bid], [data-live=ask], [data-tb=bid], [data-tb=ask]').forEach((el) => flash(el, dir));
  });
}

/** Say how each newly closed trade ended, and let the new rows announce themselves. */
export function announce(ws: Workspace) {
  const br = ws.replay.broker;
  const maxPos = br.s.positions.reduce((m, p) => Math.max(m, p.id), 0);
  if (ws.seenPos < 0) ws.seenPos = maxPos;
  else if (maxPos > ws.seenPos) window.setTimeout(() => (ws.seenPos = Math.max(ws.seenPos, maxPos)), 1400);
  const n = br.s.trades.length;
  if (ws.seenTrades < 0) ws.seenTrades = ws.announced = n; // what was there when the session opened is not news
  if (n < ws.announced) ws.seenTrades = ws.announced = n; // trades were replaced (sync, restore)
  if (n > ws.seenTrades) window.setTimeout(() => (ws.seenTrades = Math.max(ws.seenTrades, n)), 1400);
  if (n <= ws.announced) return;
  const fresh = br.s.trades.slice(Math.max(ws.announced, n - 2)); // each trade once; at most two toasts at a time
  ws.announced = n;
  for (const t of fresh) {
    const how =
      t.exitReason === 'tp'
        ? 'Target hit'
        : t.exitReason === 'sl'
          ? 'Stopped out'
          : t.exitReason === 'liq'
            ? 'Liquidated'
            : t.exitReason === 'be'
              ? 'Stopped at breakeven'
              : t.exitReason === 'trail'
                ? 'Trailing stop hit'
                : 'Closed';
    toast(
      `${how} · ${t.symbol} ${t.side === 'long' ? 'long' : 'short'} · ${money(t.pnl, true)}${t.r != null ? ` (${num(t.r, 2, true)}R)` : ''}`,
      t.pnl >= 0 ? 'ok' : 'err',
    );
  }
  queueMicrotask(() => {
    const tab = Array.from(ws.bottom.querySelectorAll('.tab')).find((b) => b.textContent?.startsWith('History'));
    if (tab) flash(tab, fresh[fresh.length - 1].pnl >= 0 ? 'up' : 'dn');
  });
}

export function renderBottom(ws: Workspace) {
  const br = ws.replay.broker;
  ws.announce();
  const tabs = h(
    'div',
    { class: 'tabs' },
    ...(['positions', 'orders', 'history'] as const).map((t) =>
      h(
        'button',
        {
          class: `tab${ws.tab === t ? ' on' : ''}`,
          onclick: () => {
            ws.tab = t;
            if (ws.prefs.bottomCollapsed) ws.toggleBottom(true);
            ws.renderBottom();
          },
        },
        t === 'positions' ? `Positions (${br.s.positions.length})` : t === 'orders' ? `Orders (${br.s.orders.length})` : `History (${br.s.trades.length})`,
      ),
    ),
    h('div', { class: 'spacer' }),
    br.s.positions.length
      ? h(
          'button',
          {
            class: 'ghost sm',
            onclick: () => {
              br.closeAll();
              ws.afterTrade();
            },
          },
          'Close all',
        )
      : null,
    h(
      'button',
      {
        class: 'ghost sm bottom-toggle',
        type: 'button',
        title: ws.prefs.bottomCollapsed ? 'Show the panel (swipe up or `)' : 'Hide the panel (swipe down or `)',
        onclick: () => ws.toggleBottom(),
      },
      ws.prefs.bottomCollapsed ? '▴' : '▾',
    ),
  );
  const body = h('div', { class: 'table-wrap' });
  const t = h('table', { class: 'tbl' });
  body.append(t);
  if (ws.tab === 'positions') {
    const levd = br.s.positions.some((p) => p.leverage);
    t.innerHTML = `<thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Lots</th>${levd ? '<th>Lev</th><th>Margin</th><th>Liq</th>' : ''}<th>Entry</th><th>SL</th><th>TP</th><th>Pips</th><th>R</th><th>P&L</th><th>Opened</th><th></th></tr></thead>`;
    const tb = h('tbody');
    for (const p of br.s.positions) {
      const sp = ws.session.specs[p.symbol];
      const dg = sp?.digits ?? 5;
      const px = p.side === 'long' ? br.bid(p.symbol) : br.ask(p.symbol);
      const pips = ((p.side === 'long' ? 1 : -1) * (px - p.entry)) / (sp?.pipSize ?? 1);
      const fl = br.floating(p);
      const rNow = p.initialSl != null ? ((p.side === 'long' ? 1 : -1) * (px - p.entry)) / Math.abs(p.entry - p.initialSl) : null;
      const off = offsetFn(ws.tz);
      const tr = h(
        'tr',
        { class: p.id > ws.seenPos ? 'row-new' : '' },
        h('td', {}, `${p.id}`),
        h('td', {}, p.symbol),
        h('td', { class: p.side === 'long' ? 'up' : 'dn' }, p.side.toUpperCase()),
        h('td', {}, p.lots.toFixed(2)),
        ...(levd
          ? [
              h('td', {}, p.leverage ? `${p.leverage}×` : '—'),
              h('td', {}, p.margin != null ? money(p.margin) : '—'),
              h('td', { class: 'warn-ink' }, p.liq != null ? p.liq.toFixed(dg) : '—'),
            ]
          : []),
        h('td', {}, p.entry.toFixed(dg)),
        h('td', {}, ws.levelInput(p.id, 'sl', p.sl, dg)),
        h('td', {}, ws.levelInput(p.id, 'tp', p.tp, dg)),
        h('td', { class: cls(pips) }, num(pips, 1, true)),
        h('td', { class: cls(rNow ?? 0) }, rNow != null ? num(rNow, 2, true) : '—'),
        h('td', { class: cls(fl) }, money(fl, true)),
        h('td', { class: 'muted' }, fmtLocal(p.entryTime + off(p.entryTime))),
        h(
          'td',
          { class: 'acts' },
          h(
            'button',
            {
              class: 'mini',
              title: 'Move SL to breakeven',
              onclick: () => {
                const err = br.breakeven(p.id);
                if (err) toast(err, 'err');
                ws.afterTrade();
              },
            },
            'BE',
          ),
          h(
            'button',
            {
              class: 'mini',
              title: 'Close half',
              onclick: ws.rowAct(`half${p.id}`, false, () => {
                br.close(p.id, 0.5);
                ws.afterTrade();
              }),
            },
            '½',
          ),
          h(
            'button',
            {
              class: 'mini',
              title: 'Reverse position',
              onclick: ws.rowAct(`rev${p.id}`, true, () => {
                const r = br.reverse(p.id);
                if (!r.ok) toast(r.error, 'err');
                ws.afterTrade();
              }),
            },
            '⇄',
          ),
          h(
            'button',
            {
              class: 'mini danger',
              title: 'Close',
              onclick: ws.rowAct(`close${p.id}`, true, () => {
                br.close(p.id);
                ws.afterTrade();
              }),
            },
            '✕',
          ),
        ),
      );
      tb.append(tr);
    }
    if (!br.s.positions.length)
      tb.append(emptyRow(levd ? 15 : 12, 'No open positions — use the ticket on the right, Shift+B / Shift+S, or the Long/Short R:R tool.'));
    t.append(tb);
  } else if (ws.tab === 'orders') {
    t.innerHTML = `<thead><tr><th>#</th><th>Symbol</th><th>Type</th><th>Side</th><th>Lots</th><th>Price</th><th>SL</th><th>TP</th><th>Placed</th><th></th></tr></thead>`;
    const tb = h('tbody');
    const off = offsetFn(ws.tz);
    for (const o of br.s.orders) {
      const dg = ws.session.specs[o.symbol]?.digits ?? 5;
      tb.append(
        h(
          'tr',
          {},
          h('td', {}, `${o.id}`),
          h('td', {}, o.symbol),
          h('td', {}, o.type),
          h('td', { class: o.side === 'long' ? 'up' : 'dn' }, o.side.toUpperCase()),
          h('td', {}, o.lots.toFixed(2)),
          h('td', {}, o.price.toFixed(dg)),
          h('td', {}, o.sl?.toFixed(dg) ?? '—'),
          h('td', {}, o.tp?.toFixed(dg) ?? '—'),
          h('td', { class: 'muted' }, fmtLocal(o.createdAt + off(o.createdAt))),
          h(
            'td',
            { class: 'acts' },
            h(
              'button',
              {
                class: 'mini danger',
                onclick: ws.rowAct(`cancel${o.id}`, true, () => {
                  br.cancelOrder(o.id);
                  ws.afterTrade();
                }),
              },
              'Cancel',
            ),
          ),
        ),
      );
    }
    if (!br.s.orders.length) tb.append(emptyRow(10, 'No pending orders. Drag order/SL/TP lines on the chart to adjust them.'));
    t.append(tb);
  } else {
    t.innerHTML = `<thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Lots</th><th>Entry</th><th>Exit</th><th>Pips</th><th>R</th><th>P&L</th><th>Exit by</th><th>Held</th><th>Tags</th><th></th></tr></thead>`;
    const tb = h('tbody');
    for (const [ti, tr] of [...br.s.trades].reverse().slice(0, 200).entries()) {
      const dg = ws.session.specs[tr.symbol]?.digits ?? 5;
      tb.append(
        h(
          'tr',
          { class: br.s.trades.length - 1 - ti >= ws.seenTrades ? `row-new ${tr.pnl >= 0 ? 'win' : 'loss'}` : '' },
          h('td', {}, `${tr.id}`),
          h('td', {}, tr.symbol),
          h('td', { class: tr.side === 'long' ? 'up' : 'dn' }, tr.side.toUpperCase()),
          h('td', {}, tr.lots.toFixed(2)),
          h('td', {}, tr.entry.toFixed(dg)),
          h('td', {}, tr.exit.toFixed(dg)),
          h('td', { class: cls(tr.pips) }, num(tr.pips, 1, true)),
          h('td', { class: cls(tr.r ?? 0) }, tr.r != null ? num(tr.r, 2, true) : '—'),
          h('td', { class: cls(tr.pnl) }, money(tr.pnl, true)),
          h('td', {}, tr.exitReason.toUpperCase()),
          h('td', {}, fmtDuration(tr.holdSec)),
          h('td', { class: 'muted' }, tr.tags.join(', ')),
          h('td', { class: 'acts' }, h('button', { class: 'mini', onclick: () => ws.journalModal(tr) }, 'Journal')),
        ),
      );
    }
    if (!br.s.trades.length) tb.append(emptyRow(13, 'Closed trades appear here. Every close is auto-screenshotted for your journal.'));
    t.append(tb);
  }
  const key = [
    ws.tab,
    br.s.positions.map((p) => p.id).join(','),
    br.s.orders.map((o) => o.id).join(','),
    br.s.trades.length,
    br.s.trades[br.s.trades.length - 1]?.id ?? '',
  ].join('|');
  patchChildren(ws.bottom, key, [h('div', { class: 'bottom-handle', title: 'Drag or swipe to resize · swipe down to hide' }, h('i', {})), tabs, body]);
  ws.applyBottom();
}

export function levelInput(ws: Workspace, id: number, kind: 'sl' | 'tp', v: number | null, dg: number) {
  const i = h('input', { class: 'lvl', type: 'number', step: Math.pow(10, -dg), value: v != null ? v.toFixed(dg) : '', placeholder: '—' });
  i.onchange = () => {
    const x = i.value === '' ? null : +i.value;
    const err = ws.replay.broker.modifyPosition(id, { [kind]: x });
    if (err) {
      toast(err, 'err');
      i.value = v != null ? v.toFixed(dg) : ''; // back to what is actually set
      i.blur();
    }
    ws.afterTrade();
  };
  return i;
}

export function journalModal(ws: Workspace, t: Trade) {
  const img = h('img', { class: 'shot', alt: 'Chart at close', hidden: true });
  if (t.shot)
    void getShot(t.shot)
      .then((u) => {
        if (u) {
          img.src = u;
          img.hidden = false;
        }
      })
      .catch(() => {});
  const tags = h('input', { value: t.tags.join(', '), placeholder: 'setup, mistake, A+ …' });
  const note = h('textarea', { rows: 4, placeholder: 'What did you see? What would you do differently?' }, t.note);
  const rating = h('select', {}, ...[0, 1, 2, 3, 4, 5].map((r) => h('option', { value: r, selected: (t.rating ?? 0) === r }, r ? '★'.repeat(r) : 'No rating')));
  const off = offsetFn(ws.tz);
  const save = h('button', { class: 'primary' }, 'Save');
  const close = modal(
    `Trade #${t.id} · ${t.symbol} ${t.side.toUpperCase()}`,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'kv-grid' },
        kv('P&L', money(t.pnl, true), cls(t.pnl)),
        kv('R', t.r != null ? num(t.r, 2, true) : '—', cls(t.r ?? 0)),
        kv('Pips', num(t.pips, 1, true)),
        kv('Entry', `${fmtLocal(t.entryTime + off(t.entryTime))}`),
        kv('Exit', `${fmtLocal(t.exitTime + off(t.exitTime))}`),
        kv('Held', fmtDuration(t.holdSec)),
        kv('MAE', `${num(t.maePips, 1)} pips${t.maeR != null ? ` (${num(t.maeR, 2)}R)` : ''}`),
        kv('MFE', `${num(t.mfePips, 1)} pips${t.mfeR != null ? ` (${num(t.mfeR, 2)}R)` : ''}`),
        kv('Exit by', t.exitReason.toUpperCase()),
      ),
      img,
      field('Tags', tags),
      field('Notes', note),
      field('Rating', rating),
      save,
    ),
    { wide: true },
  );
  save.onclick = () => {
    t.tags = tags.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    t.note = note.value;
    t.rating = +rating.value || undefined;
    ws.journalDirty.add(t.id);
    ws.scheduleSave();
    ws.renderBottom();
    close();
  };
}
