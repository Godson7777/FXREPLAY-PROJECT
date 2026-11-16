import { fmtLocal, offsetFn, localToUtc } from '../../core/tz';
import { saveShot } from '../../data/sessions';
import { h, toast, parseDateInput } from '../dom';
import type { Workspace } from '../workspace';
import { type PlayUnit, nextUtcHour } from './shared';

export function controls(ws: Workspace) {
  ws.playBtn = h('button', { class: 'play', title: 'Play / pause (Space)', onclick: () => ws.togglePlay() }, '▶');
  const speed = h(
    'select',
    { title: 'Playback speed', 'aria-label': 'Playback speed' },
    ...[0.5, 1, 2, 3, 5, 10, 20, 50, 100].map((v) => h('option', { value: v, selected: v === ws.prefs.speed }, `${v}×/s`)),
  );
  speed.onchange = () => {
    ws.prefs.speed = +speed.value;
    ws.savePrefs();
  };
  const unit = h(
    'select',
    { title: 'What one playback step reveals', 'aria-label': 'What one playback step reveals' },
    h('option', { value: 'candle', selected: ws.prefs.unit === 'candle' }, 'per candle'),
    h('option', { value: 'base', selected: ws.prefs.unit === 'base' }, 'per 1m tick'),
  );
  unit.onchange = () => {
    ws.prefs.unit = unit.value as PlayUnit;
    ws.savePrefs();
  };
  const jumpInput = h('input', {
    type: 'datetime-local',
    class: 'jump',
    title: 'Jump forward to (chart timezone)',
    'aria-label': 'Jump forward to a date and time (chart timezone)',
  });
  const jumpBtn = h('button', { class: 'ghost', title: 'Jump forward — all orders are processed on the way' }, 'Go');
  jumpBtn.onclick = () => {
    if (!jumpInput.value) return;
    const utc = localToUtc(parseDateInput(jumpInput.value), offsetFn(ws.tz));
    if (utc <= ws.replay.clock) return toast('You can only move forward in time — no peeking at the past outcome.', 'err');
    ws.jump(utc);
  };
  const quick = (label: string, title: string, fn: () => void) => h('button', { class: 'ghost sm', title, onclick: fn }, label);
  return h(
    'div',
    { class: 'controls' },
    ws.playBtn,
    h('button', { class: 'ctl', title: 'Next candle (→)', onclick: () => ws.stepCandle() }, '⏭'),
    h('button', { class: 'ctl', title: 'Next 1-minute tick (Shift+→)', onclick: () => ws.stepBase() }, '›'),
    speed,
    unit,
    h('div', { class: 'ctl-sep' }),
    quick('+1H', 'Skip 1 hour', () => ws.jump(ws.replay.clock + 3600)),
    quick('+4H', 'Skip 4 hours', () => ws.jump(ws.replay.clock + 4 * 3600)),
    quick('+1D', 'Skip 1 day', () => ws.jump(ws.replay.clock + 86400)),
    quick('London', 'Skip to next London open (07:00 UTC)', () => ws.jump(nextUtcHour(ws.replay.clock, 7))),
    quick('NY', 'Skip to next New York open (13:30 UTC)', () => ws.jump(nextUtcHour(ws.replay.clock, 13.5))),
    h('div', { class: 'ctl-sep' }),
    jumpInput,
    jumpBtn,
    h('div', { class: 'spacer' }),
    ws.clockEl,
    h('div', { class: 'progress', title: 'Session progress' }, ws.progress),
  );
}

export function stepBase(ws: Workspace) {
  if (!ws.replay.stepBase()) return ws.endReached();
  ws.afterStep();
}

export function stepCandle(ws: Workspace) {
  const p = ws.active;
  const sym = p.cfg.symbol;
  const a = p.agg,
    b = p.bars;
  const cur = ws.replay.cursor[sym];
  const k = a.baseToAgg[cur];
  const lastOf = (j: number) => (j + 1 < a.n ? a.start[j + 1] - 1 : b.n - 1);
  let target = lastOf(k);
  if (cur >= target) target = k + 1 < a.n ? lastOf(k + 1) : b.n - 1;
  const moved = ws.replay.advanceWhile(() => ws.replay.cursor[sym] < target);
  if (!moved) return ws.endReached();
  ws.afterStep();
}

export function jump(ws: Workspace, utc: number) {
  const t0 = performance.now();
  ws.replay.jumpTo(utc);
  ws.afterStep(true);
  // a jump that runs out of candles says so, the same way playing to the end does
  if (!ws.replay.hasFuture()) return ws.endReached();
  if (performance.now() - t0 > 300) toast(`Jumped to ${fmtLocal(ws.replay.clock + offsetFn(ws.tz)(ws.replay.clock))}`);
}

export function togglePlay(ws: Workspace) {
  if (ws.playing) ws.pause();
  else ws.play();
}

export function play(ws: Workspace) {
  if (ws.playing) return;
  ws.playing = true;
  ws.playBtn.textContent = '❚❚';
  ws.renderTradeBar();
  ws.playBtn.classList.add('on');
  ws.lastFrame = performance.now();
  ws.acc = 0;
  const frame = (now: number) => {
    if (!ws.playing) return;
    ws.uiFresh = false;
    ws.acc += ((now - ws.lastFrame) / 1000) * ws.prefs.speed;
    ws.lastFrame = now;
    let steps = Math.floor(ws.acc);
    ws.acc -= steps;
    steps = Math.min(steps, ws.prefs.unit === 'base' ? 5000 : 200);
    let alive = true;
    const trades0 = ws.replay.broker.s.trades.length;
    for (let i = 0; i < steps && alive; i++) {
      if (ws.prefs.unit === 'base') alive = ws.replay.stepBase();
      else {
        const sym = ws.active.cfg.symbol;
        const before = ws.replay.cursor[sym];
        ws.stepCandleSilent();
        alive = ws.replay.cursor[sym] !== before;
      }
    }
    if (steps) ws.afterStep();
    if (!alive) return ws.endReached();
    if (ws.replay.broker.s.trades.length !== trades0 && ws.pauseOnClose) {
      ws.pause();
      toast('Paused — press play to continue', 'info');
      return;
    }
    ws.rafId = requestAnimationFrame(frame);
  };
  ws.rafId = requestAnimationFrame(frame);
}

export function stepCandleSilent(ws: Workspace) {
  const p = ws.active;
  const sym = p.cfg.symbol;
  const a = p.agg,
    b = p.bars;
  const cur = ws.replay.cursor[sym];
  const k = a.baseToAgg[cur];
  const lastOf = (j: number) => (j + 1 < a.n ? a.start[j + 1] - 1 : b.n - 1);
  let target = lastOf(k);
  if (cur >= target) target = k + 1 < a.n ? lastOf(k + 1) : b.n - 1;
  ws.replay.advanceWhile(() => ws.replay.cursor[sym] < target);
}

export function pause(ws: Workspace) {
  const was = ws.playing;
  ws.playing = false;
  cancelAnimationFrame(ws.rafId);
  if (ws.playBtn) {
    ws.playBtn.textContent = '▶';
    ws.renderTradeBar();
    ws.playBtn.classList.remove('on');
  }
  // while playing, the ticket and tables refresh only a few times a second; show the
  // final state now, or a trade that just closed could still be listed as open
  if (was && ws.root.isConnected && !ws.uiFresh) {
    ws.lastUi = performance.now();
    ws.renderSide();
    ws.renderBottom();
  }
  ws.uiFresh = false;
}

export function afterStep(ws: Workspace, full = false) {
  for (const p of ws.panes) p.sync(full);
  ws.flushShots();
  ws.renderClock();
  // tables/ticket are DOM-heavy: refresh at most ~6×/s while playing
  const now = performance.now();
  if (!ws.playing || now - ws.lastUi > 160 || ws.challengeEvent) {
    ws.lastUi = now;
    ws.renderSide();
    ws.renderBottom();
    ws.uiFresh = true;
  }
  ws.handleChallenge();
  ws.scheduleSave();
}

export function afterTrade(ws: Workspace) {
  for (const p of ws.panes) {
    p.refreshOverlays();
    p.layer.schedule();
  }
  ws.flushShots();
  ws.renderSide();
  ws.renderBottom();
  ws.scheduleSave();
}

/**
 * Journal screenshots for trades that just closed. Rendering a copy of the chart is the
 * slowest part of a close, so it waits until the frame that shows the close is on screen.
 */
export function flushShots(ws: Workspace) {
  if (!ws.pendingShots.length || ws.shotQueued) return;
  ws.shotQueued = true;
  requestAnimationFrame(() =>
    setTimeout(() => {
      ws.shotQueued = false;
      const shots = ws.pendingShots.splice(0);
      if (!shots.length || !ws.root.isConnected) return;
      const pane = ws.panes.find((p) => p.cfg.symbol === shots[shots.length - 1].symbol) ?? ws.active;
      // screenshots are best-effort: a failure must never get in the way of trading
      try {
        void pane
          .screenshot()
          .then((url) => {
            for (const t of shots) {
              t.shot = `${ws.session.id}-${t.id}`;
              void saveShot(t.shot, url);
            }
            ws.scheduleSave();
          })
          .catch(() => {});
      } catch {
        /* ignore */
      }
    }, 0),
  );
}

export function renderClock(ws: Workspace) {
  const c = ws.replay.clock - 1;
  const off = offsetFn(ws.tz);
  ws.clockEl.textContent = `${fmtLocal(c + off(c), true)} · ${ws.tz}`;
  let lo = Infinity,
    hi = -Infinity;
  for (const s of ws.session.symbols) {
    const b = ws.replay.data[s];
    if (!b) continue;
    lo = Math.min(lo, ws.session.start);
    hi = Math.max(hi, ws.session.end ?? b.t[b.n - 1]);
  }
  ws.progress.style.width = `${Math.max(0, Math.min(100, ((c - lo) / (hi - lo)) * 100))}%`;
}
