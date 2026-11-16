import { LiveFeed, applyCandle, applyTick, hlCandles, HL_MAX_CANDLES, type FeedStatus } from '../../data/hyperliquid';
import { getDatasetMeta, saveDataset } from '../../data/store';
import { h, toast } from '../dom';
import type { Workspace } from '../workspace';

export function liveControls(ws: Workspace) {
  ws.liveEl = h('span', { class: 'live-badge connecting' }, '● CONNECTING');
  // progress bar is unused in live mode but renderClock writes to it
  return h(
    'div',
    { class: 'controls live' },
    ws.liveEl,
    h('span', { class: 'muted small' }, `Hyperliquid ${ws.session.live!.coin}-PERP · real-time forward test · funding not simulated`),
    h('div', { class: 'spacer' }),
    ws.clockEl,
  );
}

export function setLiveStatus(ws: Workspace, st: FeedStatus) {
  ws.liveStatus = st;
  ws.renderLiveBadge();
}

export function renderLiveBadge(ws: Workspace) {
  const el = ws.liveEl;
  if (!el) return;
  const age = ws.feed?.lastData ? Math.round((Date.now() - ws.feed.lastData) / 1000) : null;
  const st = ws.liveStatus;
  el.className = `live-badge ${st}`;
  el.title =
    st === 'polling'
      ? 'The streaming connection is unavailable on this network, so prices are fetched every 3 seconds. Stops and targets are checked on each update.'
      : '';
  el.textContent =
    st === 'polling'
      ? `● LIVE · updates every 3 s${age != null && age > 10 ? ` · ${age}s since last update` : ''}`
      : st === 'live'
        ? `● LIVE${age != null && age > 90 ? ' · no trades for a while (quiet or closed market)' : age != null && age > 5 ? ` · ${age}s since last update` : ''}`
        : st === 'connecting'
          ? '● CONNECTING'
          : st === 'reconnecting'
            ? '● RECONNECTING…'
            : '● OFFLINE — retrying';
}

export function startLive(ws: Workspace) {
  const coin = ws.session.live!.coin;
  ws.lastTickMin = Math.floor((ws.replay.clock - 1) / 60) * 60;
  ws.feed = new LiveFeed(coin, {
    status: (st) => ws.setLiveStatus(st),
    opened: () => void ws.backfill(),
    candle: (row) => ws.onLiveCandle(row),
    trade: (t, px) => ws.onLiveTrade(t, px),
  });
  ws.liveAgeTimer = window.setInterval(() => ws.renderLiveBadge(), 1000);
  document.addEventListener('visibilitychange', ws.onWake);
  window.addEventListener('online', ws.onWake);
  ws.liveSaveTimer = window.setInterval(() => void ws.saveLiveBars(), 60000);
}

export function stopLive(ws: Workspace) {
  document.removeEventListener('visibilitychange', ws.onWake);
  window.removeEventListener('online', ws.onWake);
  if (!ws.feed) return;
  ws.feed.close();
  ws.feed = null;
  clearInterval(ws.liveAgeTimer);
  clearInterval(ws.liveSaveTimer);
  clearTimeout(ws.liveTimer);
  void ws.saveLiveBars();
}

/** Fill the gap since the last bar, letting every missed bar resolve orders honestly. */
export async function backfill(ws: Workspace) {
  const sym = ws.liveSym;
  const b = ws.replay.data[sym];
  const coin = ws.session.live!.coin;
  const now = Math.floor(Date.now() / 1000);
  const from = b.n ? b.t[b.n - 1] : now - HL_MAX_CANDLES * 60;
  try {
    const rows = await hlCandles(coin, '1m', Math.max(from, now - HL_MAX_CANDLES * 60), now);
    if (!ws.feed) return;
    if (rows.length && rows[0][0] > from + 60)
      toast(
        `Data gap: Hyperliquid only serves the latest ${HL_MAX_CANDLES.toLocaleString('en-US')} one-minute candles, so ${Math.round((rows[0][0] - from) / 3600)}h of history is missing. Open orders were checked against the candles available.`,
        'info',
      );
    const br = ws.replay.broker;
    for (const r of rows) {
      const res = applyCandle(b, r);
      if (res === 'old') continue;
      if (res === 'append') ws.liveAppended = true;
      // bars fully after the last processed tick are fed to the broker; the bar
      // holding that tick is not (its high/low may predate an open position)
      if (r[0] > ws.lastTickMin) {
        br.onBar(sym, r[0], r[1], r[2], r[3], r[4]);
        ws.lastTickMin = r[0];
        ws.session.state.clock = Math.max(ws.session.state.clock, r[0] + 1);
      }
    }
    ws.replay.checkRules();
    ws.liveDirty = true;
    ws.scheduleLiveRender(0);
  } catch (e) {
    toast(`Could not load recent ${coin} candles: ${(e as Error).message}`, 'err');
  }
}

export function onLiveCandle(ws: Workspace, row: number[]) {
  const res = applyCandle(ws.replay.data[ws.liveSym], row);
  if (res === 'old') return;
  if (res === 'append') ws.liveAppended = true;
  ws.scheduleLiveRender();
}

export function onLiveTrade(ws: Workspace, t: number, px: number) {
  const sym = ws.liveSym;
  const b = ws.replay.data[sym];
  if (applyTick(b, t, px) === 'append') ws.liveAppended = true;
  ws.replay.broker.onBar(sym, t, px, px, px, px);
  ws.lastTickMin = Math.max(ws.lastTickMin, Math.floor(t / 60) * 60);
  ws.session.state.clock = Math.max(ws.session.state.clock, t + 1);
  ws.replay.checkRules();
  ws.liveDirty = true;
  ws.scheduleLiveRender();
}

export function scheduleLiveRender(ws: Workspace, delay = 200) {
  if (ws.liveTimer) return;
  ws.liveTimer = window.setTimeout(() => {
    ws.liveTimer = 0;
    const sym = ws.liveSym;
    const b = ws.replay.data[sym];
    ws.replay.cursor[sym] = Math.max(0, b.n - 1);
    for (const p of ws.panes) p.liveRefresh(ws.liveAppended);
    ws.liveAppended = false;
    ws.flushShots();
    ws.renderClock();
    ws.renderSide();
    ws.renderBottom();
    ws.handleChallenge();
    if (ws.liveDirty) ws.scheduleSave();
    ws.liveDirty = false;
  }, delay);
}

export async function saveLiveBars(ws: Workspace) {
  const sym = ws.liveSym;
  const b = ws.replay.data[sym];
  if (!b?.n) return;
  try {
    const meta = await getDatasetMeta(sym);
    if (meta) await saveDataset({ ...meta, from: b.t[0], to: b.t[b.n - 1], count: b.n }, b);
  } catch (e) {
    console.warn('live bars not saved', e);
  }
}
