import { fmtLocal, offsetFn } from '../../core/tz';
import { newBrokerState } from '../../engine/broker';
import { dataWindow } from '../../engine/replay';
import { getDatasetMeta } from '../../data/store';
import { canRefresh, refreshDataset } from '../../data/ingest';
import { saveSession } from '../../data/sessions';
import { h, money, toast, modal } from '../dom';
import type { Workspace } from '../workspace';
import { kv } from './shared';

/**
 * "Download newer bars" for sessions whose data came from an exchange API. Hidden until
 * the dataset metas confirm a source; on success the replay reloads with the new bars.
 */
export function newerBarsButton(ws: Workspace, primary: boolean) {
  const b = h('button', { class: `${primary ? 'primary' : 'ghost'} hidden`, type: 'button' }, 'Download newer bars');
  const syms = ws.session.symbols;
  void Promise.all(syms.map((s) => getDatasetMeta(s))).then((metas) => {
    if (metas.some((m) => canRefresh(m))) b.classList.remove('hidden');
    b.onclick = async () => {
      b.disabled = true;
      let added = 0;
      try {
        for (const m of metas) {
          if (!m || !canRefresh(m)) continue;
          b.textContent = `Downloading ${m.symbol}…`;
          added += (
            await refreshDataset(m, { onProgress: (_p, n, msg) => (b.textContent = msg ?? `Downloading ${m.symbol}: ${n.toLocaleString('en-US')} bars…`) })
          ).added;
        }
      } catch (e) {
        toast((e as Error).message, 'err');
        b.disabled = false;
        b.textContent = 'Download newer bars';
        return;
      }
      if (!added) {
        toast('No newer bars yet — the data is already up to date.', 'info');
        b.disabled = false;
        b.textContent = 'Download newer bars';
        return;
      }
      toast(`+${added.toLocaleString('en-US')} bars — reloading the replay`, 'ok');
      ws.session.state.finished = false;
      ws.flushSave();
      await saveSession(ws.session);
      document.querySelectorAll('.modal-back').forEach((m) => m.remove());
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    };
  });
  return b;
}

export function showNoDataBanner(ws: Workspace) {
  ws.bannerEl?.remove();
  const s = ws.session;
  const off = offsetFn(ws.tz);
  const fmt = (t: number) => fmtLocal(t + off(t)).slice(0, 16);
  const lastBar = ws.replay.dataEnd();
  const pastEnd = s.end != null && ws.replay.clock > s.end;
  const ends = s.symbols
    .map((sym) => {
      const b = ws.replay.data[sym];
      return b?.n ? `${sym} ends on ${fmt(b.t[b.n - 1])}` : `${sym} has no bars`;
    })
    .join(', ');
  const empty = !s.state.broker.trades.length && !s.state.broker.positions.length && !s.state.broker.orders.length;
  const win = dataWindow(
    s.symbols.map((sym) => {
      const b = ws.replay.data[sym];
      return { from: b?.t[0] ?? 0, to: b?.n ? b.t[b.n - 1] : 0 };
    }),
  );
  const okWin = win.from < win.to;
  const restartAt = okWin ? win.from + Math.min(30 * 86400, Math.floor((win.to - win.from) / 4)) : 0;
  const startedAfter = s.start > lastBar;
  const restart = h('button', { class: 'primary' }, `Restart from ${okWin ? fmt(restartAt) : '—'}`);
  restart.onclick = async () => {
    s.start = restartAt;
    s.end = s.end != null && s.end <= restartAt ? null : s.end;
    s.state.clock = restartAt;
    s.state.finished = false;
    s.state.broker = newBrokerState(s.balance);
    s.state.challenge = undefined;
    s.state.updatedAt = Date.now();
    await saveSession(s);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  const body = h(
    'div',
    { class: 'nodata-card' },
    h(
      'h3',
      {},
      pastEnd ? 'This session has reached its end date' : startedAfter ? 'Nothing to replay after the start date' : 'You reached the end of the data',
    ),
    h(
      'p',
      {},
      startedAfter
        ? `This session starts on ${fmt(s.start)}, but the market data stops before that: ${ends}. Play has no future candles to reveal.`
        : pastEnd
          ? `The session end (${fmt(s.end!)}) has passed. Remove or move the end date in a new session to keep going.`
          : `The market data stops here: ${ends}. Import newer data with the same symbol name to continue.`,
    ),
    h(
      'div',
      { class: 'row-btns' },
      empty && okWin && startedAfter ? restart : null,
      pastEnd ? null : ws.newerBarsButton(!(empty && startedAfter)),
      h(
        'button',
        {
          class: 'ghost',
          onclick: () => {
            ws.flushSave();
            ws.nav('#/data');
          },
        },
        'Import newer data',
      ),
      s.state.broker.trades.length
        ? h(
            'button',
            {
              class: 'ghost',
              onclick: () => {
                ws.flushSave();
                ws.nav(`#/analytics/${s.id}`);
              },
            },
            'See analytics',
          )
        : null,
      h(
        'button',
        {
          class: 'ghost',
          onclick: () => {
            ws.bannerEl?.remove();
            ws.bannerEl = null;
          },
        },
        'Dismiss',
      ),
    ),
    !empty && startedAfter
      ? h('p', { class: 'muted small' }, 'This session already has trades, so it can’t be restarted — create a new session inside the data range instead.')
      : null,
  );
  ws.bannerEl = h('div', { class: 'nodata' }, body);
  ws.center.append(ws.bannerEl);
}

export function endReached(ws: Workspace) {
  ws.pause();
  const n = ws.replay.broker.s.trades.length;
  const s = ws.session;
  const off = offsetFn(ws.tz);
  const last = ws.replay.dataEnd();
  const why =
    s.end != null && ws.replay.clock > s.end
      ? `the session end date (${fmtLocal(s.end + off(s.end)).slice(0, 16)})`
      : `the end of the market data (${fmtLocal(last + off(last)).slice(0, 16)})`;
  if (ws.endNotified) return toast(`Nothing more to play: you are at ${why}.`, 'info');
  ws.endNotified = true;
  if (!n) return ws.showNoDataBanner();
  const go = h('button', { class: 'primary' }, 'See your Overflow Score');
  const stay = h('button', { class: 'ghost' }, 'Keep reviewing');
  const close = modal(
    'End of the replay',
    h(
      'div',
      { class: 'stack' },
      h('p', {}, `You reached ${why}. Import newer data with the same symbol name to continue this session.`),
      h(
        'p',
        { class: 'muted' },
        n
          ? `${n} closed trade${n === 1 ? '' : 's'}. See how the method scores: drawdowns, Sharpe, monthly consistency, market regimes, Monte Carlo and the final Overflow Score.`
          : 'No closed trades yet — the Overflow Score needs at least 10.',
      ),
      h('div', { class: 'row-btns' }, go, s.end != null && ws.replay.clock > s.end ? null : ws.newerBarsButton(false), stay),
    ),
  );
  go.onclick = () => {
    close();
    ws.flushSave();
    ws.nav(`#/analytics/${ws.session.id}`);
  };
  stay.onclick = () => close();
}

export function handleChallenge(ws: Workspace) {
  const c = ws.challengeEvent;
  if (!c) return;
  ws.challengeEvent = null;
  ws.pause();
  for (const p of ws.panes) p.refreshOverlays();
  ws.renderSide();
  ws.renderBottom();
  const passed = c.status === 'passed';
  const scoreBtn = h('button', { class: 'primary' }, 'See your Overflow Score');
  const closeModal = modal(
    passed ? 'Challenge passed' : 'Challenge failed',
    h(
      'div',
      { class: 'stack' },
      h('p', {}, c.reason + '.'),
      h(
        'div',
        { class: 'kv-grid' },
        kv('Balance', money(ws.replay.broker.s.balance)),
        kv('Trading days', String(c.tradingDays.length)),
        kv('Worst daily loss', money(-c.worstDailyLoss)),
      ),
      h(
        'p',
        { class: 'muted' },
        passed
          ? 'You can keep replaying this session; the result is saved in analytics.'
          : ws.session.rules?.stopOnBreach
            ? 'Positions were closed and trading is locked for this session. Duplicate it from the Sessions page to try again.'
            : 'Trading is still allowed (stop-on-breach is off).',
      ),
      h('div', { class: 'row-btns' }, scoreBtn),
    ),
  );
  scoreBtn.onclick = () => {
    closeModal();
    ws.flushSave();
    ws.nav(`#/analytics/${ws.session.id}`);
  };
}

/** The stored session moved on without this tab: stop, say so, and never overwrite it. */
export function showConflict(ws: Workspace, why: 'conflict' | 'deleted') {
  if (ws.conflict) return;
  ws.conflict = true;
  ws.pause();
  ws.bannerEl?.remove();
  const reload = h('button', { class: 'primary' }, why === 'deleted' ? 'Back to sessions' : 'Reload this tab');
  reload.onclick = () => (why === 'deleted' ? ws.nav('#/') : location.reload());
  ws.bannerEl = h(
    'div',
    { class: 'nodata' },
    h(
      'div',
      { class: 'nodata-card conflict-card' },
      h('h3', {}, why === 'deleted' ? 'This session was deleted' : 'This session was continued somewhere else'),
      h(
        'p',
        {},
        why === 'deleted'
          ? 'It was removed in another tab or on another device, so nothing more is saved from here.'
          : 'It is open in another tab or was synced from another device, and that copy is newer. To protect it, this tab has stopped saving — reload to pick up the latest state.',
      ),
      h('div', { class: 'row-btns' }, reload),
    ),
  );
  ws.center.append(ws.bannerEl);
}
