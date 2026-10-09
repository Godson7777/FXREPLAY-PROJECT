import { parseTf } from '../core/timeframe';
import { fmtLocal, fmtDuration, offsetFn, localToUtc, ZONES } from '../core/tz';
import { INDICATORS, indicatorDef } from '../core/indicators';
import type { Bars } from '../core/types';
import { newBrokerState, round2, type OrderType, type Side, type Trade } from '../engine/broker';
import { Replay, dataWindow, type ChartType, type Session } from '../engine/replay';
import { LiveFeed, applyCandle, applyTick, hlCandles, HL_MAX_CANDLES, type FeedStatus } from '../data/hyperliquid';
import { getDatasetMeta, saveDataset } from '../data/store';
import type { ChallengeState } from '../engine/rules';
import { saveSession, saveShot, getShot } from '../data/sessions';
import { ChartPane, IND_COLORS, type LineAction, type PaneHost } from './chartpane';
import { TOOL_INFO, type DragLine, type Drawing, type DrawingType } from './drawings';
import { h, money, num, cls, toast, modal, field, esc, parseDateInput, themeButton } from './dom';
import { cloudButton } from './cloudui';
import { LOGO } from './logo';

type PlayUnit = 'candle' | 'base';

interface Prefs {
  speed: number;
  unit: PlayUnit;
  autoShot: boolean;
  sizeMode: 'risk%' | 'risk$' | 'lots';
  sizeVal: number;
  slPips: number;
  tpMode: 'rr' | 'pips';
  tpVal: number;
  confirmClose: boolean;
  bottomH: number;
  bottomCollapsed: boolean;
}

const PREF_KEY = 'overflowtrade.prefs';
function loadPrefs(): Prefs {
  const def: Prefs = { speed: 2, unit: 'candle', autoShot: true, sizeMode: 'risk%', sizeVal: 1, slPips: 20, tpMode: 'rr', tpVal: 2, confirmClose: false, bottomH: 210, bottomCollapsed: false };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
  } catch {
    return def;
  }
}

export class Workspace implements PaneHost {
  replay: Replay;
  panes: ChartPane[] = [];
  active!: ChartPane;
  root: HTMLDivElement;
  private grid: HTMLDivElement;
  private right: HTMLDivElement;
  private center: HTMLDivElement;
  private bottom: HTMLDivElement;
  private clockEl: HTMLSpanElement;
  private progress: HTMLDivElement;
  private playBtn!: HTMLButtonElement;
  private toolBtns = new Map<string, HTMLButtonElement>();
  private playing = false;
  private rafId = 0;
  private lastFrame = 0;
  private acc = 0;
  private saveTimer = 0;
  private prefs = loadPrefs();
  private tab: 'positions' | 'orders' | 'history' = 'positions';
  private ticket = { type: 'market' as OrderType, price: 0, tags: '', note: '', trail: 0, be: 0, lev: 0 };
  private magnet = true;
  private stayInTool = false;
  private pendingShots: Trade[] = [];
  private challengeEvent: ChallengeState | null = null;
  private lastUi = 0;
  private menu: HTMLDivElement | null = null;
  private feed: LiveFeed | null = null;
  private liveStatus: FeedStatus = 'connecting';
  private liveEl: HTMLSpanElement | null = null;
  private liveTimer = 0;
  private liveDirty = false;
  private liveAppended = false;
  private liveSaveTimer = 0;
  private liveAgeTimer = 0;
  private lastTickMin = 0;
  private bannerEl: HTMLDivElement | null = null;

  constructor(
    public session: Session,
    data: Record<string, Bars>,
    private nav: (hash: string) => void,
  ) {
    this.replay = new Replay(session, data);
    this.replay.broker.onTradeClosed = (t) => {
      if (this.prefs.autoShot) this.pendingShots.push(t);
    };
    this.replay.onChallenge = (c) => (this.challengeEvent = c);
    this.grid = h('div', { class: 'grid' });
    this.right = h('div', { class: 'side' });
    this.bottom = h('div', { class: 'bottom' });
    this.clockEl = h('span', { class: 'clock' });
    this.progress = h('div', { class: 'progress-fill' });
    this.center = h('div', { class: 'center' }, this.grid, this.session.live ? this.liveControls() : this.controls(), this.bottom);
    this.root = h('div', { class: `ws${this.session.live ? ' is-live' : ''}` }, this.topbar(), h('div', { class: 'ws-main' }, this.toolbar(), this.center, this.right));
    this.initBottomGestures();
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('beforeunload', this.flushSave);
  }

  get tz() {
    return this.session.timezone;
  }

  mount(parent: HTMLElement) {
    parent.append(this.root);
    this.buildPanes();
    this.renderAll();
    if (this.session.live) this.startLive();
    else if (!this.replay.hasFuture()) this.showNoDataBanner();
  }

  destroy() {
    this.pause();
    this.stopLive();
    this.flushSave();
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('beforeunload', this.flushSave);
    this.panes.forEach((p) => p.destroy());
    this.root.remove();
  }

  // ---- layout -------------------------------------------------------------------

  private topbar() {
    const s = this.session;
    const layoutBtns = [1, 2, 3, 4].map((n) =>
      h('button', { class: `seg${s.state.layout === n ? ' on' : ''}`, 'data-layout': n, title: `${n} chart${n > 1 ? 's' : ''}`, onclick: () => this.setLayout(n) }, ['▣', '◫', '◫▯', '⊞'][n - 1]),
    );
    return h('header', { class: 'topbar' },
      h('a', { class: 'brand-mark', href: '#/', title: 'Overflow Trade', html: LOGO }),
      h('button', { class: 'ghost', onclick: () => this.nav('#/'), title: 'Back to sessions' }, '← Sessions'),
      h('div', { class: 'brand-sm' }, h('b', {}, s.name), h('small', {}, s.symbols.join(' · '))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'segs', title: 'Chart layout' }, ...layoutBtns),
      h('button', { class: 'ghost', onclick: () => this.indicatorsModal() }, 'ƒx Indicators'),
      h('button', { class: 'ghost', onclick: () => this.settingsModal() }, '⚙ Settings'),
      h('button', { class: 'ghost', onclick: () => this.helpModal() }, '⌨ Shortcuts'),
      cloudButton(),
      themeButton(),
      h('button', { class: 'primary', onclick: () => { this.flushSave(); this.nav(`#/analytics/${s.id}`); } }, 'Analytics & score'),
    );
  }

  private toolbar() {
    const bar = h('div', { class: 'tools' });
    for (const t of TOOL_INFO) {
      const b = h('button', { class: 'tool', title: t.title, onclick: () => this.setTool(t.type) }, t.icon);
      this.toolBtns.set(t.type, b);
      bar.append(b);
    }
    bar.append(h('div', { class: 'tool-sep' }));
    const mag = h('button', { class: 'tool on', title: 'Magnet: snap to OHLC' }, '🧲');
    mag.onclick = () => {
      this.magnet = !this.magnet;
      mag.classList.toggle('on', this.magnet);
      this.panes.forEach((p) => (p.layer.magnet = this.magnet));
    };
    const lock = h('button', { class: 'tool', title: 'Keep drawing tool active after use' }, '🔒');
    lock.onclick = () => {
      this.stayInTool = !this.stayInTool;
      lock.classList.toggle('on', this.stayInTool);
      this.panes.forEach((p) => (p.layer.stayInTool = this.stayInTool));
    };
    const clear = h('button', { class: 'tool', title: 'Remove all drawings on this symbol' }, '🗑');
    clear.onclick = () => {
      const sym = this.active.cfg.symbol;
      if (!(this.session.state.drawings[sym]?.length) || !confirm(`Remove all drawings on ${sym}?`)) return;
      this.session.state.drawings[sym] = [];
      this.drawingsChanged(sym);
    };
    bar.append(mag, lock, clear);
    this.toolBtns.get('cursor')!.classList.add('on');
    return bar;
  }

  private setTool(t: DrawingType | 'cursor') {
    for (const [k, b] of this.toolBtns) b.classList.toggle('on', k === t);
    this.panes.forEach((p) => p.layer.setTool(p === this.active ? t : 'cursor'));
  }

  private controls() {
    this.playBtn = h('button', { class: 'play', title: 'Play / pause (Space)', onclick: () => this.togglePlay() }, '▶');
    const speed = h('select', { title: 'Playback speed' },
      ...[0.5, 1, 2, 3, 5, 10, 20, 50, 100].map((v) => h('option', { value: v, selected: v === this.prefs.speed }, `${v}×/s`)));
    speed.onchange = () => {
      this.prefs.speed = +speed.value;
      this.savePrefs();
    };
    const unit = h('select', { title: 'What one playback step reveals' },
      h('option', { value: 'candle', selected: this.prefs.unit === 'candle' }, 'per candle'),
      h('option', { value: 'base', selected: this.prefs.unit === 'base' }, 'per 1m tick'),
    );
    unit.onchange = () => {
      this.prefs.unit = unit.value as PlayUnit;
      this.savePrefs();
    };
    const jumpInput = h('input', { type: 'datetime-local', class: 'jump', title: 'Jump forward to (chart timezone)' });
    const jumpBtn = h('button', { class: 'ghost', title: 'Jump forward — all orders are processed on the way' }, 'Go');
    jumpBtn.onclick = () => {
      if (!jumpInput.value) return;
      const utc = localToUtc(parseDateInput(jumpInput.value), offsetFn(this.tz));
      if (utc <= this.replay.clock) return toast('You can only move forward in time — no peeking at the past outcome.', 'err');
      this.jump(utc);
    };
    const quick = (label: string, title: string, fn: () => void) => h('button', { class: 'ghost sm', title, onclick: fn }, label);
    return h('div', { class: 'controls' },
      this.playBtn,
      h('button', { class: 'ctl', title: 'Next candle (→)', onclick: () => this.stepCandle() }, '⏭'),
      h('button', { class: 'ctl', title: 'Next 1-minute tick (Shift+→)', onclick: () => this.stepBase() }, '›'),
      speed, unit,
      h('div', { class: 'ctl-sep' }),
      quick('+1H', 'Skip 1 hour', () => this.jump(this.replay.clock + 3600)),
      quick('+4H', 'Skip 4 hours', () => this.jump(this.replay.clock + 4 * 3600)),
      quick('+1D', 'Skip 1 day', () => this.jump(this.replay.clock + 86400)),
      quick('London', 'Skip to next London open (07:00 UTC)', () => this.jump(nextUtcHour(this.replay.clock, 7))),
      quick('NY', 'Skip to next New York open (13:30 UTC)', () => this.jump(nextUtcHour(this.replay.clock, 13.5))),
      h('div', { class: 'ctl-sep' }),
      jumpInput, jumpBtn,
      h('div', { class: 'spacer' }),
      this.clockEl,
      h('div', { class: 'progress', title: 'Session progress' }, this.progress),
    );
  }

  // ---- live market (Hyperliquid) ---------------------------------------------------

  private liveControls() {
    this.liveEl = h('span', { class: 'live-badge connecting' }, '● CONNECTING');
    // progress bar is unused in live mode but renderClock writes to it
    return h('div', { class: 'controls live' },
      this.liveEl,
      h('span', { class: 'muted small' }, `Hyperliquid ${this.session.live!.coin}-PERP · real-time forward test · funding not simulated`),
      h('div', { class: 'spacer' }),
      this.clockEl,
    );
  }

  private get liveSym() {
    return this.session.symbols[0];
  }

  private setLiveStatus(st: FeedStatus) {
    this.liveStatus = st;
    this.renderLiveBadge();
  }

  private renderLiveBadge() {
    const el = this.liveEl;
    if (!el) return;
    const age = this.feed?.lastMsg ? Math.round((Date.now() - this.feed.lastMsg) / 1000) : null;
    const st = this.liveStatus;
    el.className = `live-badge ${st}`;
    el.textContent = st === 'live' ? `● LIVE${age != null && age > 5 ? ` · ${age}s since last update` : ''}` : st === 'connecting' ? '● CONNECTING' : st === 'reconnecting' ? '● RECONNECTING…' : '● OFFLINE — retrying';
  }

  private startLive() {
    const coin = this.session.live!.coin;
    this.lastTickMin = Math.floor((this.replay.clock - 1) / 60) * 60;
    this.feed = new LiveFeed(coin, {
      status: (st) => this.setLiveStatus(st),
      opened: () => void this.backfill(),
      candle: (row) => this.onLiveCandle(row),
      trade: (t, px) => this.onLiveTrade(t, px),
    });
    this.liveAgeTimer = window.setInterval(() => this.renderLiveBadge(), 1000);
    this.liveSaveTimer = window.setInterval(() => void this.saveLiveBars(), 60000);
  }

  private stopLive() {
    if (!this.feed) return;
    this.feed.close();
    this.feed = null;
    clearInterval(this.liveAgeTimer);
    clearInterval(this.liveSaveTimer);
    clearTimeout(this.liveTimer);
    void this.saveLiveBars();
  }

  /** Fill the gap since the last bar, letting every missed bar resolve orders honestly. */
  private async backfill() {
    const sym = this.liveSym;
    const b = this.replay.data[sym];
    const coin = this.session.live!.coin;
    const now = Math.floor(Date.now() / 1000);
    const from = b.n ? b.t[b.n - 1] : now - HL_MAX_CANDLES * 60;
    try {
      const rows = await hlCandles(coin, '1m', Math.max(from, now - HL_MAX_CANDLES * 60), now);
      if (!this.feed) return;
      if (rows.length && rows[0][0] > from + 60) toast(`Data gap: Hyperliquid only serves the latest ${HL_MAX_CANDLES.toLocaleString('en-US')} one-minute candles, so ${Math.round((rows[0][0] - from) / 3600)}h of history is missing. Open orders were checked against the candles available.`, 'info');
      const br = this.replay.broker;
      for (const r of rows) {
        const res = applyCandle(b, r);
        if (res === 'old') continue;
        if (res === 'append') this.liveAppended = true;
        // bars fully after the last processed tick are fed to the broker; the bar
        // holding that tick is not (its high/low may predate an open position)
        if (r[0] > this.lastTickMin) {
          br.onBar(sym, r[0], r[1], r[2], r[3], r[4]);
          this.lastTickMin = r[0];
          this.session.state.clock = Math.max(this.session.state.clock, r[0] + 1);
        }
      }
      this.replay.checkRules();
      this.liveDirty = true;
      this.scheduleLiveRender(0);
    } catch (e) {
      toast(`Could not load recent ${coin} candles: ${(e as Error).message}`, 'err');
    }
  }

  private onLiveCandle(row: number[]) {
    const res = applyCandle(this.replay.data[this.liveSym], row);
    if (res === 'old') return;
    if (res === 'append') this.liveAppended = true;
    this.scheduleLiveRender();
  }

  private onLiveTrade(t: number, px: number) {
    const sym = this.liveSym;
    const b = this.replay.data[sym];
    if (applyTick(b, t, px) === 'append') this.liveAppended = true;
    this.replay.broker.onBar(sym, t, px, px, px, px);
    this.lastTickMin = Math.max(this.lastTickMin, Math.floor(t / 60) * 60);
    this.session.state.clock = Math.max(this.session.state.clock, t + 1);
    this.replay.checkRules();
    this.liveDirty = true;
    this.scheduleLiveRender();
  }

  private scheduleLiveRender(delay = 200) {
    if (this.liveTimer) return;
    this.liveTimer = window.setTimeout(() => {
      this.liveTimer = 0;
      const sym = this.liveSym;
      const b = this.replay.data[sym];
      this.replay.cursor[sym] = Math.max(0, b.n - 1);
      for (const p of this.panes) p.liveRefresh(this.liveAppended);
      this.liveAppended = false;
      this.flushShots();
      this.renderClock();
      this.renderSide();
      this.renderBottom();
      this.handleChallenge();
      if (this.liveDirty) this.scheduleSave();
      this.liveDirty = false;
    }, delay);
  }

  private async saveLiveBars() {
    const sym = this.liveSym;
    const b = this.replay.data[sym];
    if (!b?.n) return;
    try {
      const meta = await getDatasetMeta(sym);
      if (meta) await saveDataset({ ...meta, from: b.t[0], to: b.t[b.n - 1], count: b.n }, b);
    } catch (e) {
      console.warn('live bars not saved', e);
    }
  }

  // ---- no data after the clock -------------------------------------------------------

  private showNoDataBanner() {
    this.bannerEl?.remove();
    const s = this.session;
    const off = offsetFn(this.tz);
    const fmt = (t: number) => fmtLocal(t + off(t)).slice(0, 16);
    const lastBar = this.replay.dataEnd();
    const pastEnd = s.end != null && this.replay.clock > s.end;
    const ends = s.symbols.map((sym) => { const b = this.replay.data[sym]; return b?.n ? `${sym} ends on ${fmt(b.t[b.n - 1])}` : `${sym} has no bars`; }).join(', ');
    const empty = !s.state.broker.trades.length && !s.state.broker.positions.length && !s.state.broker.orders.length;
    const win = dataWindow(s.symbols.map((sym) => { const b = this.replay.data[sym]; return { from: b?.t[0] ?? 0, to: b?.n ? b.t[b.n - 1] : 0 }; }));
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
    const body = h('div', { class: 'nodata-card' },
      h('h3', {}, pastEnd ? 'This session has reached its end date' : startedAfter ? 'Nothing to replay after the start date' : 'You reached the end of the data'),
      h('p', {}, startedAfter
        ? `This session starts on ${fmt(s.start)}, but the market data stops before that: ${ends}. Play has no future candles to reveal.`
        : pastEnd ? `The session end (${fmt(s.end!)}) has passed. Remove or move the end date in a new session to keep going.` : `The market data stops here: ${ends}. Import newer data with the same symbol name to continue.`),
      h('div', { class: 'row-btns' },
        empty && okWin && startedAfter ? restart : null,
        h('button', { class: empty && startedAfter ? 'ghost' : 'primary', onclick: () => { this.flushSave(); this.nav('#/data'); } }, 'Import newer data'),
        s.state.broker.trades.length ? h('button', { class: 'ghost', onclick: () => { this.flushSave(); this.nav(`#/analytics/${s.id}`); } }, 'See analytics') : null,
        h('button', { class: 'ghost', onclick: () => { this.bannerEl?.remove(); this.bannerEl = null; } }, 'Dismiss'),
      ),
      !empty && startedAfter ? h('p', { class: 'muted small' }, 'This session already has trades, so it can’t be restarted — create a new session inside the data range instead.') : null,
    );
    this.bannerEl = h('div', { class: 'nodata' }, body);
    this.center.append(this.bannerEl);
  }

  // ---- bottom panel (swipe / drag to resize or close) ------------------------------

  private applyBottom() {
    const c = this.prefs.bottomCollapsed;
    this.bottom.classList.toggle('collapsed', c);
    this.bottom.style.height = c ? '' : `${Math.round(this.prefs.bottomH)}px`;
    const t = this.bottom.querySelector<HTMLButtonElement>('.bottom-toggle');
    if (t) {
      t.textContent = c ? '▴' : '▾';
      t.title = c ? 'Show the panel (swipe up or `)' : 'Hide the panel (swipe down or `)';
    }
  }

  toggleBottom(open = this.prefs.bottomCollapsed) {
    this.prefs.bottomCollapsed = !open;
    this.applyBottom();
    this.savePrefs();
  }

  private initBottomGestures() {
    const el = this.bottom;
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
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
      if ((fast && dy < 0) || lastH < 90) {
        this.prefs.bottomCollapsed = true;
        if (s0.h >= 90) this.prefs.bottomH = s0.h;
      } else {
        this.prefs.bottomCollapsed = false;
        this.prefs.bottomH = fast && dy > 0 ? Math.max(lastH, this.prefs.bottomH, 210) : lastH;
      }
      this.applyBottom();
      this.savePrefs();
    };
  }

  private setLayout(n: number) {
    this.session.state.layout = n;
    this.root.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', +(b as HTMLElement).dataset.layout! === n));
    this.buildPanes();
    this.scheduleSave();
  }

  private buildPanes() {
    this.panes.forEach((p) => p.destroy());
    this.panes = [];
    const st = this.session.state;
    this.grid.className = `grid g${st.layout}`;
    for (let i = 0; i < st.layout; i++) {
      const cfg = st.panes[i];
      if (!this.session.symbols.includes(cfg.symbol)) cfg.symbol = this.session.symbols[0];
      const p = new ChartPane(this, cfg, i);
      p.layer.magnet = this.magnet;
      p.layer.stayInTool = this.stayInTool;
      p.layer.onToolDone = () => this.setTool('cursor');
      this.grid.append(p.el);
      this.panes.push(p);
    }
    this.activate(this.panes[Math.min(st.active, this.panes.length - 1)]);
  }

  activate(p: ChartPane) {
    if (this.active === p) return;
    const tool = [...this.toolBtns].find(([, b]) => b.classList.contains('on'))?.[0] ?? 'cursor';
    this.active = p;
    this.session.state.active = p.index;
    this.panes.forEach((x) => {
      x.setActive(x === p);
      x.layer.setTool(x === p ? (tool as DrawingType) : 'cursor');
    });
    this.renderSide();
  }

  paneChanged() {
    this.renderSide();
    this.scheduleSave();
  }

  onTfRequest(pane: ChartPane) {
    this.tfPrompt(pane, '');
  }

  private tfPrompt(pane: ChartPane, initial: string) {
    const fav = this.session.state.favTfs;
    const input = h('input', { type: 'text', value: initial, placeholder: 'e.g. 3m, 7m, 45m, 2H, 6H, 3D, 2W, M', class: 'tf-input' });
    const preview = h('div', { class: 'muted' }, ' ');
    const upd = () => {
      const tf = parseTf(input.value);
      preview.textContent = input.value ? (tf ? `→ ${tf.label}` : 'Not a timeframe') : 'Any timeframe works: seconds (if your data has them), minutes, hours, days, weeks, months.';
    };
    input.oninput = upd;
    upd();
    const grid = h('div', { class: 'tf-grid' },
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
      this.renderSide();
      this.scheduleSave();
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

  // ---- PaneHost ---------------------------------------------------------------

  drawings(sym: string): Drawing[] {
    return (this.session.state.drawings[sym] ??= []);
  }
  drawingsChanged(sym: string) {
    this.panes.forEach((p) => p.cfg.symbol === sym && p.layer.schedule());
    this.scheduleSave();
  }

  dragLines(sym: string): DragLine[] {
    const br = this.replay.broker;
    const out: DragLine[] = [];
    const dg = this.session.specs[sym]?.digits ?? 5;
    for (const p of br.s.positions) {
      if (p.symbol !== sym) continue;
      const valid = (price: number, kind: 'sl' | 'tp') => {
        const bid = br.bid(sym);
        const above = price > bid;
        if (p.side === 'long') return kind === 'sl' ? !above : above;
        return kind === 'sl' ? above : !above;
      };
      if (p.sl != null) out.push({ key: `s${p.id}`, price: p.sl, color: '#e0605a', label: 'SL', onDrop: (px) => this.modifyPos(p.id, { sl: +px.toFixed(dg) }, valid(px, 'sl')) });
      if (p.tp != null) out.push({ key: `t${p.id}`, price: p.tp, color: '#1a9e93', label: 'TP', onDrop: (px) => this.modifyPos(p.id, { tp: +px.toFixed(dg) }, valid(px, 'tp')) });
    }
    for (const o of br.s.orders) {
      if (o.symbol !== sym) continue;
      out.push({ key: `o${o.id}`, price: o.price, color: '#d4a24c', label: 'Entry', onDrop: (px) => { br.modifyOrder(o.id, { price: +px.toFixed(dg) }); this.afterTrade(); } });
      if (o.sl != null) out.push({ key: `os${o.id}`, price: o.sl, color: '#e0605a', label: 'SL', onDrop: (px) => { br.modifyOrder(o.id, { sl: +px.toFixed(dg) }); this.afterTrade(); } });
      if (o.tp != null) out.push({ key: `ot${o.id}`, price: o.tp, color: '#1a9e93', label: 'TP', onDrop: (px) => { br.modifyOrder(o.id, { tp: +px.toFixed(dg) }); this.afterTrade(); } });
    }
    return out;
  }

  lineAction(kind: LineAction, id: number) {
    const br = this.replay.broker;
    if (kind === 'close') {
      const p = br.s.positions.find((x) => x.id === id);
      if (!p) return;
      if (this.prefs.confirmClose && !confirm(`Close position #${id}?`)) return;
      br.close(id);
      toast(`Closed #${id} ${p.side === 'long' ? 'BUY' : 'SELL'} ${p.lots} ${p.symbol}`, 'ok');
    } else if (kind === 'cancel') br.cancelOrder(id);
    else if (kind === 'clear-sl') br.modifyPosition(id, { sl: null });
    else if (kind === 'clear-tp') br.modifyPosition(id, { tp: null });
    else if (kind === 'clear-osl') br.modifyOrder(id, { sl: null });
    else if (kind === 'clear-otp') br.modifyOrder(id, { tp: null });
    this.afterTrade();
  }

  private modifyPos(id: number, patch: { sl?: number | null; tp?: number | null }, valid = true) {
    if (!valid) return toast('That level is on the wrong side of the current price', 'err');
    this.replay.broker.modifyPosition(id, patch);
    this.afterTrade();
  }

  placeFromTool(d: Drawing, sym: string) {
    const side: Side = d.type === 'long' ? 'long' : 'short';
    const br = this.replay.broker;
    const entry = d.pts[0].p, sl = d.pts[1].p, tp = d.pts[2].p;
    const cur = side === 'long' ? br.ask(sym) : br.bid(sym);
    const type: OrderType = Math.abs(entry - cur) < (this.session.specs[sym]?.pipSize ?? 0.0001) ? 'market' : (side === 'long') === entry < cur ? 'limit' : 'stop';
    const lots = this.sizeFor(sym, Math.abs((type === 'market' ? cur : entry) - sl), type === 'market' ? cur : entry);
    const r = br.place({ symbol: sym, side, type, lots, price: entry, sl, tp });
    if (!r.ok) return toast(r.error, 'err');
    toast(`${side === 'long' ? 'Buy' : 'Sell'} ${type} ${lots} lots placed from R:R tool`, 'ok');
    this.afterTrade();
  }

  crosshairMoved(src: ChartPane, time: number | null) {
    for (const p of this.panes) if (p !== src) p.showCrosshairAt(time);
  }

  setChartType(pane: ChartPane, t: ChartType) {
    (this.session.state.chartType ??= {})[pane.index] = t;
    pane.setChartType();
    this.scheduleSave();
  }

  contextMenu(pane: ChartPane, price: number, x: number, y: number) {
    this.closeMenu();
    const sym = pane.cfg.symbol;
    const br = this.replay.broker;
    const dg = this.session.specs[sym]?.digits ?? 5;
    const px = +price.toFixed(dg);
    const buyType: OrderType = px < br.ask(sym) ? 'limit' : 'stop';
    const sellType: OrderType = px > br.bid(sym) ? 'limit' : 'stop';
    const item = (label: string, fn: () => void, cls = '') =>
      h('button', { class: `menu-item ${cls}`, onclick: () => { this.closeMenu(); fn(); } }, label);
    const m = h('div', { class: 'ctx-menu' },
      h('div', { class: 'menu-head' }, `${sym} @ ${px.toFixed(dg)}`),
      item(`Buy ${buyType} @ ${px.toFixed(dg)}`, () => this.submit('long', { type: buyType, price: px, sym }), 'up'),
      item(`Sell ${sellType} @ ${px.toFixed(dg)}`, () => this.submit('short', { type: sellType, price: px, sym }), 'dn'),
      h('div', { class: 'menu-sep' }),
      item('Market buy now', () => this.submit('long', { type: 'market', price: 0, sym })),
      item('Market sell now', () => this.submit('short', { type: 'market', price: 0, sym })),
      h('div', { class: 'menu-sep' }),
      item('Horizontal line here', () => {
        this.drawings(sym).push({ id: Math.random().toString(36).slice(2, 10), type: 'hline', pts: [{ t: pane.times[pane.times.length - 1] ?? 0, p: px }], color: '#d4a24c' });
        this.drawingsChanged(sym);
      }),
      item('Remove all drawings', () => {
        this.session.state.drawings[sym] = [];
        this.drawingsChanged(sym);
      }),
    );
    m.style.left = `${Math.min(x, innerWidth - 220)}px`;
    m.style.top = `${Math.min(y, innerHeight - 260)}px`;
    document.body.append(m);
    this.menu = m;
    setTimeout(() => document.addEventListener('pointerdown', this.onDocDown, true));
  }

  private onDocDown = (e: PointerEvent) => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
    document.removeEventListener('pointerdown', this.onDocDown, true);
  }

  // ---- replay control ------------------------------------------------------------

  private stepBase() {
    if (!this.replay.stepBase()) return this.endReached();
    this.afterStep();
  }

  private stepCandle() {
    const p = this.active;
    const sym = p.cfg.symbol;
    const a = p.agg, b = p.bars;
    const cur = this.replay.cursor[sym];
    const k = a.baseToAgg[cur];
    const lastOf = (j: number) => (j + 1 < a.n ? a.start[j + 1] - 1 : b.n - 1);
    let target = lastOf(k);
    if (cur >= target) target = k + 1 < a.n ? lastOf(k + 1) : b.n - 1;
    const moved = this.replay.advanceWhile(() => this.replay.cursor[sym] < target);
    if (!moved) return this.endReached();
    this.afterStep();
  }

  private jump(utc: number) {
    const t0 = performance.now();
    this.replay.jumpTo(utc);
    this.afterStep(true);
    if (performance.now() - t0 > 300) toast(`Jumped to ${fmtLocal(this.replay.clock + offsetFn(this.tz)(this.replay.clock))}`);
  }

  private endNotified = false;

  private endReached() {
    this.pause();
    const n = this.replay.broker.s.trades.length;
    const s = this.session;
    const off = offsetFn(this.tz);
    const last = this.replay.dataEnd();
    const why = s.end != null && this.replay.clock > s.end ? `the session end date (${fmtLocal(s.end + off(s.end)).slice(0, 16)})` : `the end of the market data (${fmtLocal(last + off(last)).slice(0, 16)})`;
    if (this.endNotified) return toast(`Nothing more to play: you are at ${why}.`, 'info');
    this.endNotified = true;
    if (!n) return this.showNoDataBanner();
    const go = h('button', { class: 'primary' }, 'See your Overflow Score');
    const stay = h('button', { class: 'ghost' }, 'Keep reviewing');
    const close = modal('End of the replay', h('div', { class: 'stack' },
      h('p', {}, `You reached ${why}. Import newer data with the same symbol name to continue this session.`),
      h('p', { class: 'muted' }, n
        ? `${n} closed trade${n === 1 ? '' : 's'}. See how the method scores: drawdowns, Sharpe, monthly consistency, market regimes, Monte Carlo and the final Overflow Score.`
        : 'No closed trades yet — the Overflow Score needs at least 10.'),
      h('div', { class: 'row-btns' }, go, stay),
    ));
    go.onclick = () => {
      close();
      this.flushSave();
      this.nav(`#/analytics/${this.session.id}`);
    };
    stay.onclick = () => close();
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.playBtn.textContent = '❚❚';
    this.playBtn.classList.add('on');
    this.lastFrame = performance.now();
    this.acc = 0;
    const frame = (now: number) => {
      if (!this.playing) return;
      this.acc += ((now - this.lastFrame) / 1000) * this.prefs.speed;
      this.lastFrame = now;
      let steps = Math.floor(this.acc);
      this.acc -= steps;
      steps = Math.min(steps, this.prefs.unit === 'base' ? 5000 : 200);
      let alive = true;
      const trades0 = this.replay.broker.s.trades.length;
      for (let i = 0; i < steps && alive; i++) {
        if (this.prefs.unit === 'base') alive = this.replay.stepBase();
        else {
          const sym = this.active.cfg.symbol;
          const before = this.replay.cursor[sym];
          this.stepCandleSilent();
          alive = this.replay.cursor[sym] !== before;
        }
      }
      if (steps) this.afterStep();
      if (!alive) return this.endReached();
      if (this.replay.broker.s.trades.length !== trades0 && this.pauseOnClose) {
        this.pause();
        toast('Paused: a trade was closed', 'info');
        return;
      }
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private pauseOnClose = true;

  private stepCandleSilent() {
    const p = this.active;
    const sym = p.cfg.symbol;
    const a = p.agg, b = p.bars;
    const cur = this.replay.cursor[sym];
    const k = a.baseToAgg[cur];
    const lastOf = (j: number) => (j + 1 < a.n ? a.start[j + 1] - 1 : b.n - 1);
    let target = lastOf(k);
    if (cur >= target) target = k + 1 < a.n ? lastOf(k + 1) : b.n - 1;
    this.replay.advanceWhile(() => this.replay.cursor[sym] < target);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.rafId);
    if (this.playBtn) {
      this.playBtn.textContent = '▶';
      this.playBtn.classList.remove('on');
    }
  }

  private afterStep(full = false) {
    for (const p of this.panes) p.sync(full);
    this.flushShots();
    this.renderClock();
    // tables/ticket are DOM-heavy: refresh at most ~6×/s while playing
    const now = performance.now();
    if (!this.playing || now - this.lastUi > 160 || this.challengeEvent) {
      this.lastUi = now;
      this.renderSide();
      this.renderBottom();
    }
    this.handleChallenge();
    this.scheduleSave();
  }

  private handleChallenge() {
    const c = this.challengeEvent;
    if (!c) return;
    this.challengeEvent = null;
    this.pause();
    for (const p of this.panes) p.refreshOverlays();
    this.renderSide();
    this.renderBottom();
    const passed = c.status === 'passed';
    const scoreBtn = h('button', { class: 'primary' }, 'See your Overflow Score');
    const closeModal = modal(passed ? 'Challenge passed' : 'Challenge failed', h('div', { class: 'stack' },
      h('p', {}, c.reason + '.'),
      h('div', { class: 'kv-grid' },
        kv('Balance', money(this.replay.broker.s.balance)),
        kv('Trading days', String(c.tradingDays.length)),
        kv('Worst daily loss', money(-c.worstDailyLoss)),
      ),
      h('p', { class: 'muted' }, passed
        ? 'You can keep replaying this session; the result is saved in analytics.'
        : this.session.rules?.stopOnBreach ? 'Positions were closed and trading is locked for this session. Duplicate it from the Sessions page to try again.' : 'Trading is still allowed (stop-on-breach is off).'),
      h('div', { class: 'row-btns' }, scoreBtn),
    ));
    scoreBtn.onclick = () => {
      closeModal();
      this.flushSave();
      this.nav(`#/analytics/${this.session.id}`);
    };
  }

  private afterTrade() {
    for (const p of this.panes) {
      p.refreshOverlays();
      p.layer.schedule();
    }
    this.flushShots();
    this.renderSide();
    this.renderBottom();
    this.scheduleSave();
  }

  private flushShots() {
    if (!this.pendingShots.length) return;
    const shots = this.pendingShots.splice(0);
    const pane = this.panes.find((p) => p.cfg.symbol === shots[shots.length - 1].symbol) ?? this.active;
    try {
      const url = pane.screenshot();
      for (const t of shots) {
        t.shot = `${this.session.id}-${t.id}`;
        void saveShot(t.shot, url);
      }
    } catch {
      /* screenshots are best-effort */
    }
  }

  // ---- sizing & orders ----------------------------------------------------------

  private sizeFor(sym: string, slDist: number, price: number): number {
    const br = this.replay.broker;
    const pr = this.prefs;
    if (pr.sizeMode === 'lots') return round2(pr.sizeVal);
    const risk = pr.sizeMode === 'risk%' ? (br.s.balance * pr.sizeVal) / 100 : pr.sizeVal;
    if (!(slDist > 0)) return 0.01;
    return br.lotsForRisk(sym, risk, slDist, price);
  }

  private ticketLevels(side: Side, o?: { type: OrderType; price: number; sym: string }) {
    const sym = o?.sym ?? this.active.cfg.symbol;
    const type = o?.type ?? this.ticket.type;
    const br = this.replay.broker;
    const pip = this.session.specs[sym]?.pipSize ?? 0.0001;
    const dir = side === 'long' ? 1 : -1;
    const entry = type === 'market' ? (side === 'long' ? br.ask(sym) : br.bid(sym)) : o?.price ?? this.ticket.price;
    const slP = this.prefs.slPips > 0 ? entry - dir * this.prefs.slPips * pip : null;
    let tpP: number | null = null;
    if (this.prefs.tpVal > 0) tpP = this.prefs.tpMode === 'rr' ? (slP != null ? entry + dir * Math.abs(entry - slP) * this.prefs.tpVal : null) : entry + dir * this.prefs.tpVal * pip;
    const lots = this.sizeFor(sym, slP != null ? Math.abs(entry - slP) : 0, entry);
    return { sym, entry, sl: slP, tp: tpP, lots, type };
  }

  /** leverage the ticket opens with (undefined on unleveraged sessions) */
  private ticketLev(sym: string) {
    const br = this.replay.broker;
    if (!br.leveraged) return undefined;
    return br.levFor(sym, this.ticket.lev || this.session.leverage);
  }

  private submit(side: Side, o?: { type: OrderType; price: number; sym: string }) {
    const lv = this.ticketLevels(side, o);
    const dg = this.session.specs[lv.sym]?.digits ?? 5;
    const r = this.replay.broker.place({
      symbol: lv.sym, side, type: lv.type, lots: lv.lots, price: lv.entry,
      sl: lv.sl != null ? +lv.sl.toFixed(dg) : null, tp: lv.tp != null ? +lv.tp.toFixed(dg) : null,
      tags: this.ticket.tags.split(',').map((x) => x.trim()).filter(Boolean), note: this.ticket.note,
      trailPips: this.ticket.trail || null, beAtR: this.ticket.be || null,
      leverage: this.ticketLev(lv.sym),
    });
    if (!r.ok) return toast(r.error, 'err');
    toast(`${side === 'long' ? 'BUY' : 'SELL'} ${lv.type} ${lv.lots} ${lv.sym}`, 'ok');
    this.afterTrade();
  }

  // ---- rendering -----------------------------------------------------------------

  private renderAll() {
    this.renderClock();
    this.renderSide();
    this.renderBottom();
  }

  private renderClock() {
    const c = this.replay.clock - 1;
    const off = offsetFn(this.tz);
    this.clockEl.textContent = `${fmtLocal(c + off(c), true)} · ${this.tz}`;
    let lo = Infinity, hi = -Infinity;
    for (const s of this.session.symbols) {
      const b = this.replay.data[s];
      if (!b) continue;
      lo = Math.min(lo, this.session.start);
      hi = Math.max(hi, this.session.end ?? b.t[b.n - 1]);
    }
    this.progress.style.width = `${Math.max(0, Math.min(100, ((c - lo) / (hi - lo)) * 100))}%`;
  }

  private renderSide() {
    if (!this.active) return;
    const br = this.replay.broker;
    const sym = this.active.cfg.symbol;
    const sp = this.session.specs[sym];
    const dg = sp?.digits ?? 5;
    const bid = br.bid(sym), ask = br.ask(sym);
    const pr = this.prefs;
    const eq = br.equity();
    const net = eq - this.session.balance;
    const trades = br.s.trades;
    const wr = trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0;
    const focused = document.activeElement as HTMLElement | null;
    const focusId = focused && this.right.contains(focused) ? focused.id : '';
    if (focusId) {
      // don't rebuild the ticket while the user is typing; refresh numbers only
      this.right.querySelectorAll<HTMLElement>('[data-live]').forEach((el) => {
        const k = el.dataset.live!;
        if (k === 'bid') el.textContent = bid.toFixed(dg);
        if (k === 'ask') el.textContent = ask.toFixed(dg);
      });
      this.renderTicketCalc();
      return;
    }
    if (this.ticket.type !== 'market' && !this.ticket.price) this.ticket.price = +bid.toFixed(dg);

    const inp = (id: string, val: number | string, onchange: (v: string) => void, attrs: Record<string, string | number> = {}) => {
      const i = h('input', { id, value: val, ...attrs });
      i.addEventListener('input', () => {
        onchange(i.value);
        this.renderTicketCalc();
      });
      i.addEventListener('change', () => this.savePrefs());
      return i;
    };
    const typeSeg = h('div', { class: 'segs full' },
      ...(['market', 'limit', 'stop'] as OrderType[]).map((t) =>
        h('button', { class: `seg${this.ticket.type === t ? ' on' : ''}`, onclick: () => { this.ticket.type = t; this.ticket.price = +bid.toFixed(dg); this.renderSide(); } }, t[0].toUpperCase() + t.slice(1))),
    );
    const sizeSel = h('select', { id: 'sizeMode' },
      h('option', { value: 'risk%', selected: pr.sizeMode === 'risk%' }, 'Risk %'),
      h('option', { value: 'risk$', selected: pr.sizeMode === 'risk$' }, 'Risk $'),
      h('option', { value: 'lots', selected: pr.sizeMode === 'lots' }, 'Lots'),
    );
    sizeSel.onchange = () => {
      pr.sizeMode = sizeSel.value as Prefs['sizeMode'];
      this.savePrefs();
      this.renderSide();
    };
    const tpSel = h('select', { id: 'tpMode' },
      h('option', { value: 'rr', selected: pr.tpMode === 'rr' }, 'TP in R'),
      h('option', { value: 'pips', selected: pr.tpMode === 'pips' }, 'TP pips'),
    );
    tpSel.onchange = () => {
      pr.tpMode = tpSel.value as Prefs['tpMode'];
      this.savePrefs();
      this.renderSide();
    };
    const favs = h('div', { class: 'favs' },
      ...this.session.state.favTfs.map((t) => h('button', { class: `chip${t === this.active.cfg.tf ? ' on' : ''}`, onclick: () => this.active.setTf(t) }, t)),
      h('button', { class: 'chip', title: 'Any timeframe…', onclick: () => this.tfPrompt(this.active, '') }, '+'),
    );

    this.right.innerHTML = '';
    this.right.append(
      h('section', { class: 'card' },
        h('div', { class: 'card-title' }, h('span', {}, `${sym}`), h('small', { class: 'muted' }, `Active chart · ${this.active.cfg.tf}`)),
        favs,
      ),
      h('section', { class: 'card ticket' },
        h('div', { class: 'quote' },
          h('button', { class: 'sell', onclick: () => this.submit('short'), title: 'Sell (Shift+S)' }, h('small', {}, 'SELL'), h('b', { 'data-live': 'bid' }, bid.toFixed(dg))),
          h('span', { class: 'spread', title: 'Spread in pips' }, num((ask - bid) / (sp?.pipSize ?? 1), 1)),
          h('button', { class: 'buy', onclick: () => this.submit('long'), title: 'Buy (Shift+B)' }, h('small', {}, 'BUY'), h('b', { 'data-live': 'ask' }, ask.toFixed(dg))),
        ),
        typeSeg,
        this.ticket.type !== 'market' ? field('Entry price', inp('tPrice', this.ticket.price, (v) => (this.ticket.price = +v), { type: 'number', step: Math.pow(10, -dg) })) : null,
        h('div', { class: 'row2' },
          field('Size', h('div', { class: 'join' }, sizeSel, inp('tSize', pr.sizeVal, (v) => (pr.sizeVal = +v), { type: 'number', step: 0.01, min: 0 }))),
          field('Stop loss (pips)', inp('tSl', pr.slPips, (v) => (pr.slPips = +v), { type: 'number', step: 0.1, min: 0 })),
        ),
        h('div', { class: 'row2' },
          field('Take profit', h('div', { class: 'join' }, tpSel, inp('tTp', pr.tpVal, (v) => (pr.tpVal = +v), { type: 'number', step: 0.1, min: 0 }))),
          field('Trail (pips)', inp('tTrail', this.ticket.trail || '', (v) => (this.ticket.trail = +v), { type: 'number', step: 0.1, min: 0, placeholder: 'off' })),
        ),
        this.replay.broker.leveraged ? field(`Leverage (max ${this.replay.broker.maxLev(sym) ?? '∞'}×, isolated)`, inp('tLev', this.ticketLev(sym)!, (v) => (this.ticket.lev = Math.max(1, +v || 1)), { type: 'number', step: 1, min: 1, ...(this.replay.broker.maxLev(sym) ? { max: this.replay.broker.maxLev(sym)! } : {}) })) : null,
        h('div', { class: 'row2' },
          field('Auto-BE at R', inp('tBe', this.ticket.be || '', (v) => (this.ticket.be = +v), { type: 'number', step: 0.1, min: 0, placeholder: 'off' })),
          field('Tags / setup', inp('tTags', this.ticket.tags, (v) => (this.ticket.tags = v), { type: 'text', placeholder: 'breakout, A+' })),
        ),
        h('div', { class: 'calc', id: 'calc' }),
      ),
      this.challengeCard() ?? '',
      h('section', { class: 'card acct' },
        h('div', { class: 'card-title' }, h('span', {}, 'Account')),
        kv('Balance', money(br.s.balance)),
        kv('Equity', money(eq)),
        kv('Floating P&L', money(eq - br.s.balance, true), cls(eq - br.s.balance)),
        kv('Open risk', money(br.openRisk())),
        br.leveraged ? kv('Used · free margin', `${money(br.usedMargin())} · ${money(br.freeMargin())}`) : null,
        kv('Net P&L', `${money(net, true)} (${num((net / this.session.balance) * 100, 2, true)}%)`, cls(net)),
        kv('Trades · Win rate', `${trades.length} · ${(wr * 100).toFixed(1)}%`),
      ),
    );
    this.renderTicketCalc();
  }

  private challengeCard() {
    const r = this.session.rules, c = this.session.state.challenge;
    if (!r || !c) return null;
    const init = this.session.balance;
    const br = this.replay.broker;
    const bar = (label: string, frac: number, text: string, kind: 'good' | 'bad') =>
      h('div', { class: 'rule' },
        h('div', { class: 'rule-top' }, h('span', {}, label), h('b', {}, text)),
        h('div', { class: `meter ${kind}` }, h('div', { style: `width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%` })));
    const profit = br.s.balance - init;
    const target = (r.profitTarget / 100) * init;
    const dailyLim = (r.maxDailyLoss / 100) * init;
    const totalLim = (r.maxTotalLoss / 100) * init;
    const eq = br.equity();
    const floor = (r.trailingDrawdown ? Math.min(c.highWater, init + totalLim) : init) - totalLim;
    const badge = c.status === 'active' ? h('span', { class: 'badge' }, 'In progress') : h('span', { class: `badge ${c.status}` }, c.status === 'passed' ? 'PASSED' : 'FAILED');
    return h('section', { class: 'card challenge' },
      h('div', { class: 'card-title' }, h('span', {}, r.name), badge),
      r.profitTarget > 0 ? bar('Profit target', target ? profit / target : 0, `${money(profit, true)} / ${money(target)}`, 'good') : null,
      r.maxDailyLoss > 0 ? bar('Daily loss used', dailyLim ? c.todayLoss / dailyLim : 0, `${money(c.todayLoss)} / ${money(dailyLim)}`, 'bad') : null,
      r.maxTotalLoss > 0 ? bar(r.trailingDrawdown ? 'Trailing loss used' : 'Max loss used', totalLim ? (totalLim - (eq - floor)) / totalLim : 0, `floor ${money(floor)}`, 'bad') : null,
      bar('Trading days', r.minTradingDays ? c.tradingDays.length / r.minTradingDays : 1, `${c.tradingDays.length} / ${r.minTradingDays}`, 'good'),
      c.status !== 'active' ? h('div', { class: 'muted small' }, c.reason) : null,
    );
  }

  private renderTicketCalc() {
    const el = this.right.querySelector('#calc');
    if (!el) return;
    const br = this.replay.broker;
    const L = this.ticketLevels('long'), S = this.ticketLevels('short');
    const sym = L.sym;
    const dg = this.session.specs[sym]?.digits ?? 5;
    const risk = L.sl != null ? br.value(sym, Math.abs(L.entry - L.sl), L.lots, L.sl) : null;
    const reward = L.tp != null ? br.value(sym, Math.abs(L.tp - L.entry), L.lots, L.tp) : null;
    el.innerHTML = `
      <div><span>Lots</span><b>${L.lots.toFixed(2)}</b></div>
      <div><span>Risk</span><b class="dn">${risk != null ? money(risk) : 'no SL'}</b></div>
      <div><span>Reward</span><b class="up">${reward != null ? money(reward) : '—'}</b></div>
      <div><span>R:R</span><b>${risk && reward ? (reward / risk).toFixed(2) : '—'}</b></div>
      <div class="lv"><span>Buy SL/TP</span><b>${L.sl?.toFixed(dg) ?? '—'} / ${L.tp?.toFixed(dg) ?? '—'}</b></div>
      <div class="lv"><span>Sell SL/TP</span><b>${S.sl?.toFixed(dg) ?? '—'} / ${S.tp?.toFixed(dg) ?? '—'}</b></div>`;
    const lev = this.ticketLev(sym);
    if (lev) {
      const margin = br.marginFor(sym, L.lots, L.entry, lev);
      el.insertAdjacentHTML('beforeend', `
      <div><span>Margin</span><b>${money(margin)}</b></div>
      <div><span>Free margin</span><b class="${br.freeMargin() < margin ? 'dn' : ''}">${money(br.freeMargin())}</b></div>
      <div class="lv"><span>Liq. buy / sell</span><b>${br.liqPrice(sym, 'long', L.entry, lev).toFixed(dg)} / ${br.liqPrice(sym, 'short', S.entry, lev).toFixed(dg)}</b></div>`);
    }
  }

  private renderBottom() {
    const br = this.replay.broker;
    const tabs = h('div', { class: 'tabs' },
      ...(['positions', 'orders', 'history'] as const).map((t) =>
        h('button', { class: `tab${this.tab === t ? ' on' : ''}`, onclick: () => { this.tab = t; if (this.prefs.bottomCollapsed) this.toggleBottom(true); this.renderBottom(); } },
          t === 'positions' ? `Positions (${br.s.positions.length})` : t === 'orders' ? `Orders (${br.s.orders.length})` : `History (${br.s.trades.length})`)),
      h('div', { class: 'spacer' }),
      br.s.positions.length ? h('button', { class: 'ghost sm', onclick: () => { br.closeAll(); this.afterTrade(); } }, 'Close all') : null,
      h('button', { class: 'ghost sm bottom-toggle', type: 'button', onclick: () => this.toggleBottom() }),
    );
    const body = h('div', { class: 'table-wrap' });
    const t = h('table', { class: 'tbl' });
    body.append(t);
    if (this.tab === 'positions') {
      const levd = br.s.positions.some((p) => p.leverage);
      t.innerHTML = `<thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Lots</th>${levd ? '<th>Lev</th><th>Margin</th><th>Liq</th>' : ''}<th>Entry</th><th>SL</th><th>TP</th><th>Pips</th><th>R</th><th>P&L</th><th>Opened</th><th></th></tr></thead>`;
      const tb = h('tbody');
      for (const p of br.s.positions) {
        const sp = this.session.specs[p.symbol];
        const dg = sp?.digits ?? 5;
        const px = p.side === 'long' ? br.bid(p.symbol) : br.ask(p.symbol);
        const pips = ((p.side === 'long' ? 1 : -1) * (px - p.entry)) / (sp?.pipSize ?? 1);
        const fl = br.floating(p);
        const rNow = p.initialSl != null ? ((p.side === 'long' ? 1 : -1) * (px - p.entry)) / Math.abs(p.entry - p.initialSl) : null;
        const off = offsetFn(this.tz);
        const tr = h('tr', {},
          h('td', {}, `${p.id}`), h('td', {}, p.symbol), h('td', { class: p.side === 'long' ? 'up' : 'dn' }, p.side.toUpperCase()), h('td', {}, p.lots.toFixed(2)),
          ...(levd ? [h('td', {}, p.leverage ? `${p.leverage}×` : '—'), h('td', {}, p.margin != null ? money(p.margin) : '—'), h('td', { class: 'warn-ink' }, p.liq != null ? p.liq.toFixed(dg) : '—')] : []),
          h('td', {}, p.entry.toFixed(dg)),
          h('td', {}, this.levelInput(p.id, 'sl', p.sl, dg)), h('td', {}, this.levelInput(p.id, 'tp', p.tp, dg)),
          h('td', { class: cls(pips) }, num(pips, 1, true)), h('td', { class: cls(rNow ?? 0) }, rNow != null ? num(rNow, 2, true) : '—'),
          h('td', { class: cls(fl) }, money(fl, true)), h('td', { class: 'muted' }, fmtLocal(p.entryTime + off(p.entryTime))),
          h('td', { class: 'acts' },
            h('button', { class: 'mini', title: 'Move SL to breakeven', onclick: () => { br.breakeven(p.id); this.afterTrade(); } }, 'BE'),
            h('button', { class: 'mini', title: 'Close half', onclick: () => { br.close(p.id, 0.5); this.afterTrade(); } }, '½'),
            h('button', { class: 'mini', title: 'Reverse position', onclick: () => { br.reverse(p.id); this.afterTrade(); } }, '⇄'),
            h('button', { class: 'mini danger', title: 'Close', onclick: () => { br.close(p.id); this.afterTrade(); } }, '✕'),
          ),
        );
        tb.append(tr);
      }
      if (!br.s.positions.length) tb.append(emptyRow(levd ? 15 : 12, 'No open positions — use the ticket on the right, Shift+B / Shift+S, or the Long/Short R:R tool.'));
      t.append(tb);
    } else if (this.tab === 'orders') {
      t.innerHTML = `<thead><tr><th>#</th><th>Symbol</th><th>Type</th><th>Side</th><th>Lots</th><th>Price</th><th>SL</th><th>TP</th><th>Placed</th><th></th></tr></thead>`;
      const tb = h('tbody');
      const off = offsetFn(this.tz);
      for (const o of br.s.orders) {
        const dg = this.session.specs[o.symbol]?.digits ?? 5;
        tb.append(h('tr', {},
          h('td', {}, `${o.id}`), h('td', {}, o.symbol), h('td', {}, o.type), h('td', { class: o.side === 'long' ? 'up' : 'dn' }, o.side.toUpperCase()), h('td', {}, o.lots.toFixed(2)),
          h('td', {}, o.price.toFixed(dg)), h('td', {}, o.sl?.toFixed(dg) ?? '—'), h('td', {}, o.tp?.toFixed(dg) ?? '—'),
          h('td', { class: 'muted' }, fmtLocal(o.createdAt + off(o.createdAt))),
          h('td', { class: 'acts' }, h('button', { class: 'mini danger', onclick: () => { br.cancelOrder(o.id); this.afterTrade(); } }, 'Cancel')),
        ));
      }
      if (!br.s.orders.length) tb.append(emptyRow(10, 'No pending orders. Drag order/SL/TP lines on the chart to adjust them.'));
      t.append(tb);
    } else {
      t.innerHTML = `<thead><tr><th>#</th><th>Symbol</th><th>Side</th><th>Lots</th><th>Entry</th><th>Exit</th><th>Pips</th><th>R</th><th>P&L</th><th>Exit by</th><th>Held</th><th>Tags</th><th></th></tr></thead>`;
      const tb = h('tbody');
      for (const tr of [...br.s.trades].reverse().slice(0, 200)) {
        const dg = this.session.specs[tr.symbol]?.digits ?? 5;
        tb.append(h('tr', {},
          h('td', {}, `${tr.id}`), h('td', {}, tr.symbol), h('td', { class: tr.side === 'long' ? 'up' : 'dn' }, tr.side.toUpperCase()), h('td', {}, tr.lots.toFixed(2)),
          h('td', {}, tr.entry.toFixed(dg)), h('td', {}, tr.exit.toFixed(dg)), h('td', { class: cls(tr.pips) }, num(tr.pips, 1, true)),
          h('td', { class: cls(tr.r ?? 0) }, tr.r != null ? num(tr.r, 2, true) : '—'), h('td', { class: cls(tr.pnl) }, money(tr.pnl, true)),
          h('td', {}, tr.exitReason.toUpperCase()), h('td', {}, fmtDuration(tr.holdSec)), h('td', { class: 'muted' }, tr.tags.join(', ')),
          h('td', { class: 'acts' }, h('button', { class: 'mini', onclick: () => this.journalModal(tr) }, 'Journal')),
        ));
      }
      if (!br.s.trades.length) tb.append(emptyRow(13, 'Closed trades appear here. Every close is auto-screenshotted for your journal.'));
      t.append(tb);
    }
    this.bottom.innerHTML = '';
    this.bottom.append(h('div', { class: 'bottom-handle', title: 'Drag or swipe to resize · swipe down to hide' }, h('i', {})), tabs, body);
    this.applyBottom();
  }

  private levelInput(id: number, kind: 'sl' | 'tp', v: number | null, dg: number) {
    const i = h('input', { class: 'lvl', type: 'number', step: Math.pow(10, -dg), value: v != null ? v.toFixed(dg) : '', placeholder: '—' });
    i.onchange = () => {
      const x = i.value === '' ? null : +i.value;
      this.replay.broker.modifyPosition(id, { [kind]: x });
      this.afterTrade();
    };
    return i;
  }

  journalModal(t: Trade) {
    const img = h('img', { class: 'shot', alt: 'Chart at close' });
    if (t.shot) void getShot(t.shot).then((u) => (u ? (img.src = u) : img.remove()));
    else img.remove();
    const tags = h('input', { value: t.tags.join(', '), placeholder: 'setup, mistake, A+ …' });
    const note = h('textarea', { rows: 4, placeholder: 'What did you see? What would you do differently?' }, t.note);
    const rating = h('select', {}, ...[0, 1, 2, 3, 4, 5].map((r) => h('option', { value: r, selected: (t.rating ?? 0) === r }, r ? '★'.repeat(r) : 'No rating')));
    const off = offsetFn(this.tz);
    const save = h('button', { class: 'primary' }, 'Save');
    const close = modal(`Trade #${t.id} · ${t.symbol} ${t.side.toUpperCase()}`, h('div', { class: 'stack' },
      h('div', { class: 'kv-grid' },
        kv('P&L', money(t.pnl, true), cls(t.pnl)), kv('R', t.r != null ? num(t.r, 2, true) : '—', cls(t.r ?? 0)), kv('Pips', num(t.pips, 1, true)),
        kv('Entry', `${fmtLocal(t.entryTime + off(t.entryTime))}`), kv('Exit', `${fmtLocal(t.exitTime + off(t.exitTime))}`), kv('Held', fmtDuration(t.holdSec)),
        kv('MAE', `${num(t.maePips, 1)} pips${t.maeR != null ? ` (${num(t.maeR, 2)}R)` : ''}`), kv('MFE', `${num(t.mfePips, 1)} pips${t.mfeR != null ? ` (${num(t.mfeR, 2)}R)` : ''}`), kv('Exit by', t.exitReason.toUpperCase()),
      ),
      img,
      field('Tags', tags), field('Notes', note), field('Rating', rating),
      save,
    ), { wide: true });
    save.onclick = () => {
      t.tags = tags.value.split(',').map((x) => x.trim()).filter(Boolean);
      t.note = note.value;
      t.rating = +rating.value || undefined;
      this.scheduleSave();
      this.renderBottom();
      close();
    };
  }

  // ---- modals ---------------------------------------------------------------------

  private indicatorsModal() {
    const pane = this.active;
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
            this.scheduleSave();
          };
          row.append(h('label', { class: 'mini-field' }, h('small', {}, k), i));
        }
        row.append(h('button', { class: 'mini danger', onclick: () => { pane.cfg.indicators = pane.cfg.indicators.filter((x) => x !== cfg); pane.rebuildIndicators(); this.scheduleSave(); render(); } }, 'Remove'));
        list.append(row);
      }
      list.append(h('div', { class: 'chips' }, ...INDICATORS.map((d) =>
        h('button', { class: 'chip', onclick: () => {
          pane.cfg.indicators.push({ id: Math.random().toString(36).slice(2, 8), type: d.type, params: { ...d.params }, color: IND_COLORS[pane.cfg.indicators.length % IND_COLORS.length] });
          pane.rebuildIndicators();
          this.scheduleSave();
          render();
        } }, `+ ${d.label}`))));
    };
    render();
    modal('Indicators', list, { wide: true });
  }

  private settingsModal() {
    const s = this.session;
    const tz = h('select', {}, ...ZONES.concat(ZONES.includes(s.timezone) ? [] : [s.timezone]).map((z) => h('option', { value: z, selected: z === s.timezone }, z)));
    const comm = h('input', { type: 'number', step: 0.01, value: s.commissionPerLot });
    const slFirst = h('input', { type: 'checkbox', checked: s.slFirst });
    const autoShot = h('input', { type: 'checkbox', checked: this.prefs.autoShot });
    const pauseClose = h('input', { type: 'checkbox', checked: this.pauseOnClose });
    const specRows = s.symbols.map((sym) => {
      const sp = s.specs[sym];
      const spread = h('input', { type: 'number', step: 0.1, value: s.spreadPips[sym] ?? s.spreadPips['*'] ?? 0, class: 'sm' });
      const pip = h('input', { type: 'number', step: 'any', value: sp.pipSize, class: 'sm' });
      const cs = h('input', { type: 'number', step: 'any', value: sp.contractSize, class: 'sm' });
      const dg = h('input', { type: 'number', step: 1, value: sp.digits, class: 'sm' });
      return { sym, spread, pip, cs, dg, row: h('tr', {}, h('td', {}, sym), h('td', {}, spread), h('td', {}, pip), h('td', {}, cs), h('td', {}, dg)) };
    });
    const tbl = h('table', { class: 'tbl' }, h('thead', { html: '<tr><th>Symbol</th><th>Spread (pips)</th><th>Pip size</th><th>Contract / lot</th><th>Digits</th></tr>' }), h('tbody', {}, ...specRows.map((r) => r.row)));
    const save = h('button', { class: 'primary' }, 'Save settings');
    const close = modal('Session settings', h('div', { class: 'stack' },
      h('div', { class: 'row2' }, field('Chart timezone', tz), field('Commission per lot per side ($)', comm)),
      h('label', { class: 'check' }, slFirst, ' If SL and TP are both touched inside one 1m bar, assume SL first (conservative)'),
      h('label', { class: 'check' }, autoShot, ' Auto-screenshot the chart when a trade closes (journal)'),
      h('label', { class: 'check' }, pauseClose, ' Pause playback when a trade closes'),
      h('h4', {}, 'Instruments'), tbl,
      save,
    ), { wide: true });
    save.onclick = () => {
      s.timezone = tz.value;
      s.commissionPerLot = +comm.value;
      s.slFirst = slFirst.checked;
      this.prefs.autoShot = autoShot.checked;
      this.pauseOnClose = pauseClose.checked;
      for (const r of specRows) {
        s.spreadPips[r.sym] = +r.spread.value;
        s.specs[r.sym] = { ...s.specs[r.sym], pipSize: +r.pip.value, contractSize: +r.cs.value, digits: +r.dg.value };
      }
      Object.assign(this.replay.broker.cfg, { commissionPerLot: s.commissionPerLot, slFirst: s.slFirst, spreadPips: s.spreadPips });
      this.savePrefs();
      this.panes.forEach((p) => p.load());
      this.afterTrade();
      close();
    };
  }

  private helpModal() {
    const rows: [string, string][] = [
      ['Space', 'Play / pause'], ['→', 'Next candle on the active chart'], ['Shift + →', 'Next 1-minute tick'],
      ['Shift + B / Shift + S', 'Market buy / sell with the ticket settings'], ['Shift + C', 'Close all positions'],
      ['Type a number / "4h" / "d"', 'Change timeframe of the active chart'], ['Alt + T/H/V/R/F/L/S/M', 'Trend, H-line, V-line, Rect, Fib, Long, Short, Measure'],
      ['Esc', 'Cursor tool / close dialog'], ['Delete / Backspace', 'Delete the selected drawing'], ['1 … 4 (with Alt)', 'Layout with 1–4 charts'],
    ];
    modal('Keyboard shortcuts', h('table', { class: 'tbl' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v))))));
  }

  // ---- keyboard ----------------------------------------------------------------------

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (document.querySelector('.modal-back')) return;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (e.altKey) {
      const code = e.code.replace('Key', '').replace('Digit', '').toLowerCase();
      const tool = TOOL_INFO.find((x) => x.key === code);
      if (tool) return (e.preventDefault(), this.setTool(tool.type));
      if (['1', '2', '3', '4'].includes(code)) return (e.preventDefault(), this.setLayout(+code));
      return;
    }
    if (k === '`') return (e.preventDefault(), this.toggleBottom());
    if (this.session.live && (k === ' ' || k === 'ArrowRight')) return (e.preventDefault(), toast('Live market: time runs in real time — nothing to skip.', 'info'));
    if (k === ' ') return (e.preventDefault(), this.togglePlay());
    if (k === 'ArrowRight') return (e.preventDefault(), e.shiftKey ? this.stepBase() : this.stepCandle());
    if (k === 'Escape') return this.setTool('cursor');
    if (k === 'Delete' || k === 'Backspace') {
      if (this.active.layer.deleteSelected()) e.preventDefault();
      return;
    }
    if (e.shiftKey && (k === 'B' || k === 'b')) return this.submit('long');
    if (e.shiftKey && (k === 'S' || k === 's')) return this.submit('short');
    if (e.shiftKey && (k === 'C' || k === 'c')) return (this.replay.broker.closeAll(), this.afterTrade());
    if (/^[0-9]$/.test(k) || (!e.shiftKey && /^[dwhm]$/i.test(k))) {
      e.preventDefault();
      this.tfPrompt(this.active, k);
    }
  };

  // ---- persistence -------------------------------------------------------------------

  private savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(this.prefs));
    } catch {
      /* private mode */
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(this.flushSave, 800);
  }

  flushSave = () => {
    clearTimeout(this.saveTimer);
    this.session.state.updatedAt = Date.now();
    void saveSession(this.session).catch((e) => toast('Could not save session: ' + e, 'err'));
  };
}

function kv(k: string, v: string, c = '') {
  return h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: c }, v));
}

function emptyRow(span: number, text: string) {
  return h('tr', {}, h('td', { colspan: span, class: 'empty', html: esc(text) }));
}

function nextUtcHour(clock: number, hour: number) {
  const day = Math.floor(clock / 86400) * 86400;
  let t = day + hour * 3600;
  while (t <= clock) t += 86400;
  const dow = new Date(t * 1000).getUTCDay();
  if (dow === 6) t += 2 * 86400;
  if (dow === 0) t += 86400;
  return t;
}

