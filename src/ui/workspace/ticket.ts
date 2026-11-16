import { round2, type OrderType, type Side } from '../../engine/broker';
import { flipDrawing, posLevels, type Drawing } from '../drawings';
import { autoType, lotsFor, type PosEnv, type PosLevels, type PosSettings } from '../../engine/position';
import { h, patchChildren, money, num, cls, toast, field } from '../dom';
import type { Workspace } from '../workspace';
import { type Prefs, kv } from './shared';

/** Set a stop or target on a position; a level the broker refuses is explained and nothing changes. */
export function modifyPos(ws: Workspace, id: number, patch: { sl?: number | null; tp?: number | null }) {
  const err = ws.replay.broker.modifyPosition(id, patch);
  if (err) toast(err, 'err');
  ws.afterTrade();
}

/** Buy/Sell switch: flips the preview (or the linked tool) around the entry. */
export function setTicketSide(ws: Workspace, sd: Side) {
  if (ws.ticket.side === sd) return;
  ws.ticket.side = sd;
  const sym = ws.active.cfg.symbol;
  const br = ws.replay.broker;
  if (ws.ticket.type !== 'market') {
    const t = autoType(sd, ws.ticket.price, br.bid(sym), br.ask(sym), (ws.session.specs[sym]?.pipSize ?? 0.0001) / 2);
    ws.ticket.type = t === 'market' ? 'limit' : t;
  }
  const d = ws.linked();
  if (d && (d.type === 'long') !== (sd === 'long')) {
    flipDrawing(d);
    ws.drawingsChanged(sym);
  }
  ws.renderSide();
  ws.panes.forEach((p) => p.redraw());
}

export function placeFromTool(ws: Workspace, d: Drawing, sym: string) {
  const lv = posLevels(d);
  const br = ws.replay.broker;
  const dg = ws.session.specs[sym]?.digits ?? 5;
  const pip = ws.session.specs[sym]?.pipSize ?? 0.0001;
  const type = autoType(lv.side, lv.entry, br.bid(sym), br.ask(sym), pip);
  const entry = type === 'market' ? (lv.side === 'long' ? br.ask(sym) : br.bid(sym)) : lv.entry;
  const lots = lotsFor({ ...lv, entry }, d.pos ?? ws.posDefaults(), ws.posEnv(sym));
  const r = br.place({
    symbol: sym,
    side: lv.side,
    type,
    lots,
    price: +entry.toFixed(dg),
    sl: +lv.sl.toFixed(dg),
    tp: +lv.tp.toFixed(dg),
    tags: ws.ticket.tags
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    leverage: ws.ticketLev(sym),
  });
  if (!r.ok) return toast(r.error, 'err');
  toast(`${lv.side === 'long' ? 'Buy' : 'Sell'} ${type} ${lots} lots placed from the R:R tool`, 'ok');
  ws.closeSheet(false);
  ws.afterTrade();
}

export function sizeFor(ws: Workspace, sym: string, slDist: number, price: number): number {
  const br = ws.replay.broker;
  const pr = ws.prefs;
  if (pr.sizeMode === 'lots') return round2(pr.sizeVal);
  const risk = pr.sizeMode === 'risk%' ? (br.s.balance * pr.sizeVal) / 100 : pr.sizeVal;
  if (!(slDist > 0)) return 0.01;
  return br.lotsForRisk(sym, risk, slDist, price);
}

export function ticketLevels(ws: Workspace, side: Side, o?: { type: OrderType; price: number; sym: string }) {
  const sym = o?.sym ?? ws.active.cfg.symbol;
  const type = o?.type ?? ws.ticket.type;
  const br = ws.replay.broker;
  const pip = ws.session.specs[sym]?.pipSize ?? 0.0001;
  const dir = side === 'long' ? 1 : -1;
  const entry = type === 'market' ? (side === 'long' ? br.ask(sym) : br.bid(sym)) : (o?.price ?? ws.ticket.price);
  const slP = ws.prefs.slPips > 0 ? entry - dir * ws.prefs.slPips * pip : null;
  let tpP: number | null = null;
  if (ws.prefs.tpVal > 0)
    tpP = ws.prefs.tpMode === 'rr' ? (slP != null ? entry + dir * Math.abs(entry - slP) * ws.prefs.tpVal : null) : entry + dir * ws.prefs.tpVal * pip;
  const lots = ws.sizeFor(sym, slP != null ? Math.abs(entry - slP) : 0, entry);
  return { sym, entry, sl: slP, tp: tpP, lots, type };
}

/** leverage the ticket opens with (undefined on unleveraged sessions) */
export function ticketLev(ws: Workspace, sym: string) {
  const br = ws.replay.broker;
  if (!br.leveraged) return undefined;
  return br.levFor(sym, ws.ticket.lev || ws.session.leverage);
}

export function submit(ws: Workspace, side: Side, o?: { type: OrderType; price: number; sym: string }) {
  // an empty or zero size must not quietly become the 0.01-lot minimum
  if (!(ws.prefs.sizeVal > 0)) {
    const what = ws.prefs.sizeMode === 'lots' ? 'a lot size' : ws.prefs.sizeMode === 'risk%' ? 'the risk in %' : 'the risk in $';
    return toast(`Enter ${what} in the Size field first`, 'err');
  }
  if (ws.prefs.sizeMode === 'risk%' && ws.prefs.sizeVal > 100) return toast('Risk is above 100% of the account — the Size field is in %', 'err');
  if (ws.prefs.sizeMode === 'risk$' && ws.prefs.sizeVal > ws.replay.broker.s.balance) return toast('The risk in $ is larger than the account balance', 'err');
  const lv = ws.ticketLevels(side, o);
  const dg = ws.session.specs[lv.sym]?.digits ?? 5;
  const r = ws.replay.broker.place({
    symbol: lv.sym,
    side,
    type: lv.type,
    lots: lv.lots,
    price: lv.entry,
    sl: lv.sl != null ? +lv.sl.toFixed(dg) : null,
    tp: lv.tp != null ? +lv.tp.toFixed(dg) : null,
    tags: ws.ticket.tags
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    note: ws.ticket.note,
    trailPips: ws.ticket.trail > 0 ? ws.ticket.trail : null,
    beAtR: ws.ticket.be > 0 ? ws.ticket.be : null,
    leverage: ws.ticketLev(lv.sym),
  });
  if (!r.ok) return toast(r.error, 'err');
  toast(`${side === 'long' ? 'BUY' : 'SELL'} ${lv.type} ${lv.lots} ${lv.sym}`, 'ok');
  ws.closeSheet(false);
  ws.afterTrade();
}

export function posEnv(ws: Workspace, sym: string): PosEnv {
  const br = ws.replay.broker;
  return { pipSize: ws.session.specs[sym]?.pipSize ?? 0.0001, value: (d, l, p) => br.value(sym, d, l, p), balance: br.s.balance };
}

export function posDefaults(ws: Workspace): PosSettings {
  const pr = ws.prefs;
  return { riskMode: pr.sizeMode === 'risk%' ? 'pct' : pr.sizeMode === 'risk$' ? 'usd' : 'lots', risk: pr.sizeVal };
}

export function linked(ws: Workspace): Drawing | null {
  if (!ws.ticket.link) return null;
  return ws.drawings(ws.active.cfg.symbol).find((d) => d.id === ws.ticket.link) ?? null;
}

/** Copy a box's entry/SL/TP into the ticket (order type picked from the entry). */
export function ticketFromLevels(ws: Workspace, lv: PosLevels, sym: string) {
  const br = ws.replay.broker;
  const sp = ws.session.specs[sym];
  const pip = sp?.pipSize ?? 0.0001,
    dg = sp?.digits ?? 5;
  const dir = lv.side === 'long' ? 1 : -1;
  ws.ticket.side = lv.side;
  const type = autoType(lv.side, lv.entry, br.bid(sym), br.ask(sym), pip / 2);
  ws.ticket.type = type;
  if (type !== 'market') ws.ticket.price = +lv.entry.toFixed(dg);
  const entry = type === 'market' ? (lv.side === 'long' ? br.ask(sym) : br.bid(sym)) : lv.entry;
  const slD = dir * (entry - lv.sl);
  if (slD > 0) ws.prefs.slPips = Math.round((slD / pip) * 10) / 10;
  const tpD = dir * (lv.tp - entry);
  if (tpD > 0 && slD > 0) {
    if (ws.prefs.tpMode === 'rr') ws.prefs.tpVal = Math.round((tpD / slD) * 100) / 100;
    else ws.prefs.tpVal = Math.round((tpD / pip) * 10) / 10;
  }
}

/** Ticket edits move the linked long/short drawing too. */
export function syncLinked(ws: Workspace) {
  const d = ws.linked();
  if (!d) return;
  const lv = ws.ticketLevels(ws.ticket.side);
  if (lv.sl == null) return;
  if ((d.type === 'long') !== (ws.ticket.side === 'long')) flipDrawing(d);
  const dir = ws.ticket.side === 'long' ? 1 : -1;
  d.pts[0].p = lv.entry;
  d.pts[1].p = lv.sl;
  d.pts[2].p = lv.tp ?? lv.entry + dir * Math.abs(lv.entry - lv.sl) * 2;
  d.pos = ws.posDefaults();
  ws.drawingsChanged(ws.active.cfg.symbol);
}

/** Update ticket inputs in place while a box is dragged (no rebuild, keeps focus). */
export function refreshTicketInputs(ws: Workspace) {
  const set = (id: string, v: number | string) => {
    const el = ws.orderRoot.querySelector<HTMLInputElement>(`#${id}`);
    if (el && document.activeElement !== el) el.value = String(v);
  };
  set('tSl', ws.prefs.slPips);
  set('tTp', ws.prefs.tpVal);
  if (ws.ticket.type !== 'market') set('tPrice', ws.ticket.price);
  ws.orderRoot.querySelectorAll<HTMLButtonElement>('[data-otype]').forEach((b) => b.classList.toggle('on', b.dataset.otype === ws.ticket.type));
  ws.renderTicketCalc();
}

export function renderOrder(ws: Workspace) {
  const br = ws.replay.broker;
  const sym = ws.active.cfg.symbol;
  const sp = ws.session.specs[sym];
  const dg = sp?.digits ?? 5;
  const bid = br.bid(sym),
    ask = br.ask(sym);
  const pr = ws.prefs;
  const eq = br.equity();
  const net = eq - ws.session.balance;
  const trades = br.s.trades;
  const wr = trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0;
  const focused = document.activeElement as HTMLElement | null;
  const focusId = focused && ws.orderRoot.contains(focused) ? focused.id : '';
  if (focusId) {
    // don't rebuild the ticket while the user is typing; refresh numbers only
    ws.orderRoot.querySelectorAll<HTMLElement>('[data-live]').forEach((el) => {
      const k = el.dataset.live!;
      if (k === 'bid') el.textContent = bid.toFixed(dg);
      if (k === 'ask') el.textContent = ask.toFixed(dg);
    });
    ws.renderTicketCalc();
    return;
  }
  if (ws.ticket.type !== 'market' && !ws.ticket.price) ws.ticket.price = +bid.toFixed(dg);

  const inp = (id: string, val: number | string, onchange: (v: string) => void, attrs: Record<string, string | number> = {}) => {
    const i = h('input', { id, value: val, ...attrs });
    i.addEventListener('input', () => {
      onchange(i.value);
      ws.syncLinked();
      ws.renderTicketCalc();
      ws.panes.forEach((p) => p.redraw());
    });
    i.addEventListener('change', () => ws.savePrefs());
    return i;
  };
  const typeSeg = h(
    'div',
    { class: 'segs full' },
    ...(['market', 'limit', 'stop'] as OrderType[]).map((t) =>
      h(
        'button',
        {
          class: `seg${ws.ticket.type === t ? ' on' : ''}`,
          'data-otype': t,
          onclick: () => {
            ws.ticket.type = t;
            ws.ticket.price = +br.bid(sym).toFixed(dg);
            ws.syncLinked();
            ws.renderSide();
            ws.panes.forEach((p) => p.redraw());
          },
        },
        t[0].toUpperCase() + t.slice(1),
      ),
    ),
  );
  const linked = ws.linked();
  const sideSeg = h(
    'div',
    { class: 'segs full side-seg', role: 'group', 'aria-label': 'Order side' },
    ...(['long', 'short'] as Side[]).map((sd) =>
      h(
        'button',
        {
          class: `seg ${sd === 'long' ? 'buy-seg' : 'sell-seg'}${ws.ticket.side === sd ? ' on' : ''}`,
          'aria-pressed': String(ws.ticket.side === sd),
          onclick: () => ws.setTicketSide(sd),
        },
        sd === 'long' ? 'Buy / Long' : 'Sell / Short',
      ),
    ),
  );
  const pvToggle = h(
    'label',
    { class: 'check small', title: 'Draw this order on the chart as a long/short box you can drag' },
    h('input', {
      type: 'checkbox',
      checked: pr.preview,
      onchange: (e: Event) => {
        pr.preview = (e.target as HTMLInputElement).checked;
        ws.savePrefs();
        ws.panes.forEach((p) => p.redraw());
      },
    }),
    ' Show on chart',
  );
  const plv = ws.ticketLevels(ws.ticket.side);
  const placeLabel = `Place ${ws.ticket.side === 'long' ? 'BUY' : 'SELL'} ${plv.type.toUpperCase()} ${plv.lots.toFixed(2)}${plv.type === 'market' ? '' : ` @ ${plv.entry.toFixed(dg)}`}`;
  const place = h(
    'button',
    {
      class: `place-btn ${ws.ticket.side === 'long' ? 'buy' : 'sell'}`,
      id: 'placeBtn',
      onclick: () => {
        const l = ws.linked();
        if (l) ws.placeFromTool(l, sym);
        else ws.submit(ws.ticket.side);
      },
    },
    linked ? `${linked.type === 'long' ? 'Buy' : 'Sell'} from the R:R tool` : placeLabel,
  );
  const linkNote = linked
    ? h(
        'div',
        { class: 'callout small' },
        h('span', {}, `Linked to the ${linked.type} position tool — the ticket and the box move together.`),
        h(
          'button',
          {
            class: 'ghost sm',
            onclick: () => {
              ws.active.layer.selected = null;
            },
          },
          'Unlink',
        ),
      )
    : null;
  const sizeSel = h(
    'select',
    { id: 'sizeMode' },
    h('option', { value: 'risk%', selected: pr.sizeMode === 'risk%' }, 'Risk %'),
    h('option', { value: 'risk$', selected: pr.sizeMode === 'risk$' }, 'Risk $'),
    h('option', { value: 'lots', selected: pr.sizeMode === 'lots' }, 'Lots'),
  );
  sizeSel.onchange = () => {
    pr.sizeMode = sizeSel.value as Prefs['sizeMode'];
    ws.savePrefs();
    ws.renderSide();
  };
  const tpSel = h(
    'select',
    { id: 'tpMode' },
    h('option', { value: 'rr', selected: pr.tpMode === 'rr' }, 'TP in R'),
    h('option', { value: 'pips', selected: pr.tpMode === 'pips' }, 'TP pips'),
  );
  tpSel.onchange = () => {
    pr.tpMode = tpSel.value as Prefs['tpMode'];
    ws.savePrefs();
    ws.renderSide();
  };
  const favs = h(
    'div',
    { class: 'favs' },
    ...ws.session.state.favTfs.map((t) => h('button', { class: `chip${t === ws.active.cfg.tf ? ' on' : ''}`, onclick: () => ws.active.setTf(t) }, t)),
    h('button', { class: 'chip', title: 'Any timeframe…', onclick: () => ws.tfPrompt(ws.active, '') }, '+'),
  );

  // what the listeners above close over; while it is unchanged the ticket is updated in
  // place, so a tick never swallows a click, closes a dropdown or moves the caret
  const key = [
    sym,
    ws.active.cfg.tf,
    ws.ticket.type,
    ws.ticket.side,
    linked?.id ?? '',
    linked?.type ?? '',
    pr.sizeMode,
    pr.tpMode,
    ws.session.state.favTfs.join(','),
    br.leveraged ? 1 : 0,
    dg,
  ].join('|');
  const cards = [
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-title' }, h('span', {}, `${sym}`), h('small', { class: 'muted' }, `Active chart · ${ws.active.cfg.tf}`)),
      favs,
    ),
    h(
      'section',
      { class: 'card ticket' },
      h(
        'div',
        { class: 'quote' },
        h(
          'button',
          { class: 'sell', onclick: () => ws.submit('short'), title: 'Sell (Shift+S)' },
          h('small', {}, 'SELL'),
          h('b', { 'data-live': 'bid' }, bid.toFixed(dg)),
        ),
        h('span', { class: 'spread', title: 'Spread in pips' }, num((ask - bid) / (sp?.pipSize ?? 1), 1)),
        h(
          'button',
          { class: 'buy', onclick: () => ws.submit('long'), title: 'Buy (Shift+B)' },
          h('small', {}, 'BUY'),
          h('b', { 'data-live': 'ask' }, ask.toFixed(dg)),
        ),
      ),
      sideSeg,
      linkNote,
      typeSeg,
      ws.ticket.type !== 'market'
        ? field(
            'Entry price',
            inp('tPrice', ws.ticket.price, (v) => (ws.ticket.price = +v), { type: 'number', step: Math.pow(10, -dg) }),
          )
        : null,
      h(
        'div',
        { class: 'row2' },
        field(
          'Size',
          h(
            'div',
            { class: 'join' },
            sizeSel,
            inp('tSize', pr.sizeVal, (v) => (pr.sizeVal = +v), { type: 'number', step: 0.01, min: 0 }),
          ),
        ),
        field(
          'Stop loss (pips)',
          inp('tSl', pr.slPips, (v) => (pr.slPips = +v), { type: 'number', step: 0.1, min: 0 }),
        ),
      ),
      h(
        'div',
        { class: 'row2' },
        field(
          'Take profit',
          h(
            'div',
            { class: 'join' },
            tpSel,
            inp('tTp', pr.tpVal, (v) => (pr.tpVal = +v), { type: 'number', step: 0.1, min: 0 }),
          ),
        ),
        field(
          'Trail (pips)',
          inp('tTrail', ws.ticket.trail || '', (v) => (ws.ticket.trail = +v), { type: 'number', step: 0.1, min: 0, placeholder: 'off' }),
        ),
      ),
      ws.replay.broker.leveraged
        ? field(
            `Leverage (max ${ws.replay.broker.maxLev(sym) ?? '∞'}×, isolated)`,
            inp('tLev', ws.ticketLev(sym)!, (v) => (ws.ticket.lev = Math.max(1, +v || 1)), {
              type: 'number',
              step: 1,
              min: 1,
              ...(ws.replay.broker.maxLev(sym) ? { max: ws.replay.broker.maxLev(sym)! } : {}),
            }),
          )
        : null,
      h(
        'div',
        { class: 'row2' },
        field(
          'Auto-BE at R',
          inp('tBe', ws.ticket.be || '', (v) => (ws.ticket.be = +v), { type: 'number', step: 0.1, min: 0, placeholder: 'off' }),
        ),
        field(
          'Tags / setup',
          inp('tTags', ws.ticket.tags, (v) => (ws.ticket.tags = v), { type: 'text', placeholder: 'breakout, A+' }),
        ),
      ),
      h('div', { class: 'calc', id: 'calc', 'data-keep': '' }),
      place,
      pvToggle,
    ),
    ws.challengeCard(),
    h(
      'section',
      { class: 'card acct' },
      h('div', { class: 'card-title' }, h('span', {}, 'Account')),
      kv('Balance', money(br.s.balance)),
      kv('Equity', money(eq)),
      kv('Floating P&L', money(eq - br.s.balance, true), cls(eq - br.s.balance)),
      kv('Open risk', money(br.openRisk())),
      br.leveraged ? kv('Used · free margin', `${money(br.usedMargin())} · ${money(br.freeMargin())}`) : null,
      kv('Net P&L', `${money(net, true)} (${num((net / ws.session.balance) * 100, 2, true)}%)`, cls(net)),
      kv('Trades · Win rate', `${trades.length} · ${(wr * 100).toFixed(1)}%`),
    ),
  ].filter((c): c is HTMLElement => !!c);
  patchChildren(ws.orderRoot, key, cards);
  ws.renderTicketCalc();
}

export function challengeCard(ws: Workspace) {
  const r = ws.session.rules,
    c = ws.session.state.challenge;
  if (!r || !c) return null;
  const init = ws.session.balance;
  const br = ws.replay.broker;
  const bar = (label: string, frac: number, text: string, kind: 'good' | 'bad') =>
    h(
      'div',
      { class: 'rule' },
      h('div', { class: 'rule-top' }, h('span', {}, label), h('b', {}, text)),
      h('div', { class: `meter ${kind}` }, h('div', { style: `width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%` })),
    );
  const profit = br.s.balance - init;
  const target = (r.profitTarget / 100) * init;
  const dailyLim = (r.maxDailyLoss / 100) * init;
  const totalLim = (r.maxTotalLoss / 100) * init;
  const eq = br.equity();
  const floor = (r.trailingDrawdown ? Math.min(c.highWater, init + totalLim) : init) - totalLim;
  const badge =
    c.status === 'active'
      ? h('span', { class: 'badge' }, 'In progress')
      : h('span', { class: `badge ${c.status}` }, c.status === 'passed' ? 'PASSED' : 'FAILED');
  return h(
    'section',
    { class: 'card challenge' },
    h('div', { class: 'card-title' }, h('span', {}, r.name), badge),
    r.profitTarget > 0 ? bar('Profit target', target ? profit / target : 0, `${money(profit, true)} / ${money(target)}`, 'good') : null,
    r.maxDailyLoss > 0 ? bar('Daily loss used', dailyLim ? c.todayLoss / dailyLim : 0, `${money(c.todayLoss)} / ${money(dailyLim)}`, 'bad') : null,
    r.maxTotalLoss > 0
      ? bar(r.trailingDrawdown ? 'Trailing loss used' : 'Max loss used', totalLim ? (totalLim - (eq - floor)) / totalLim : 0, `floor ${money(floor)}`, 'bad')
      : null,
    bar('Trading days', r.minTradingDays ? c.tradingDays.length / r.minTradingDays : 1, `${c.tradingDays.length} / ${r.minTradingDays}`, 'good'),
    c.status !== 'active' ? h('div', { class: 'muted small' }, c.reason) : null,
  );
}

export function renderTicketCalc(ws: Workspace) {
  const el = ws.orderRoot.querySelector('#calc');
  if (!el) return;
  const br = ws.replay.broker;
  const L = ws.ticketLevels('long'),
    S = ws.ticketLevels('short');
  const sym = L.sym;
  const dg = ws.session.specs[sym]?.digits ?? 5;
  const risk = L.sl != null ? br.value(sym, Math.abs(L.entry - L.sl), L.lots, L.sl) : null;
  const reward = L.tp != null ? br.value(sym, Math.abs(L.tp - L.entry), L.lots, L.tp) : null;
  el.innerHTML = `
    <div><span>Lots</span><b>${L.lots.toFixed(2)}</b></div>
    <div><span>Risk</span><b class="dn">${risk != null ? money(risk) : 'no SL'}</b></div>
    <div><span>Reward</span><b class="up">${reward != null ? money(reward) : '—'}</b></div>
    <div><span>R:R</span><b>${risk && reward ? (reward / risk).toFixed(2) : '—'}</b></div>
    <div class="lv"><span>Buy SL/TP</span><b>${L.sl?.toFixed(dg) ?? '—'} / ${L.tp?.toFixed(dg) ?? '—'}</b></div>
    <div class="lv"><span>Sell SL/TP</span><b>${S.sl?.toFixed(dg) ?? '—'} / ${S.tp?.toFixed(dg) ?? '—'}</b></div>`;
  // the button names the order it will place; keep it in step with what is typed
  const place = ws.orderRoot.querySelector<HTMLElement>('#placeBtn');
  if (place && !ws.linked()) {
    const P = ws.ticketLevels(ws.ticket.side);
    place.textContent = `Place ${ws.ticket.side === 'long' ? 'BUY' : 'SELL'} ${P.type.toUpperCase()} ${P.lots.toFixed(2)}${P.type === 'market' ? '' : ` @ ${P.entry.toFixed(dg)}`}`;
  }
  // a pair quoted in neither USD nor with USD as base: say how its results become dollars
  const conv = br.conversion(sym);
  if (conv) {
    el.insertAdjacentHTML(
      'beforeend',
      `<div class="lv calc-note">${conv.ccy} amounts are converted at ${conv.rate.toPrecision(4)} USD per ${conv.ccy}${conv.exact ? '' : ` — an approximate rate. Add USD${conv.ccy} (or ${conv.ccy}USD) to this session for the exact one`}.</div>`,
    );
  }
  // sizing by risk has two silent traps: no stop to size from, and the 0.01-lot minimum
  const pr = ws.prefs;
  const want = pr.sizeMode === 'risk%' ? (br.s.balance * pr.sizeVal) / 100 : pr.sizeMode === 'risk$' ? pr.sizeVal : null;
  if (want != null && want > 0) {
    if (risk == null)
      el.insertAdjacentHTML(
        'beforeend',
        `<div class="lv calc-warn">No stop loss: the size cannot be worked out from the risk, so the minimum of 0.01 lots is used.</div>`,
      );
    else if (L.lots <= 0.01 && risk > want * 1.15) {
      el.insertAdjacentHTML(
        'beforeend',
        `<div class="lv calc-warn">The smallest size is 0.01 lots, so this trade risks ${money(risk)} (${((risk / br.s.balance) * 100).toFixed(2)}% of the balance) — more than the ${money(want)} you set. Tighten the stop or accept the larger risk.</div>`,
      );
    }
  }
  const lev = ws.ticketLev(sym);
  if (lev) {
    const margin = br.marginFor(sym, L.lots, L.entry, lev) + br.fee(sym, L.lots, L.entry); // what the order ties up, fee included
    el.insertAdjacentHTML(
      'beforeend',
      `
    <div><span>Margin</span><b>${money(margin)}</b></div>
    <div><span>Free margin</span><b class="${br.freeMargin() < margin ? 'dn' : ''}">${money(br.freeMargin())}</b></div>${
      br.freeMargin() < margin
        ? `
    <div class="lv calc-warn">Too large for the free margin: at ${lev}× the most you can open is ${(Math.floor(((L.lots * Math.max(0, br.freeMargin())) / margin) * 100) / 100).toFixed(2)} lots. Widen the stop, lower the risk or raise the leverage.</div>`
        : ''
    }
    <div class="lv"><span>Liq. buy / sell</span><b>${br.liqPrice(sym, 'long', L.entry, lev).toFixed(dg)} / ${br.liqPrice(sym, 'short', S.entry, lev).toFixed(dg)}</b></div>`,
    );
  }
}
