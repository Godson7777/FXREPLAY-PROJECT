import type { Bars } from '../core/types';
import type { OrderType, Side, Trade } from '../engine/broker';
import { Replay, type ChartType, type Session } from '../engine/replay';
import type { LiveFeed, FeedStatus } from '../data/hyperliquid';
import type { ChallengeState } from '../engine/rules';
import { saveSession, saveReplaySession, savedStateOf, type SavedState } from '../data/sessions';
import { ChartPane, type CrosshairInfo, type LineAction, type PaneHost } from './chartpane';
import { TOOL_INFO, isPosTool, posLevels, type DragLine, type Drawing, type DrawingType, type Zone } from './drawings';
import type { PosEnv, PosLevels, PosSettings } from '../engine/position';
import { h, toast, themeButton } from './dom';
import { cloudButton } from './cloudui';
import { LOGO } from './logo';
import * as ticket from './workspace/ticket';
import * as tables from './workspace/tables';
import * as controls from './workspace/controls';
import * as banners from './workspace/banners';
import * as dialogs from './workspace/dialogs';
import * as live from './workspace/live';
import * as panels from './workspace/panels';
import { type Panel, PREF_KEY, loadPrefs } from './workspace/shared';

export class Workspace implements PaneHost {
  replay: Replay;
  panes: ChartPane[] = [];
  active!: ChartPane;
  root: HTMLDivElement;
  grid: HTMLDivElement;
  right: HTMLDivElement;
  center: HTMLDivElement;
  bottom: HTMLDivElement;
  clockEl: HTMLSpanElement;
  progress: HTMLDivElement;
  playBtn!: HTMLButtonElement;
  toolBtns = new Map<string, HTMLButtonElement>();
  playing = false;
  rafId = 0;
  lastFrame = 0;
  acc = 0;
  saveTimer = 0;
  lastShift = 0;
  lastRowKey = '';
  lastRowAt = 0;
  /**
   * Row buttons and double clicks. Closing or reversing a row makes the rows below slide up
   * under the cursor, so for 400 ms after such an action no row button reacts — the second
   * click of a double click would otherwise land on a different position. An action that
   * leaves the rows in place (`shifts` false) only ignores a repeat of itself.
   */
  rowAct(key: string, shifts: boolean, fn: () => void) {
    return () => {
      const now = performance.now();
      if (now - this.lastShift < 400 || (key === this.lastRowKey && now - this.lastRowAt < 400)) return;
      this.lastRowKey = key;
      this.lastRowAt = now;
      if (shifts) this.lastShift = now;
      fn();
    };
  }
  /** unsaved changes made in this tab */
  dirty = false;
  /** the stored session as this tab last read or wrote it */
  saved: SavedState = { versions: [], sig: '' };
  /** trades whose journal was edited here since the last save */
  journalDirty = new Set<number>();
  /** the stored session is newer than this tab: saving is off */
  conflict = false;
  prefs = loadPrefs();
  tab: 'positions' | 'orders' | 'history' = 'positions';
  ticket = { type: 'market' as OrderType, price: 0, tags: '', note: '', trail: 0, be: 0, lev: 0, side: 'long' as Side, link: null as string | null };
  /** the order ticket drawn on the chart as a long/short box (never saved) */
  pv: Drawing = {
    id: 'ticket-preview',
    type: 'long',
    pts: [
      { t: 0, p: 0 },
      { t: 0, p: 0 },
      { t: 0, p: 0 },
    ],
    color: '#1a9e93',
    preview: true,
  };
  pvDragging = false;
  rail!: HTMLDivElement;
  /** phone layout: trade bar + slide-up order sheet instead of the stacked ticket */
  mq = window.matchMedia('(max-width: 767px)');
  sheet!: HTMLDivElement;
  sheetBody!: HTMLDivElement;
  sheetOpen = false;
  tradeBar!: HTMLDivElement;
  onMq = () => {
    if (!this.mobile) this.closeSheet(false);
    this.renderSide();
    this.panes.forEach((p) => p.redraw());
  };
  dataInfo: CrosshairInfo | null = null;
  magnet = true;
  stayInTool = false;
  pendingShots: Trade[] = [];
  challengeEvent: ChallengeState | null = null;
  lastUi = 0;
  menu: HTMLDivElement | null = null;
  feed: LiveFeed | null = null;
  liveStatus: FeedStatus = 'connecting';
  liveEl: HTMLSpanElement | null = null;
  liveTimer = 0;
  liveDirty = false;
  liveAppended = false;
  liveSaveTimer = 0;
  liveAgeTimer = 0;
  lastTickMin = 0;
  bannerEl: HTMLDivElement | null = null;

  constructor(
    public session: Session,
    data: Record<string, Bars>,
    public nav: (hash: string) => void,
  ) {
    this.saved = savedStateOf(session);
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
    this.rail = this.buildRail();
    this.buildSheet();
    this.root = h(
      'div',
      { class: `ws${this.session.live ? ' is-live' : ''}` },
      this.topbar(),
      h('main', { class: 'ws-main' }, this.toolbar(), this.center, this.right, this.rail),
      this.tradeBar,
      this.sheet,
    );
    this.mq.addEventListener('change', this.onMq);
    this.initBottomGestures();
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('beforeunload', this.onUnload);
  }

  onUnload = () => this.flushSave(true);

  get tz() {
    return this.session.timezone;
  }

  mount(parent: HTMLElement) {
    parent.append(this.root);
    this.buildPanes();
    this.renderAll();
    // tests read the engine state directly instead of scraping the screen
    try {
      if (localStorage.getItem('overflowtrade.debug')) (window as unknown as { __ot?: Workspace }).__ot = this;
    } catch {
      /* storage unavailable */
    }
    if (this.session.live) this.startLive();
    else if (!this.replay.hasFuture()) this.showNoDataBanner();
  }

  destroy() {
    this.mq.removeEventListener('change', this.onMq);
    this.pause();
    this.stopLive();
    this.flushSave();
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('beforeunload', this.onUnload);
    this.panes.forEach((p) => p.destroy());
    this.root.remove();
  }

  // ---- layout -------------------------------------------------------------------

  topbar() {
    const s = this.session;
    const layoutBtns = [1, 2, 3, 4].map((n) =>
      h(
        'button',
        { class: `seg${s.state.layout === n ? ' on' : ''}`, 'data-layout': n, title: `${n} chart${n > 1 ? 's' : ''}`, onclick: () => this.setLayout(n) },
        ['▣', '◫', '◫▯', '⊞'][n - 1],
      ),
    );
    return h(
      'header',
      { class: 'topbar' },
      h('a', { class: 'brand-mark', href: '#/', title: 'Overflow Trade', html: LOGO }),
      h('button', { class: 'ghost', onclick: () => this.nav('#/'), title: 'Back to sessions' }, '← Sessions'),
      h('h1', { class: 'brand-sm' }, h('b', {}, s.name), h('small', {}, s.symbols.join(' · '))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'segs', title: 'Chart layout' }, ...layoutBtns),
      h('button', { class: 'ghost', onclick: () => this.indicatorsModal() }, 'ƒx Indicators'),
      h('button', { class: 'ghost', onclick: () => this.settingsModal() }, '⚙ Settings'),
      h('button', { class: 'ghost no-touch', onclick: () => this.helpModal() }, '⌨ Shortcuts'),
      cloudButton(),
      themeButton(),
      h(
        'button',
        {
          class: 'primary',
          onclick: () => {
            this.flushSave();
            this.nav(`#/analytics/${s.id}`);
          },
        },
        'Analytics & score',
      ),
    );
  }

  toolbar() {
    const bar = h('div', { class: `tools${this.prefs.toolsOpen ? '' : ' collapsed'}` });
    const tog = h('button', { class: 'tool tools-toggle', title: 'Show / hide the drawing tools', 'aria-expanded': String(this.prefs.toolsOpen) }, '✎');
    tog.onclick = () => {
      this.prefs.toolsOpen = !this.prefs.toolsOpen;
      bar.classList.toggle('collapsed', !this.prefs.toolsOpen);
      tog.setAttribute('aria-expanded', String(this.prefs.toolsOpen));
      if (!this.prefs.toolsOpen) this.setTool('cursor');
      this.savePrefs();
    };
    bar.append(tog);
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
      if (!this.session.state.drawings[sym]?.length || !confirm(`Remove all drawings on ${sym}?`)) return;
      this.session.state.drawings[sym] = [];
      this.drawingsChanged(sym);
    };
    bar.append(mag, lock, clear);
    this.toolBtns.get('cursor')!.classList.add('on');
    return bar;
  }

  setTool(t: DrawingType | 'cursor') {
    for (const [k, b] of this.toolBtns) b.classList.toggle('on', k === t);
    this.panes.forEach((p) => p.layer.setTool(p === this.active ? t : 'cursor'));
  }

  controls() {
    return controls.controls(this);
  }

  // ---- live market (Hyperliquid) ---------------------------------------------------

  liveControls() {
    return live.liveControls(this);
  }

  get liveSym() {
    return this.session.symbols[0];
  }

  setLiveStatus(st: FeedStatus) {
    return live.setLiveStatus(this, st);
  }

  renderLiveBadge() {
    return live.renderLiveBadge(this);
  }

  startLive() {
    return live.startLive(this);
  }

  /** back in the foreground or back online: reconnect at once and fill the gap */
  onWake = () => {
    if (document.hidden || !this.feed) return;
    this.feed.wake();
    void this.backfill();
  };

  stopLive() {
    return live.stopLive(this);
  }

  backfill() {
    return live.backfill(this);
  }

  onLiveCandle(row: number[]) {
    return live.onLiveCandle(this, row);
  }

  onLiveTrade(t: number, px: number) {
    return live.onLiveTrade(this, t, px);
  }

  scheduleLiveRender(delay = 200) {
    return live.scheduleLiveRender(this, delay);
  }

  saveLiveBars() {
    return live.saveLiveBars(this);
  }

  // ---- no data after the clock -------------------------------------------------------

  newerBarsButton(primary: boolean) {
    return banners.newerBarsButton(this, primary);
  }

  showNoDataBanner() {
    return banners.showNoDataBanner(this);
  }

  // ---- bottom panel (swipe / drag to resize or close) ------------------------------

  applyBottom() {
    return tables.applyBottom(this);
  }

  toggleBottom(open = this.prefs.bottomCollapsed) {
    return tables.toggleBottom(this, open);
  }

  initBottomGestures() {
    return tables.initBottomGestures(this);
  }

  setLayout(n: number) {
    this.session.state.layout = n;
    this.root.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', +(b as HTMLElement).dataset.layout! === n));
    this.buildPanes();
    this.scheduleSave();
  }

  buildPanes() {
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

  tfPrompt(pane: ChartPane, initial: string) {
    return dialogs.tfPrompt(this, pane, initial);
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
      if (p.sl != null)
        out.push({ key: `s${p.id}`, price: p.sl, color: '#e0605a', label: 'SL', onDrop: (px) => this.modifyPos(p.id, { sl: +px.toFixed(dg) }) });
      if (p.tp != null)
        out.push({ key: `t${p.id}`, price: p.tp, color: '#1a9e93', label: 'TP', onDrop: (px) => this.modifyPos(p.id, { tp: +px.toFixed(dg) }) });
    }
    for (const o of br.s.orders) {
      if (o.symbol !== sym) continue;
      const drop = (patch: { price?: number; sl?: number; tp?: number }) => {
        const err = br.modifyOrder(o.id, patch);
        if (err) toast(err, 'err');
        this.afterTrade();
      };
      out.push({ key: `o${o.id}`, price: o.price, color: '#d4a24c', label: 'Entry', onDrop: (px) => drop({ price: +px.toFixed(dg) }) });
      if (o.sl != null) out.push({ key: `os${o.id}`, price: o.sl, color: '#e0605a', label: 'SL', onDrop: (px) => drop({ sl: +px.toFixed(dg) }) });
      if (o.tp != null) out.push({ key: `ot${o.id}`, price: o.tp, color: '#1a9e93', label: 'TP', onDrop: (px) => drop({ tp: +px.toFixed(dg) }) });
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

  modifyPos(id: number, patch: { sl?: number | null; tp?: number | null }) {
    return ticket.modifyPos(this, id, patch);
  }

  setTicketSide(sd: Side) {
    return ticket.setTicketSide(this, sd);
  }

  placeFromTool(d: Drawing, sym: string) {
    return ticket.placeFromTool(this, d, sym);
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
    return dialogs.contextMenu(this, pane, price, x, y);
  }

  onDocDown = (e: PointerEvent) => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  closeMenu() {
    this.menu?.remove();
    this.menu = null;
    document.removeEventListener('pointerdown', this.onDocDown, true);
  }

  // ---- replay control ------------------------------------------------------------

  stepBase() {
    return controls.stepBase(this);
  }

  stepCandle() {
    return controls.stepCandle(this);
  }

  jump(utc: number) {
    return controls.jump(this, utc);
  }

  endNotified = false;

  endReached() {
    return banners.endReached(this);
  }

  togglePlay() {
    return controls.togglePlay(this);
  }

  play() {
    return controls.play(this);
  }

  pauseOnClose = true;
  /** the ticket and tables were already rendered in this frame */
  uiFresh = false;

  stepCandleSilent() {
    return controls.stepCandleSilent(this);
  }

  pause() {
    return controls.pause(this);
  }

  afterStep(full = false) {
    return controls.afterStep(this, full);
  }

  handleChallenge() {
    return banners.handleChallenge(this);
  }

  afterTrade() {
    return controls.afterTrade(this);
  }

  shotQueued = false;
  flushShots() {
    return controls.flushShots(this);
  }

  // ---- sizing & orders ----------------------------------------------------------

  sizeFor(sym: string, slDist: number, price: number): number {
    return ticket.sizeFor(this, sym, slDist, price);
  }

  ticketLevels(side: Side, o?: { type: OrderType; price: number; sym: string }) {
    return ticket.ticketLevels(this, side, o);
  }

  ticketLev(sym: string) {
    return ticket.ticketLev(this, sym);
  }

  submit(side: Side, o?: { type: OrderType; price: number; sym: string }) {
    return ticket.submit(this, side, o);
  }

  // ---- rendering -----------------------------------------------------------------

  renderAll() {
    this.renderClock();
    this.renderSide();
    this.renderBottom();
  }

  renderClock() {
    return controls.renderClock(this);
  }

  // ---- right rail & side panels ---------------------------------------------------

  buildRail() {
    return panels.buildRail(this);
  }

  get mobile() {
    return this.mq.matches;
  }

  /** where the order ticket renders: the slide-up sheet on phones, the side panel otherwise */
  get orderRoot(): HTMLElement {
    return this.mobile ? this.sheetBody : this.right;
  }

  buildSheet() {
    return panels.buildSheet(this);
  }

  renderTradeBar() {
    return panels.renderTradeBar(this);
  }

  lastPx: { sym: string; px: number } | null = null;
  flashPrice(sym: string, px: number) {
    return tables.flashPrice(this, sym, px);
  }

  /** highest position id already shown (rows above it get the "new" highlight) */
  seenPos = -1;
  /** trades already shown in History (rows beyond it get the highlight) */
  seenTrades = -1;
  /** trades whose result has been announced */
  announced = -1;

  announce() {
    return tables.announce(this);
  }

  openSheet() {
    return panels.openSheet(this);
  }

  closeSheet(redraw = true) {
    return panels.closeSheet(this, redraw);
  }

  previewClosed() {
    return panels.previewClosed(this);
  }

  openPanel(id: Panel, toggle = false) {
    return panels.openPanel(this, id, toggle);
  }

  renderSide() {
    return panels.renderSide(this);
  }

  panelHead(title: string, sub?: string) {
    return panels.panelHead(this, title, sub);
  }

  renderGoto() {
    return panels.renderGoto(this);
  }

  renderWatch() {
    return panels.renderWatch(this);
  }

  renderTree() {
    return panels.renderTree(this);
  }

  renderData() {
    return panels.renderData(this);
  }

  crosshairData(pane: ChartPane, info: CrosshairInfo | null) {
    return panels.crosshairData(this, pane, info);
  }

  // ---- order ticket ↔ chart preview -------------------------------------------------

  posEnv(sym: string): PosEnv {
    return ticket.posEnv(this, sym);
  }

  posDefaults(): PosSettings {
    return ticket.posDefaults(this);
  }

  zones(sym: string): Zone[] {
    const br = this.replay.broker;
    const out: Zone[] = [];
    for (const p of br.s.positions) if (p.symbol === sym && (p.sl != null || p.tp != null)) out.push({ t: p.entryTime, entry: p.entry, sl: p.sl, tp: p.tp });
    for (const o of br.s.orders) if (o.symbol === sym && (o.sl != null || o.tp != null)) out.push({ t: o.createdAt, entry: o.price, sl: o.sl, tp: o.tp });
    return out;
  }

  linked(): Drawing | null {
    return ticket.linked(this);
  }

  previewDrawings(pane: ChartPane): Drawing[] {
    const pr = this.prefs;
    const ticketShown = this.mobile ? this.sheetOpen : !pr.sideCollapsed && pr.panel === 'order';
    if (pane !== this.active || !pr.preview || !ticketShown || this.ticket.link) return [];
    if (!this.pvDragging && !this.fillPreview()) return [];
    return [this.pv];
  }

  /** Lay the ticket's levels out as the preview box, just right of the last candle. */
  fillPreview(): boolean {
    const side = this.ticket.side;
    const lv = this.ticketLevels(side);
    if (lv.sl == null || !isFinite(lv.entry)) return false;
    const pane = this.active;
    const T = pane.times;
    if (!T.length) return false;
    const tf = pane.tf.sec;
    // over the last candles, like FX Replay's order zones, so it is always on screen
    const t0 = T[Math.max(0, T.length - 14)];
    const dir = side === 'long' ? 1 : -1;
    const tp = lv.tp ?? lv.entry + dir * Math.abs(lv.entry - lv.sl) * 2;
    this.pv.type = side;
    this.pv.color = side === 'long' ? '#1a9e93' : '#e0605a';
    this.pv.text = lv.tp == null ? 'no-tp' : undefined;
    this.pv.pos = this.posDefaults();
    const t1 = T[T.length - 1] + tf * 3;
    this.pv.pts = [
      { t: t0, p: lv.entry },
      { t: t1, p: lv.sl },
      { t: t1, p: tp },
    ];
    return true;
  }

  ticketFromLevels(lv: PosLevels, sym: string) {
    return ticket.ticketFromLevels(this, lv, sym);
  }

  drawingEdited(pane: ChartPane, d: Drawing, final: boolean) {
    const sym = pane.cfg.symbol;
    // the chart swallows pointerdown, so a ticket input could keep focus and show a stale value
    const fe = document.activeElement as HTMLElement | null;
    if (fe && this.orderRoot.contains(fe)) fe.blur();
    if (d === this.pv) {
      this.pvDragging = !final;
      this.ticketFromLevels(posLevels(d), sym);
    } else if (isPosTool(d) && this.ticket.link === d.id) {
      this.ticketFromLevels(posLevels(d), sym);
    } else return;
    if (final) {
      this.savePrefs();
      this.renderSide();
    } else this.refreshTicketInputs();
  }

  drawingSelected(pane: ChartPane, d: Drawing | null) {
    if (d && isPosTool(d)) {
      this.ticket.link = d.id;
      if (d.pos) {
        this.prefs.sizeMode = d.pos.riskMode === 'pct' ? 'risk%' : d.pos.riskMode === 'usd' ? 'risk$' : 'lots';
        this.prefs.sizeVal = d.pos.risk;
      }
      this.ticketFromLevels(posLevels(d), pane.cfg.symbol);
    } else if (this.ticket.link) this.ticket.link = null;
    else return;
    this.renderSide();
    this.panes.forEach((p) => p.redraw());
  }

  syncLinked() {
    return ticket.syncLinked(this);
  }

  refreshTicketInputs() {
    return ticket.refreshTicketInputs(this);
  }

  drawingSettings(pane: ChartPane, d: Drawing) {
    return dialogs.drawingSettings(this, pane, d);
  }

  renderOrder() {
    return ticket.renderOrder(this);
  }

  challengeCard() {
    return ticket.challengeCard(this);
  }

  renderTicketCalc() {
    return ticket.renderTicketCalc(this);
  }

  renderBottom() {
    return tables.renderBottom(this);
  }

  levelInput(id: number, kind: 'sl' | 'tp', v: number | null, dg: number) {
    return tables.levelInput(this, id, kind, v, dg);
  }

  journalModal(t: Trade) {
    return tables.journalModal(this, t);
  }

  // ---- modals ---------------------------------------------------------------------

  indicatorsModal() {
    return dialogs.indicatorsModal(this);
  }

  settingsModal() {
    return dialogs.settingsModal(this);
  }

  helpModal() {
    return dialogs.helpModal(this);
  }

  // ---- keyboard ----------------------------------------------------------------------

  onKey = (e: KeyboardEvent) => {
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
    if (this.session.live && (k === ' ' || k === 'ArrowRight'))
      return (e.preventDefault(), toast('Live market: time runs in real time — nothing to skip.', 'info'));
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

  savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(this.prefs));
    } catch {
      /* private mode */
    }
  }

  scheduleSave() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 800);
  }

  /**
   * Write the session if this tab changed it. The write is refused when the stored copy
   * was played on somewhere else in the meantime (another tab, another device), so an
   * idle tab can never wipe newer trades; journal entries saved from the analytics page
   * are merged in instead of overwritten.
   */
  flushSave = (unloading = false) => {
    clearTimeout(this.saveTimer);
    if (!this.dirty || this.conflict) return;
    this.dirty = false;
    const s = this.session;
    if (unloading === true) {
      // the page is going away: one direct write is all the browser will finish
      s.state.updatedAt = Date.now();
      void saveSession(s).catch(() => {});
      return;
    }
    const dirtyJournal = new Set(this.journalDirty);
    this.journalDirty.clear();
    void saveReplaySession(s, this.saved, dirtyJournal)
      .then((res) => {
        if (res === 'saved') return;
        for (const id of dirtyJournal) this.journalDirty.add(id);
        this.showConflict(res);
      })
      .catch((e) => {
        this.dirty = true;
        for (const id of dirtyJournal) this.journalDirty.add(id);
        toast('Could not save session: ' + e, 'err');
      });
  };

  showConflict(why: 'conflict' | 'deleted') {
    return banners.showConflict(this, why);
  }
}
