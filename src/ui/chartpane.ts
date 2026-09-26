import {
  AreaSeries, BarSeries, CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { aggregate, parseTf, partialCandle, type Agg, type Timeframe } from '../core/timeframe';
import { indexAtOrBefore, type Bars } from '../core/types';
import { offsetFn, fmtLocal } from '../core/tz';
import { indicatorDef, type Series } from '../core/indicators';
import type { ChartType, PaneConfig, Replay } from '../engine/replay';
import { DrawingLayer, type DragLine, type Drawing } from './drawings';
import { h, money, theme } from './dom';

const MAX_DISPLAY = 60000;
const IND_WINDOW = 3000;
const aggCache = new Map<string, Agg>();

export function getAgg(sym: string, b: Bars, tf: Timeframe, tz: string): Agg {
  const key = `${sym}|${b.n}|${b.t[0]}|${tf.label}|${tz}`;
  let a = aggCache.get(key);
  if (!a) {
    if (aggCache.size > 24) aggCache.delete(aggCache.keys().next().value!);
    a = aggregate(b, tf, offsetFn(tz));
    aggCache.set(key, a);
  }
  return a;
}

export const IND_COLORS = ['#f0b90b', '#3987e5', '#e87ba4', '#1baf7a', '#9085e9', '#eb6834'];

export interface PaneHost {
  replay: Replay;
  tz: string;
  drawings(sym: string): Drawing[];
  drawingsChanged(sym: string): void;
  activate(pane: ChartPane): void;
  dragLines(sym: string): DragLine[];
  placeFromTool(d: Drawing, sym: string): void;
  paneChanged(): void;
  onTfRequest(pane: ChartPane): void;
  crosshairMoved(pane: ChartPane, time: number | null): void;
  contextMenu(pane: ChartPane, price: number, x: number, y: number): void;
  setChartType(pane: ChartPane, t: ChartType): void;
}

export const CHART_TYPES: { type: ChartType; label: string }[] = [
  { type: 'candles', label: 'Candles' },
  { type: 'hollow', label: 'Hollow candles' },
  { type: 'heikin', label: 'Heikin Ashi' },
  { type: 'bars', label: 'OHLC bars' },
  { type: 'line', label: 'Line' },
  { type: 'area', label: 'Area' },
];

const haCache = new WeakMap<Agg, Float64Array>();
/** Heikin-Ashi open for every candle. Candle j's HA open depends only on completed candles < j. */
function haOpen(a: Agg): Float64Array {
  let ha = haCache.get(a);
  if (ha) return ha;
  ha = new Float64Array(a.n);
  for (let j = 0; j < a.n; j++) {
    if (j === 0) ha[j] = (a.o[0] + a.c[0]) / 2;
    else ha[j] = (ha[j - 1] + (a.o[j - 1] + a.h[j - 1] + a.l[j - 1] + a.c[j - 1]) / 4) / 2;
  }
  haCache.set(a, ha);
  return ha;
}

interface IndSeries {
  id: string;
  series: ISeriesApi<'Line' | 'Histogram'>[];
  pane: number;
}

export class ChartPane {
  el: HTMLDivElement;
  chartEl: HTMLDivElement;
  chart: IChartApi;
  main!: ISeriesApi<SeriesType>;
  layer: DrawingLayer;
  tf!: Timeframe;
  agg!: Agg;
  bars!: Bars;
  start = 0; // first displayed agg index
  k = -1; // last displayed agg index
  times: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private ind: IndSeries[] = [];
  private markers!: ISeriesMarkersPluginApi<Time>;
  private priceLines = new Map<string, IPriceLine>();
  private legend: HTMLDivElement;
  private header: HTMLDivElement;
  private lastC: { o: number; h: number; l: number; c: number; v: number; t: number } | null = null;
  private ro: ResizeObserver;

  constructor(
    public host: PaneHost,
    public cfg: PaneConfig,
    public index: number,
  ) {
    this.header = h('div', { class: 'pane-head' });
    this.legend = h('div', { class: 'pane-legend' });
    this.chartEl = h('div', { class: 'pane-chart' });
    this.el = h('div', { class: 'pane' }, this.header, this.chartEl, this.legend);
    this.el.addEventListener('pointerdown', () => host.activate(this), true);
    const th = theme();
    this.chart = createChart(this.chartEl, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: th.bg },
        textColor: th.text,
        fontSize: 11,
        panes: { separatorColor: th.grid, separatorHoverColor: th.grid, enableResize: true },
      },
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: th.grid },
      timeScale: { borderColor: th.grid, timeVisible: true, secondsVisible: false, rightOffset: 12, barSpacing: 8 },
      localization: { locale: 'en-US', timeFormatter: (t: number) => fmtLocal(t, true) },
    });
    this.createMain();
    const self = this;
    this.layer = new DrawingLayer({
      chart: this.chart,
      get series() {
        return self.main;
      },
      container: this.chartEl,
      times: () => this.times,
      count: () => this.k - this.start + 1,
      tfSec: () => this.tf.sec,
      digits: () => this.spec().digits,
      pipSize: () => this.spec().pipSize,
      bar: (i) => {
        const j = this.start + i;
        if (i < 0 || j > this.k) return null;
        if (j === this.k && this.lastC) return this.lastC;
        return { o: this.agg.o[j], h: this.agg.h[j], l: this.agg.l[j], c: this.agg.c[j] };
      },
      drawings: () => host.drawings(this.cfg.symbol),
      changed: () => host.drawingsChanged(this.cfg.symbol),
      dragLines: () => host.dragLines(this.cfg.symbol),
      onPlaceFromTool: (d) => host.placeFromTool(d, this.cfg.symbol),
    });
    this.chart.subscribeCrosshairMove((p) => {
      const t = p.time as number | undefined;
      const j = t != null ? indexAtOrBefore(this.times, this.k - this.start + 1, t) : -1;
      if (j >= 0 && this.times[j] === t) {
        const g = this.start + j;
        const c = g === this.k && this.lastC ? this.lastC : { o: this.agg.o[g], h: this.agg.h[g], l: this.agg.l[g], c: this.agg.c[g], v: this.agg.v[g], t: t! };
        this.renderLegend({ ...c, t: t! });
      } else this.renderLegend(this.lastC);
      if (!this.syncingCrosshair) host.crosshairMoved(this, p.point ? (t ?? null) : null);
    });
    this.chartEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = this.chartEl.getBoundingClientRect();
      const price = this.main.coordinateToPrice(e.clientY - r.top);
      if (price != null) host.contextMenu(this, price as number, e.clientX, e.clientY);
    });
    this.ro = new ResizeObserver(() => this.layer.schedule());
    this.ro.observe(this.chartEl);
    this.renderHeader();
    this.load();
  }

  syncingCrosshair = false;

  /** Mirror another pane's crosshair (time in local seconds). */
  showCrosshairAt(t: number | null) {
    this.syncingCrosshair = true;
    try {
      const j = t == null ? -1 : indexAtOrBefore(this.times, this.k - this.start + 1, t);
      if (j < 0) this.chart.clearCrosshairPosition();
      else {
        const g = this.start + j;
        this.chart.setCrosshairPosition(g === this.k && this.lastC ? this.lastC.c : this.agg.c[g], this.times[j] as UTCTimestamp, this.main);
      }
    } finally {
      this.syncingCrosshair = false;
    }
  }

  chartType(): ChartType {
    return this.host.replay.session.state.chartType?.[this.index] ?? 'candles';
  }

  private createMain() {
    if (this.main) {
      this.clearIndicators();
      this.markers.detach();
      this.chart.removeSeries(this.main);
      this.priceLines.clear();
    }
    const t = this.chartType();
    const up = '#26a69a', dn = '#ef5350';
    if (t === 'line') this.main = this.chart.addSeries(LineSeries, { color: '#3987e5', lineWidth: 2 }, 0);
    else if (t === 'area') this.main = this.chart.addSeries(AreaSeries, { lineColor: '#3987e5', topColor: 'rgba(57,135,229,0.35)', bottomColor: 'rgba(57,135,229,0)', lineWidth: 2 }, 0);
    else if (t === 'bars') this.main = this.chart.addSeries(BarSeries, { upColor: up, downColor: dn, thinBars: false }, 0);
    else
      this.main = this.chart.addSeries(CandlestickSeries, {
        upColor: t === 'hollow' ? 'rgba(0,0,0,0)' : up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn,
      }, 0);
    this.markers = createSeriesMarkers(this.main, []);
  }

  setChartType() {
    this.createMain();
    this.load();
  }

  spec() {
    return this.host.replay.session.specs[this.cfg.symbol] ?? { symbol: this.cfg.symbol, pipSize: 0.0001, contractSize: 100000, digits: 5 };
  }

  destroy() {
    this.ro.disconnect();
    this.layer.destroy();
    this.chart.remove();
    this.el.remove();
  }

  renderHeader() {
    const syms = this.host.replay.session.symbols;
    this.header.innerHTML = '';
    const sel = h('select', { class: 'pane-sym', title: 'Symbol' }, ...syms.map((s) => h('option', { value: s, selected: s === this.cfg.symbol }, s)));
    sel.onchange = () => {
      this.cfg.symbol = sel.value;
      this.load();
      this.host.paneChanged();
    };
    const tfBtn = h('button', { class: 'pane-tf', title: 'Change timeframe (type any: 7m, 2H, 3D…)' }, this.cfg.tf);
    tfBtn.onclick = () => this.host.onTfRequest(this);
    const ct = this.chartType();
    const typeSel = h('select', { class: 'pane-type', title: 'Chart type' }, ...CHART_TYPES.map((c) => h('option', { value: c.type, selected: c.type === ct }, c.label)));
    typeSel.onchange = () => this.host.setChartType(this, typeSel.value as ChartType);
    this.header.append(sel, tfBtn, typeSel);
  }

  setTf(tf: string) {
    if (!parseTf(tf)) return false;
    this.cfg.tf = tf;
    this.renderHeader();
    this.load();
    this.host.paneChanged();
    return true;
  }

  setActive(on: boolean) {
    this.el.classList.toggle('active', on);
  }

  /** Full (re)load: aggregation + setData. */
  load() {
    const rp = this.host.replay;
    const b = rp.data[this.cfg.symbol];
    this.tf = parseTf(this.cfg.tf) ?? parseTf('1H')!;
    this.bars = b;
    this.agg = getAgg(this.cfg.symbol, b, this.tf, this.host.tz);
    const sp = this.spec();
    this.main.applyOptions({ priceFormat: { type: 'price', precision: sp.digits, minMove: Math.pow(10, -sp.digits) } });
    this.k = -1;
    this.priceLines.forEach((l) => this.main.removePriceLine(l));
    this.priceLines.clear();
    this.sync(true);
    this.chart.timeScale().scrollToRealTime();
    this.renderHeader();
  }

  /** Raw OHLC of candle j as seen at `cursor`. */
  private candleAt(j: number, cursor: number) {
    const c = partialCandle(this.bars, this.agg, j, cursor);
    return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
  }

  /** Series point for candle j in the current chart type. */
  private point(j: number, cursor: number) {
    const c = this.candleAt(j, cursor);
    const t = this.chartType();
    if (t === 'line' || t === 'area') return { time: c.time, value: c.close };
    if (t === 'heikin') {
      const ho = haOpen(this.agg)[j];
      const hc = (c.open + c.high + c.low + c.close) / 4;
      return { time: c.time, open: ho, high: Math.max(c.high, ho, hc), low: Math.min(c.low, ho, hc), close: hc };
    }
    return c;
  }

  /** Bring the chart up to the replay cursor (incrementally when possible). */
  sync(full = false) {
    const cursor = this.host.replay.cursor[this.cfg.symbol] ?? 0;
    const a = this.agg;
    const k = a.baseToAgg[cursor];
    if (full || this.k < 0 || k < this.k || k - this.k > 400) {
      this.start = Math.max(0, k - MAX_DISPLAY + 1);
      const data = [];
      for (let j = this.start; j <= k; j++) data.push(this.point(j, cursor));
      this.main.setData(data);
      this.k = k;
      this.times = a.time.subarray(this.start, k + 1);
      this.rebuildIndicators();
    } else {
      if (k > this.k) this.main.update(this.point(this.k, cursor));
      for (let j = Math.max(this.k, this.start); j <= k; j++) this.main.update(this.point(j, cursor));
      const prevK = this.k;
      this.k = k;
      this.times = a.time.subarray(this.start, k + 1);
      this.updateIndicators(k - prevK + 1);
    }
    const lc = this.candleAt(k, cursor);
    this.lastC = { o: lc.open, h: lc.high, l: lc.low, c: lc.close, v: 0, t: lc.time };
    this.renderLegend(this.lastC);
    this.refreshOverlays();
    this.layer.schedule();
  }

  private renderLegend(c: { o: number; h: number; l: number; c: number; t: number } | null) {
    if (!c) return;
    const d = this.spec().digits;
    const ch = c.c - c.o;
    this.legend.innerHTML = `<b>${this.cfg.symbol}</b> · ${this.tf.label} · ${fmtLocal(c.t)}  O <span>${c.o.toFixed(d)}</span> H <span>${c.h.toFixed(d)}</span> L <span>${c.l.toFixed(d)}</span> C <span class="${ch >= 0 ? 'up' : 'dn'}">${c.c.toFixed(d)}</span>`;
  }

  // ---- indicators -------------------------------------------------------------

  private series(from: number): Series {
    const a = this.agg, k = this.k;
    const cursor = this.host.replay.cursor[this.cfg.symbol];
    const n = k - from + 1;
    const o = a.o.slice(from, k + 1), hh = a.h.slice(from, k + 1), l = a.l.slice(from, k + 1), c = a.c.slice(from, k + 1), v = a.v.slice(from, k + 1);
    const p = partialCandle(this.bars, a, k, cursor);
    o[n - 1] = p.open;
    hh[n - 1] = p.high;
    l[n - 1] = p.low;
    c[n - 1] = p.close;
    v[n - 1] = p.volume;
    return { time: a.time.subarray(from, k + 1), o, h: hh, l, c, v, n };
  }

  private clearIndicators() {
    for (const s of this.ind) for (const x of s.series) this.chart.removeSeries(x);
    this.ind = [];
    // remove empty sub-panes
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);
  }

  rebuildIndicators() {
    this.clearIndicators();
    const data = this.series(this.start);
    let paneIdx = 0;
    this.cfg.indicators.forEach((cfg) => {
      const def = indicatorDef(cfg.type);
      if (!def) return;
      const outs = def.compute(data, { ...def.params, ...cfg.params });
      const pane = def.pane === 'main' ? 0 : ++paneIdx;
      const created: ISeriesApi<'Line' | 'Histogram'>[] = [];
      outs.forEach((o, oi) => {
        const color = oi === 0 ? cfg.color : IND_COLORS[(IND_COLORS.indexOf(cfg.color) + oi) % IND_COLORS.length];
        const s =
          o.kind === 'hist'
            ? this.chart.addSeries(HistogramSeries, { color: '#5d6675', priceLineVisible: false, lastValueVisible: false }, pane)
            : this.chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }, pane);
        const pts = [];
        for (let i = 0; i < data.n; i++) {
          const val = o.values[i];
          const t = data.time[i] as UTCTimestamp;
          if (isNaN(val)) pts.push({ time: t });
          else pts.push(o.kind === 'hist' && cfg.type === 'macd' ? { time: t, value: val, color: val >= 0 ? '#26a69a' : '#ef5350' } : { time: t, value: val });
        }
        (s as ISeriesApi<'Line'>).setData(pts);
        created.push(s);
      });
      if (def.levels && created[0]) for (const lv of def.levels) created[created.length - 1].createPriceLine({ price: lv, color: '#5d6675', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      if (pane > 0) this.chart.panes()[pane]?.setHeight(110);
      this.ind.push({ id: cfg.id, series: created, pane });
    });
  }

  private updateIndicators(count: number) {
    if (!this.ind.length) return;
    const from = Math.max(this.start, this.k - IND_WINDOW);
    const data = this.series(from);
    this.cfg.indicators.forEach((cfg, idx) => {
      const def = indicatorDef(cfg.type);
      const is = this.ind[idx];
      if (!def || !is) return;
      const outs = def.compute(data, { ...def.params, ...cfg.params });
      outs.forEach((o, oi) => {
        const s = is.series[oi];
        for (let i = Math.max(0, data.n - count); i < data.n; i++) {
          const val = o.values[i];
          const t = data.time[i] as UTCTimestamp;
          if (isNaN(val)) (s as ISeriesApi<'Line'>).update({ time: t });
          else (s as ISeriesApi<'Line'>).update(o.kind === 'hist' && cfg.type === 'macd' ? { time: t, value: val, color: val >= 0 ? '#26a69a' : '#ef5350' } : { time: t, value: val });
        }
      });
    });
  }

  // ---- positions / orders / trade markers ---------------------------------------

  private candleTimeFor(utc: number): number | null {
    const i = indexAtOrBefore(this.bars.t, this.bars.n, utc);
    if (i < 0) return null;
    const j = this.agg.baseToAgg[i];
    if (j < this.start || j > this.k) return null;
    return this.agg.time[j];
  }

  refreshOverlays() {
    const br = this.host.replay.broker;
    const sym = this.cfg.symbol;
    const want = new Map<string, { price: number; color: string; title: string; style: LineStyle; width: 1 | 2 }>();
    for (const p of br.s.positions) {
      if (p.symbol !== sym) continue;
      const fl = br.floating(p);
      want.set(`p${p.id}`, { price: p.entry, color: p.side === 'long' ? '#3987e5' : '#e87ba4', title: `${p.side === 'long' ? 'BUY' : 'SELL'} ${p.lots} ${money(fl, true)}`, style: LineStyle.Solid, width: 2 });
      if (p.sl != null) want.set(`s${p.id}`, { price: p.sl, color: '#ef5350', title: `SL ${money(br.value(sym, (p.side === 'long' ? 1 : -1) * (p.sl - p.entry), p.lots, p.sl), true)}`, style: LineStyle.Dashed, width: 1 });
      if (p.tp != null) want.set(`t${p.id}`, { price: p.tp, color: '#26a69a', title: `TP ${money(br.value(sym, (p.side === 'long' ? 1 : -1) * (p.tp - p.entry), p.lots, p.tp), true)}`, style: LineStyle.Dashed, width: 1 });
    }
    for (const o of br.s.orders) {
      if (o.symbol !== sym) continue;
      want.set(`o${o.id}`, { price: o.price, color: '#f0b90b', title: `${o.side === 'long' ? 'BUY' : 'SELL'} ${o.type.toUpperCase()} ${o.lots}`, style: LineStyle.Dotted, width: 1 });
      if (o.sl != null) want.set(`os${o.id}`, { price: o.sl, color: '#ef5350', title: `SL`, style: LineStyle.Dotted, width: 1 });
      if (o.tp != null) want.set(`ot${o.id}`, { price: o.tp, color: '#26a69a', title: `TP`, style: LineStyle.Dotted, width: 1 });
    }
    for (const [key, pl] of this.priceLines) {
      if (!want.has(key)) {
        this.main.removePriceLine(pl);
        this.priceLines.delete(key);
      }
    }
    for (const [key, w] of want) {
      const opts = { price: w.price, color: w.color, title: w.title, lineStyle: w.style, lineWidth: w.width, axisLabelVisible: true };
      const ex = this.priceLines.get(key);
      if (ex) ex.applyOptions(opts);
      else this.priceLines.set(key, this.main.createPriceLine(opts));
    }
    // markers: entries & exits of closed trades + open positions (last 300)
    const ms: SeriesMarker<Time>[] = [];
    const trades = br.s.trades.filter((t) => t.symbol === sym).slice(-300);
    for (const t of trades) {
      const te = this.candleTimeFor(t.entryTime), tx = this.candleTimeFor(t.exitTime);
      if (te != null) ms.push({ time: te as UTCTimestamp, position: t.side === 'long' ? 'belowBar' : 'aboveBar', color: t.side === 'long' ? '#3987e5' : '#e87ba4', shape: t.side === 'long' ? 'arrowUp' : 'arrowDown', text: `#${t.id}` });
      if (tx != null) ms.push({ time: tx as UTCTimestamp, position: t.side === 'long' ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? '#26a69a' : '#ef5350', shape: 'circle', text: `${money(t.pnl, true)}` });
    }
    for (const p of br.s.positions) {
      if (p.symbol !== sym) continue;
      const te = this.candleTimeFor(p.entryTime);
      if (te != null) ms.push({ time: te as UTCTimestamp, position: p.side === 'long' ? 'belowBar' : 'aboveBar', color: p.side === 'long' ? '#3987e5' : '#e87ba4', shape: p.side === 'long' ? 'arrowUp' : 'arrowDown', text: `#${p.id}` });
    }
    ms.sort((a, b) => (a.time as number) - (b.time as number));
    this.markers.setMarkers(ms);
  }

  screenshot(): string {
    const c = this.chart.takeScreenshot(true, false);
    const ctx = c.getContext('2d');
    if (ctx) ctx.drawImage(this.layer.canvas, 0, 0, c.width, c.height);
    // downscale to keep IndexedDB small
    const scale = Math.min(1, 1100 / c.width);
    const out = document.createElement('canvas');
    out.width = Math.round(c.width * scale);
    out.height = Math.round(c.height * scale);
    out.getContext('2d')!.drawImage(c, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.72);
  }
}
