import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts';
import { firstHit, posCalc, type PosEnv, type PosLevels, type PosSettings } from '../engine/position';

export type DrawingType =
  | 'trend' | 'ray' | 'extended' | 'hline' | 'hray' | 'vline' | 'rect' | 'fib' | 'long' | 'short' | 'text' | 'measure' | 'arrowUp' | 'arrowDown';

export interface Pt {
  t: number; // local display seconds
  p: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  pts: Pt[];
  color: string;
  text?: string;
  /** long/short tool: risk sizing (TradingView "Inputs") */
  pos?: PosSettings;
  hidden?: boolean;
  locked?: boolean;
  /** transient order-ticket preview (never saved) */
  preview?: boolean;
}

export const isPosTool = (d: Drawing) => d.type === 'long' || d.type === 'short';

/** Entry / stop / target of a long/short drawing. */
export function posLevels(d: Drawing): PosLevels {
  return { side: d.type === 'short' ? 'short' : 'long', entry: d.pts[0].p, sl: d.pts[1].p, tp: d.pts[2].p };
}

export interface ThemeColors {
  up: string;
  down: string;
  text: string;
  surface: string;
  muted: string;
}

/** Translucent TP/SL zones behind a live order or position. */
export interface Zone {
  t: number; // display time it starts
  entry: number;
  sl: number | null;
  tp: number | null;
}

export interface DragLine {
  key: string;
  price: number;
  color: string;
  label: string;
  onDrop(price: number): void;
}

export const TOOL_INFO: { type: DrawingType | 'cursor'; icon: string; title: string; key?: string }[] = [
  { type: 'cursor', icon: '↖', title: 'Cursor (Esc)' },
  { type: 'trend', icon: '╱', title: 'Trend line (Alt+T)', key: 't' },
  { type: 'ray', icon: '⟋', title: 'Ray' },
  { type: 'extended', icon: '⤢', title: 'Extended line' },
  { type: 'hline', icon: '―', title: 'Horizontal line (Alt+H)', key: 'h' },
  { type: 'hray', icon: '⟶', title: 'Horizontal ray' },
  { type: 'vline', icon: '│', title: 'Vertical line (Alt+V)', key: 'v' },
  { type: 'rect', icon: '▭', title: 'Rectangle (Alt+R)', key: 'r' },
  { type: 'fib', icon: 'ƒ', title: 'Fibonacci retracement (Alt+F)', key: 'f' },
  { type: 'long', icon: '⬆', title: 'Long position (risk/reward)', key: 'l' },
  { type: 'short', icon: '⬇', title: 'Short position (risk/reward)', key: 's' },
  { type: 'measure', icon: '⇲', title: 'Measure (price/time range)', key: 'm' },
  { type: 'text', icon: 'T', title: 'Text note' },
  { type: 'arrowUp', icon: '▲', title: 'Arrow up marker' },
  { type: 'arrowDown', icon: '▼', title: 'Arrow down marker' },
];

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];
const ONE_POINT: DrawingType[] = ['hline', 'hray', 'vline', 'text', 'arrowUp', 'arrowDown'];
const DEFAULT_COLOR: Partial<Record<DrawingType, string>> = {
  hline: '#d4a24c', hray: '#d4a24c', vline: '#8a8780', rect: '#9085e9', fib: '#1a9e93', measure: '#5b93d6', text: '#8a8780',
  arrowUp: '#1a9e93', arrowDown: '#e0605a',
};

export interface LayerHost {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  container: HTMLElement;
  /** displayed candle times (local seconds), chart logical 0 == times[0] */
  times(): ArrayLike<number>;
  count(): number;
  tfSec(): number;
  digits(): number;
  pipSize(): number;
  bar(i: number): { o: number; h: number; l: number; c: number } | null;
  drawings(): Drawing[];
  changed(): void;
  dragLines(): DragLine[];
  onPlaceFromTool?(d: Drawing): void;
  /** drawings rendered and editable but not persisted (the ticket preview) */
  extraDrawings?(): Drawing[];
  posEnv?(): PosEnv;
  posDefaults?(): PosSettings;
  colors?(): ThemeColors;
  zones?(): Zone[];
  onSelect?(d: Drawing | null): void;
  /** a drawing was dragged (final = pointer released) */
  onEdit?(d: Drawing, final: boolean): void;
  onSettings?(d: Drawing): void;
}

type Hit = { d: Drawing; handle: number | -1 } | { line: DragLine };

export class DrawingLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tool: DrawingType | 'cursor' = 'cursor';
  magnet = true;
  private _sel: Drawing | null = null;
  get selected() {
    return this._sel;
  }
  set selected(d: Drawing | null) {
    if (d === this._sel) return;
    this._sel = d;
    this.host.onSelect?.(d);
  }
  private placing: Drawing | null = null;
  private drag: { hit: Hit; start: Pt; orig: Pt[]; price?: number; moved: boolean } | null = null;
  private raf = 0;
  private toolbar: HTMLDivElement;
  onToolDone: (() => void) | null = null;
  stayInTool = false;

  constructor(private host: LayerHost) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'draw-layer';
    host.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'draw-toolbar hidden';
    host.container.appendChild(this.toolbar);

    const c = host.container;
    const opts = { capture: true } as const;
    c.addEventListener('pointerdown', this.onDown, opts);
    c.addEventListener('mousedown', this.swallow, opts);
    c.addEventListener('touchstart', this.swallow, opts);
    c.addEventListener('pointermove', this.onMove, opts);
    window.addEventListener('pointerup', this.onUp, true);
    c.addEventListener('dblclick', this.onDbl, opts);
    host.chart.timeScale().subscribeVisibleLogicalRangeChange(this.schedule);
    host.chart.subscribeCrosshairMove(this.schedule);
    new ResizeObserver(this.schedule).observe(c);
  }

  destroy() {
    window.removeEventListener('pointerup', this.onUp, true);
    this.canvas.remove();
    this.toolbar.remove();
  }

  setTool(t: DrawingType | 'cursor') {
    this.tool = t;
    this.placing = null;
    this.host.container.classList.toggle('drawing-mode', t !== 'cursor');
    this.schedule();
  }

  schedule = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  };

  // ---- coordinates -----------------------------------------------------------

  private paneH() {
    return this.host.chart.panes()[0]?.getHeight() ?? this.host.container.clientHeight;
  }
  private paneW() {
    return this.host.chart.timeScale().width();
  }

  timeToLogical(t: number): number {
    const T = this.host.times(), n = this.host.count(), tf = this.host.tfSec();
    if (!n) return 0;
    if (t <= T[0]) return (t - T[0]) / tf;
    if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / tf;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    return lo + (t - T[lo]) / (T[hi] - T[lo]);
  }

  logicalToTime(lg: number): number {
    const T = this.host.times(), n = this.host.count(), tf = this.host.tfSec();
    if (!n) return 0;
    if (lg <= 0) return T[0] + lg * tf;
    if (lg >= n - 1) return T[n - 1] + (lg - (n - 1)) * tf;
    const i = Math.floor(lg);
    return T[i] + (lg - i) * (T[i + 1] - T[i]);
  }

  x(t: number): number {
    return (this.host.chart.timeScale().logicalToCoordinate(this.timeToLogical(t) as Logical) ?? -9999) as number;
  }
  y(p: number): number {
    return (this.host.series.priceToCoordinate(p) ?? -9999) as number;
  }
  toPt(x: number, y: number, snap = this.magnet): Pt {
    const lg = (this.host.chart.timeScale().coordinateToLogical(x) ?? 0) as number;
    let p = (this.host.series.coordinateToPrice(y) ?? 0) as number;
    let t = this.logicalToTime(Math.round(lg));
    if (snap) {
      const i = Math.round(lg);
      const b = this.host.bar(i);
      if (b) {
        let best = p, bd = 14;
        for (const v of [b.o, b.h, b.l, b.c]) {
          const d = Math.abs(this.y(v) - y);
          if (d < bd) (bd = d), (best = v);
        }
        p = best;
      }
    } else t = this.logicalToTime(lg);
    return { t, p };
  }

  // ---- events -------------------------------------------------------------

  private local(e: PointerEvent | MouseEvent) {
    const r = this.host.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private inPane(x: number, y: number) {
    return x >= 0 && x <= this.paneW() && y >= 0 && y <= this.paneH();
  }

  private blockNext = false;
  private swallow = (e: Event) => {
    if (this.blockNext) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  private onDown = (e: PointerEvent) => {
    this.blockNext = false;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.draw-toolbar, .line-tag')) return;
    const { x, y } = this.local(e);
    if (!this.inPane(x, y)) return;
    const stop = () => {
      this.blockNext = true;
      e.stopPropagation();
      e.preventDefault();
    };
    if (this.tool !== 'cursor') {
      stop();
      const pt = this.toPt(x, y);
      if (this.placing) {
        this.finishPlacing();
        return;
      }
      const type = this.tool;
      const d: Drawing = { id: Math.random().toString(36).slice(2, 10), type, pts: [pt, { ...pt }], color: DEFAULT_COLOR[type] ?? '#22c96a' };
      if (ONE_POINT.includes(type)) {
        d.pts = [pt];
        if (type === 'text') {
          const txt = prompt('Text', 'Note');
          if (!txt) return;
          d.text = txt;
        }
        this.host.drawings().push(d);
        this.selected = d;
        this.host.changed();
        this.toolDone();
        return;
      }
      if (type === 'long' || type === 'short') {
        const vr = this.host.series.coordinateToPrice(0) as number;
        const vr2 = this.host.series.coordinateToPrice(this.paneH()) as number;
        const dist = Math.abs(vr - vr2) * 0.06;
        const dir = type === 'long' ? 1 : -1;
        const t1 = pt.t + this.host.tfSec() * 25;
        d.pts = [pt, { t: t1, p: pt.p - dir * dist }, { t: t1, p: pt.p + dir * dist * 2 }];
        d.color = type === 'long' ? '#1a9e93' : '#e0605a';
        const def = this.host.posDefaults?.();
        if (def) d.pos = { ...def };
        this.host.drawings().push(d);
        this.selected = d;
        this.host.changed();
        this.toolDone();
        return;
      }
      this.placing = d;
      this.drag = { hit: { d, handle: 1 }, start: pt, orig: d.pts.map((p) => ({ ...p })), moved: false };
      this.host.drawings().push(d);
      this.schedule();
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit) {
      stop();
      if ('d' in hit) {
        // pointerdown is default-prevented (so the chart doesn't pan), which also kills the
        // browser's dblclick — detect the second press on the same drawing ourselves
        const now = performance.now();
        if (this.lastPress && this.lastPress.id === hit.d.id && now - this.lastPress.t < 400) {
          this.lastPress = null;
          this.drag = null;
          this.doubleHit(hit.d);
          return;
        }
        this.lastPress = { id: hit.d.id, t: now };
        this.selected = hit.d.preview ? null : hit.d;
        if (hit.d.locked) {
          this.schedule();
          return;
        }
        this.drag = { hit, start: this.toPt(x, y, false), orig: hit.d.pts.map((p) => ({ ...p })), moved: false };
      } else {
        this.drag = { hit, start: this.toPt(x, y, false), orig: [], price: hit.line.price, moved: false };
      }
      this.schedule();
    } else if (this.selected) {
      this.selected = null;
      this.schedule();
    }
  };

  private onMove = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    if (this.placing && !this.drag) {
      this.placing.pts[1] = this.toPt(x, y);
      this.schedule();
      return;
    }
    if (!this.drag) {
      if (this.tool === 'cursor' && this.inPane(x, y)) {
        const h = this.hitTest(x, y);
        this.host.container.style.cursor = h ? ('line' in h ? 'ns-resize' : h.handle >= 0 ? 'grab' : 'move') : '';
      }
      return;
    }
    e.stopPropagation();
    this.drag.moved = true;
    const hit = this.drag.hit;
    if ('line' in hit) {
      this.drag.price = this.host.series.coordinateToPrice(y) as number;
      this.schedule();
      return;
    }
    const d = hit.d;
    if (hit.handle >= 0) {
      // position-tool edges move freely (TradingView doesn't snap them to candles)
      const pt = this.toPt(x, y, isPosTool(d) ? false : this.magnet);
      if (d.type === 'long' || d.type === 'short') {
        if (hit.handle === 0) {
          const dp = pt.p - this.drag.orig[0].p;
          d.pts[0] = { t: pt.t, p: pt.p };
          d.pts[1].p = this.drag.orig[1].p + dp;
          d.pts[2].p = this.drag.orig[2].p + dp;
        } else if (hit.handle === 3) {
          d.pts[1].t = d.pts[2].t = Math.max(pt.t, d.pts[0].t + this.host.tfSec());
        } else d.pts[hit.handle].p = pt.p;
      } else d.pts[hit.handle] = pt;
    } else {
      const cur = this.toPt(x, y, false);
      const dt = cur.t - this.drag.start.t, dp = cur.p - this.drag.start.p;
      d.pts = this.drag.orig.map((p) => ({ t: p.t + dt, p: p.p + dp }));
    }
    this.host.onEdit?.(d, false);
    this.schedule();
  };

  private onUp = () => {
    if (!this.drag) return;
    const dr = this.drag;
    this.drag = null;
    if ('line' in dr.hit) {
      if (dr.moved && dr.price != null) dr.hit.line.onDrop(dr.price);
      this.schedule();
      return;
    }
    if (this.placing) {
      if (dr.moved && Math.abs(this.x(this.placing.pts[0].t) - this.x(this.placing.pts[1].t)) + Math.abs(this.y(this.placing.pts[0].p) - this.y(this.placing.pts[1].p)) > 6) this.finishPlacing();
      return; // otherwise click-move-click mode
    }
    if (dr.moved) {
      if ('d' in dr.hit) this.host.onEdit?.(dr.hit.d, true);
      if (!('d' in dr.hit && dr.hit.d.preview)) this.host.changed();
    }
    this.schedule();
  };

  private lastPress: { id: string; t: number } | null = null;

  private doubleHit(d: Drawing) {
    if (d.preview) return;
    if (isPosTool(d)) return this.host.onSettings?.(d);
    if (d.type === 'text') {
      const txt = prompt('Text', d.text);
      if (txt != null) {
        d.text = txt;
        this.host.changed();
      }
    }
  }

  private onDbl = (e: MouseEvent) => {
    const { x, y } = this.local(e);
    const hit = this.hitTest(x, y);
    if (hit && 'd' in hit && isPosTool(hit.d) && !hit.d.preview) {
      e.stopPropagation();
      this.host.onSettings?.(hit.d);
      return;
    }
    if (hit && 'd' in hit && hit.d.type === 'text') {
      e.stopPropagation();
      const txt = prompt('Text', hit.d.text);
      if (txt != null) {
        hit.d.text = txt;
        this.host.changed();
      }
    }
  };

  private finishPlacing() {
    const d = this.placing!;
    this.placing = null;
    this.drag = null;
    this.selected = d;
    this.host.changed();
    this.toolDone();
  }

  private toolDone() {
    if (!this.stayInTool) {
      this.setTool('cursor');
      this.onToolDone?.();
    }
    this.schedule();
  }

  deleteSelected() {
    if (!this.selected) return false;
    const arr = this.host.drawings();
    const i = arr.indexOf(this.selected);
    if (i >= 0) arr.splice(i, 1);
    this.selected = null;
    this.host.changed();
    return true;
  }

  /** everything drawn and hit-tested: saved drawings that are not hidden, plus the preview */
  private all(): Drawing[] {
    const out = this.host.drawings().filter((d) => !d.hidden);
    return this.host.extraDrawings ? out.concat(this.host.extraDrawings()) : out;
  }

  // ---- hit testing ------------------------------------------------------------

  private handles(d: Drawing): { x: number; y: number }[] {
    if (d.type === 'long' || d.type === 'short') {
      const x0 = this.x(d.pts[0].t), x1 = this.x(d.pts[1].t);
      return [
        { x: x0, y: this.y(d.pts[0].p) },
        { x: x0, y: this.y(d.pts[1].p) },
        { x: x0, y: this.y(d.pts[2].p) },
        { x: x1, y: this.y(d.pts[0].p) },
      ];
    }
    if (d.type === 'hline') return [{ x: this.paneW() / 2, y: this.y(d.pts[0].p) }];
    if (d.type === 'vline') return [{ x: this.x(d.pts[0].t), y: this.paneH() / 2 }];
    return d.pts.map((p) => ({ x: this.x(p.t), y: this.y(p.p) }));
  }

  private hitTest(x: number, y: number): Hit | null {
    for (const line of this.host.dragLines()) if (Math.abs(this.y(line.price) - y) < 5) return { line };
    const arr = this.all();
    const sel = this.selected;
    // handles of the selected drawing and of the ticket preview (always editable)
    for (const d of [...(sel && !sel.hidden ? [sel] : []), ...(this.host.extraDrawings?.() ?? [])]) {
      if (d.locked) continue;
      const hs = this.handles(d);
      for (let i = 0; i < hs.length; i++) if (Math.hypot(hs[i].x - x, hs[i].y - y) < 8) return { d, handle: i };
    }
    for (let k = arr.length - 1; k >= 0; k--) {
      const d = arr[k];
      if (this.hitBody(d, x, y)) return { d, handle: -1 };
    }
    return null;
  }

  private hitBody(d: Drawing, x: number, y: number): boolean {
    const P = d.pts.map((p) => ({ x: this.x(p.t), y: this.y(p.p) }));
    const W = this.paneW();
    switch (d.type) {
      case 'hline':
        return Math.abs(P[0].y - y) < 5;
      case 'hray':
        return Math.abs(P[0].y - y) < 5 && x >= P[0].x - 5;
      case 'vline':
        return Math.abs(P[0].x - x) < 5;
      case 'trend':
      case 'measure':
        return segDist(x, y, P[0], P[1]) < 5;
      case 'ray':
      case 'extended': {
        const [a, b] = extendLine(P[0], P[1], W, d.type === 'extended');
        return segDist(x, y, a, b) < 5;
      }
      case 'rect':
      case 'fib': {
        const x0 = Math.min(P[0].x, P[1].x), x1 = Math.max(P[0].x, P[1].x);
        const y0 = Math.min(P[0].y, P[1].y), y1 = Math.max(P[0].y, P[1].y);
        if (d.type === 'fib') {
          if (x < x0 - 5 || x > W) return false;
          return FIB.some((f) => Math.abs(this.y(d.pts[1].p + (d.pts[0].p - d.pts[1].p) * f) - y) < 5);
        }
        return x >= x0 - 4 && x <= x1 + 4 && y >= y0 - 4 && y <= y1 + 4;
      }
      case 'long':
      case 'short': {
        const x0 = P[0].x, x1 = P[1].x;
        const ys = [P[1].y, P[2].y];
        return x >= x0 && x <= x1 && y >= Math.min(...ys) && y <= Math.max(...ys);
      }
      case 'text':
        return x >= P[0].x - 4 && x <= P[0].x + 8 * (d.text?.length ?? 4) && Math.abs(y - P[0].y + 6) < 12;
      case 'arrowUp':
      case 'arrowDown':
        return Math.hypot(P[0].x - x, P[0].y - y) < 10;
    }
  }

  // ---- rendering ----------------------------------------------------------------

  render() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = this.host.container.clientWidth, H = this.host.container.clientHeight;
    if (c.width !== W * dpr || c.height !== H * dpr) {
      c.width = W * dpr;
      c.height = H * dpr;
      c.style.width = W + 'px';
      c.style.height = H + 'px';
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.paneW(), this.paneH());
    ctx.clip();
    this.drawZones();
    for (const d of this.all()) this.drawOne(d, d === this.selected || d === this.placing || !!d.preview);
    if (this.drag && 'line' in this.drag.hit && this.drag.price != null) {
      const y = this.y(this.drag.price);
      ctx.strokeStyle = this.drag.hit.line.color;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      line(ctx, 0, y, this.paneW(), y);
      ctx.setLineDash([]);
      this.label(this.paneW() - 4, y - 4, `${this.drag.hit.line.label} ${this.drag.price.toFixed(this.host.digits())}`, this.drag.hit.line.color, 'right');
    }
    ctx.restore();
    this.renderToolbar();
  }

  private label(x: number, y: number, text: string, bg: string, align: 'left' | 'right' | 'center' = 'left', fg = '#fff') {
    const ctx = this.ctx;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 8;
    // keep labels on screen (boxes near the price axis would otherwise clip them)
    const x0 = Math.max(2, Math.min(this.paneW() - w - 2, align === 'left' ? x : align === 'right' ? x - w : x - w / 2));
    ctx.fillStyle = bg;
    roundRect(ctx, x0, y - 14, w, 17, 3);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, x0 + 4, y - 2);
  }

  private drawOne(d: Drawing, sel: boolean) {
    const ctx = this.ctx;
    const P = d.pts.map((p) => ({ x: this.x(p.t), y: this.y(p.p) }));
    const W = this.paneW(), H = this.paneH();
    const dg = this.host.digits();
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = sel ? 2 : 1.5;
    switch (d.type) {
      case 'trend':
        line(ctx, P[0].x, P[0].y, P[1].x, P[1].y);
        break;
      case 'ray':
      case 'extended': {
        const [a, b] = extendLine(P[0], P[1], W, d.type === 'extended');
        line(ctx, a.x, a.y, b.x, b.y);
        break;
      }
      case 'hline':
        line(ctx, 0, P[0].y, W, P[0].y);
        this.label(W - 2, P[0].y - 2, d.pts[0].p.toFixed(dg), d.color, 'right');
        break;
      case 'hray':
        line(ctx, P[0].x, P[0].y, W, P[0].y);
        break;
      case 'vline':
        line(ctx, P[0].x, 0, P[0].x, H);
        break;
      case 'rect':
        ctx.globalAlpha = 0.15;
        ctx.fillRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
        ctx.globalAlpha = 1;
        ctx.strokeRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
        break;
      case 'fib': {
        const x0 = Math.min(P[0].x, P[1].x);
        const p0 = d.pts[0].p, p1 = d.pts[1].p;
        ctx.setLineDash([4, 3]);
        line(ctx, P[0].x, P[0].y, P[1].x, P[1].y);
        ctx.setLineDash([]);
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        for (const f of FIB) {
          const pr = p1 + (p0 - p1) * f;
          const y = this.y(pr);
          ctx.globalAlpha = f === 0.5 || f === 0.618 ? 1 : 0.7;
          line(ctx, x0, y, W, y);
          ctx.fillText(`${f} (${pr.toFixed(dg)})`, x0 + 4, y - 3);
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'long':
      case 'short':
        this.drawPosition(d, P);
        break;
      case 'measure': {
        const up = d.pts[1].p >= d.pts[0].p;
        ctx.fillStyle = up ? 'rgba(91,147,214,0.18)' : 'rgba(224,96,90,0.18)';
        ctx.fillRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
        ctx.strokeStyle = up ? '#5b93d6' : '#e0605a';
        line(ctx, P[0].x, P[0].y, P[1].x, P[1].y);
        const dp = d.pts[1].p - d.pts[0].p;
        const bars = Math.round(this.timeToLogical(d.pts[1].t) - this.timeToLogical(d.pts[0].t));
        const txt = `${dp.toFixed(dg)} (${((dp / d.pts[0].p) * 100).toFixed(2)}%) ${(dp / this.host.pipSize()).toFixed(1)} pips · ${bars} bars`;
        this.label((P[0].x + P[1].x) / 2, Math.min(P[0].y, P[1].y) - 4, txt, up ? '#3b6fae' : '#b8443b', 'center');
        break;
      }
      case 'text':
        ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(d.text ?? '', P[0].x, P[0].y);
        break;
      case 'arrowUp':
      case 'arrowDown': {
        const dir = d.type === 'arrowUp' ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(P[0].x, P[0].y);
        ctx.lineTo(P[0].x - 7, P[0].y + dir * 12);
        ctx.lineTo(P[0].x + 7, P[0].y + dir * 12);
        ctx.closePath();
        ctx.fill();
        break;
      }
    }
    if (sel) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 1.5;
      for (const h of this.handles(d)) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  private colors(): ThemeColors {
    return this.host.colors?.() ?? { up: '#1a9e93', down: '#e0605a', text: '#f9fafb', surface: '#1c262c', muted: '#9ba1a6' };
  }

  private drawZones() {
    const zs = this.host.zones?.() ?? [];
    if (!zs.length) return;
    const ctx = this.ctx, c = this.colors(), W = this.paneW();
    for (const z of zs) {
      const x0 = Math.max(0, this.x(z.t));
      if (x0 >= W) continue;
      const ey = this.y(z.entry);
      ctx.globalAlpha = 0.1;
      if (z.tp != null) {
        const ty = this.y(z.tp);
        ctx.fillStyle = c.up;
        ctx.fillRect(x0, Math.min(ey, ty), W - x0, Math.abs(ty - ey));
      }
      if (z.sl != null) {
        const sy = this.y(z.sl);
        ctx.fillStyle = c.down;
        ctx.fillRect(x0, Math.min(ey, sy), W - x0, Math.abs(sy - ey));
      }
      ctx.globalAlpha = 1;
    }
  }

  /** TradingView-style long/short position: zones, read-outs and the replay outcome. */
  private drawPosition(d: Drawing, P: { x: number; y: number }[]) {
    const ctx = this.ctx, c = this.colors(), dg = this.host.digits();
    const [e, s, t] = P;
    const x1 = P[1].x, w = x1 - e.x;
    const lv = posLevels(d);
    const env = this.host.posEnv?.();
    const calc = env ? posCalc(lv, d.pos ?? this.host.posDefaults?.() ?? { riskMode: 'pct', risk: 1 }, env) : null;
    // outcome on revealed bars only
    const from = Math.ceil(this.timeToLogical(d.pts[0].t));
    const to = Math.min(Math.floor(this.timeToLogical(d.pts[1].t)), this.host.count() - 1);
    const hit = d.preview ? null : firstHit(lv, from, to, (i) => this.host.bar(i));
    const alpha = d.preview ? 0.2 : 0.16;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = c.up;
    ctx.fillRect(e.x, Math.min(e.y, t.y), w, Math.abs(t.y - e.y));
    ctx.fillStyle = c.down;
    ctx.fillRect(e.x, Math.min(e.y, s.y), w, Math.abs(s.y - e.y));
    ctx.globalAlpha = 1;
    const lastIdx = Math.min(to, this.host.count() - 1);
    const endIdx = hit ? hit.index : lastIdx;
    if (!d.preview && endIdx >= from) {
      // price path from the entry to the exit (or the latest revealed close)
      const ex = (this.host.chart.timeScale().logicalToCoordinate(endIdx as Logical) ?? x1) as number;
      const exitP = hit ? (hit.kind === 'tp' ? lv.tp : lv.sl) : this.host.bar(endIdx)?.c ?? lv.entry;
      const zoneY = this.y(exitP);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = (hit ? hit.kind === 'tp' : (lv.side === 'long' ? exitP >= lv.entry : exitP <= lv.entry)) ? c.up : c.down;
      ctx.fillRect(e.x, Math.min(e.y, zoneY), Math.max(0, Math.min(ex, x1) - e.x), Math.abs(zoneY - e.y));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.muted;
      ctx.setLineDash([4, 3]);
      line(ctx, e.x, e.y, Math.min(ex, x1), zoneY);
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    line(ctx, e.x, e.y, x1, e.y);
    const cx = e.x + w / 2;
    const money = (v: number) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const above = (y: number) => y - 5, below = (y: number) => y + 19;
    const tUp = t.y < e.y, sUp = s.y < e.y;
    if (calc) {
      this.label(cx, tUp ? above(t.y) : below(t.y), `Target ${lv.tp.toFixed(dg)} (${calc.tpPct.toFixed(2)}%) ${calc.tpPips.toFixed(1)} pips · ${money(calc.rewardUsd)}`, c.up, 'center');
      this.label(cx, sUp ? above(s.y) : below(s.y), `Stop ${lv.sl.toFixed(dg)} (${calc.slPct.toFixed(2)}%) ${calc.slPips.toFixed(1)} pips · ${money(-calc.riskUsd)}`, c.down, 'center');
      let mid = `${lv.side === 'long' ? 'Long' : 'Short'} · ${calc.lots.toFixed(2)} lots · R:R ${calc.rr.toFixed(2)}`;
      if (calc.invalid) mid = `${lv.side === 'long' ? 'Long' : 'Short'} · stop/target on the wrong side`;
      else if (hit) mid += hit.kind === 'tp' ? ` · Target hit ${money(calc.rewardUsd)}` : ` · Stop hit ${money(-calc.riskUsd)}`;
      else if (!d.preview && lastIdx >= from && env) {
        const close = this.host.bar(lastIdx)?.c;
        if (close != null) mid += ` · Open ${money((lv.side === 'long' ? 1 : -1) * env.value(close - lv.entry, calc.lots, close))}`;
      }
      this.label(cx, (tUp ? e.y + 19 : e.y - 5), mid, calc.invalid ? c.down : c.surface, 'center', calc.invalid ? '#fff' : c.text);
    }
  }

  private renderToolbar() {
    const d = this.selected;
    const tb = this.toolbar;
    if (!d || this.placing) {
      tb.classList.add('hidden');
      return;
    }
    const h = this.handles(d)[0];
    tb.classList.remove('hidden');
    tb.style.left = Math.max(4, Math.min(this.paneW() - 220, h.x + 12)) + 'px';
    tb.style.top = Math.max(4, Math.min(this.paneH() - 40, h.y - 44)) + 'px';
    const sig = d.id + d.color + d.type + (d.locked ? 'L' : '');
    if (tb.dataset.sig === sig) return;
    tb.dataset.sig = sig;
    const colors = ['#22c96a', '#5b93d6', '#1a9e93', '#e0605a', '#d4a24c', '#9085e9', '#8a8780'];
    tb.innerHTML =
      colors.map((c) => `<button class="sw${c === d.color ? ' on' : ''}" data-c="${c}" style="background:${c}" title="Color"></button>`).join('') +
      (isPosTool(d)
        ? `<button class="tb-btn primary" data-act="order" title="Place this as a real order (market, limit or stop is picked from the entry)">${d.type === 'long' ? 'Buy' : 'Sell'} this</button>` +
          `<button class="tb-btn" data-act="flip" title="Flip long ↔ short">⇅ Flip</button>` +
          `<button class="tb-btn" data-act="settings" title="Settings (double-click)">⚙</button>`
        : '') +
      `<button class="tb-btn${d.locked ? ' on' : ''}" data-act="lock" title="${d.locked ? 'Unlock' : 'Lock'}">${d.locked ? '🔒' : '🔓'}</button>` +
      `<button class="tb-btn" data-act="del" title="Delete (Del)">🗑</button>`;
    tb.onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.c) {
        d.color = b.dataset.c;
        this.host.changed();
      } else if (b.dataset.act === 'del') this.deleteSelected();
      else if (b.dataset.act === 'order') this.host.onPlaceFromTool?.(d);
      else if (b.dataset.act === 'flip') {
        flipDrawing(d);
        this.host.onEdit?.(d, true);
        this.host.changed();
      } else if (b.dataset.act === 'settings') this.host.onSettings?.(d);
      else if (b.dataset.act === 'lock') {
        d.locked = !d.locked;
        this.host.changed();
      }
    };
  }
}

/** Long ↔ short in place: mirror stop and target around the entry. */
export function flipDrawing(d: Drawing) {
  const e = d.pts[0].p;
  d.type = d.type === 'long' ? 'short' : 'long';
  d.pts[1].p = 2 * e - d.pts[1].p;
  d.pts[2].p = 2 * e - d.pts[2].p;
  d.color = d.type === 'long' ? '#1a9e93' : '#e0605a';
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function segDist(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function extendLine(a: { x: number; y: number }, b: { x: number; y: number }, W: number, both: boolean) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) < 1e-6) return [a, b];
  const k = dy / dx;
  const xr = dx > 0 ? W + 10 : -10;
  const end = { x: xr, y: a.y + k * (xr - a.x) };
  if (!both) return [a, end];
  const xl = dx > 0 ? -10 : W + 10;
  return [{ x: xl, y: a.y + k * (xl - a.x) }, end];
}
