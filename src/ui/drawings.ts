import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts';

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
}

type Hit = { d: Drawing; handle: number | -1 } | { line: DragLine };

export class DrawingLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tool: DrawingType | 'cursor' = 'cursor';
  magnet = true;
  selected: Drawing | null = null;
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
        this.selected = hit.d;
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
      const pt = this.toPt(x, y);
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
    if (dr.moved) this.host.changed();
    this.schedule();
  };

  private onDbl = (e: MouseEvent) => {
    const { x, y } = this.local(e);
    const hit = this.hitTest(x, y);
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
    const arr = this.host.drawings();
    const sel = this.selected;
    if (sel) {
      const hs = this.handles(sel);
      for (let i = 0; i < hs.length; i++) if (Math.hypot(hs[i].x - x, hs[i].y - y) < 8) return { d: sel, handle: i };
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
    for (const d of this.host.drawings()) this.drawOne(d, d === this.selected || d === this.placing);
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

  private label(x: number, y: number, text: string, bg: string, align: 'left' | 'right' | 'center' = 'left') {
    const ctx = this.ctx;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 8;
    const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    ctx.fillStyle = bg;
    roundRect(ctx, x0, y - 14, w, 17, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
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
      case 'short': {
        const [e, s, t] = P;
        const x1 = P[1].x;
        const w = x1 - e.x;
        ctx.fillStyle = 'rgba(26,158,147,0.22)';
        ctx.fillRect(e.x, Math.min(e.y, t.y), w, Math.abs(t.y - e.y));
        ctx.fillStyle = 'rgba(224,96,90,0.22)';
        ctx.fillRect(e.x, Math.min(e.y, s.y), w, Math.abs(s.y - e.y));
        ctx.strokeStyle = '#8a8f98';
        ctx.lineWidth = 1;
        line(ctx, e.x, e.y, x1, e.y);
        const risk = Math.abs(d.pts[0].p - d.pts[1].p), rew = Math.abs(d.pts[2].p - d.pts[0].p);
        const pip = this.host.pipSize();
        const rr = risk ? rew / risk : 0;
        this.label(e.x + w / 2, t.y + (d.type === 'long' ? -4 : 18), `Target ${(rew / pip).toFixed(1)} pips`, '#13776f', 'center');
        this.label(e.x + w / 2, s.y + (d.type === 'long' ? 18 : -4), `Stop ${(risk / pip).toFixed(1)} pips`, '#b8443b', 'center');
        this.label(e.x + w / 2, e.y - 3, `${d.type === 'long' ? 'Long' : 'Short'}  R:R ${rr.toFixed(2)}`, '#57564f', 'center');
        break;
      }
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
    const sig = d.id + d.color;
    if (tb.dataset.sig === sig) return;
    tb.dataset.sig = sig;
    const colors = ['#22c96a', '#5b93d6', '#1a9e93', '#e0605a', '#d4a24c', '#9085e9', '#8a8780'];
    tb.innerHTML =
      colors.map((c) => `<button class="sw${c === d.color ? ' on' : ''}" data-c="${c}" style="background:${c}" title="Color"></button>`).join('') +
      (d.type === 'long' || d.type === 'short' ? `<button class="tb-btn" data-act="order" title="Place this as a real order">Place order</button>` : '') +
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
    };
  }
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
