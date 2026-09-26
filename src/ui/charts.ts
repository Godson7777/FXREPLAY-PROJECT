/**
 * Small dependency-free SVG charts for the analytics page.
 * Thin marks, recessive grid, one y-axis per chart, hover tooltips everywhere.
 */
const NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

let tip: HTMLDivElement | null = null;
export function showTip(e: MouseEvent, html: string) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    document.body.append(tip);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
export function hideTip() {
  if (tip) tip.style.display = 'none';
}

function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!isFinite(lo) || !isFinite(hi)) return [0];
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

/** Wraps a render function so it re-renders at the container's width. */
function responsive(height: number, draw: (root: SVGSVGElement, w: number, h: number) => void): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'viz';
  box.style.height = height + 'px';
  let lastW = 0;
  const render = () => {
    const w = Math.floor(box.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    box.innerHTML = '';
    const root = svg('svg', { width: w, height, viewBox: `0 0 ${w} ${height}`, role: 'img' });
    box.append(root);
    draw(root, w, height);
  };
  new ResizeObserver(render).observe(box);
  return box;
}

function axisY(root: SVGSVGElement, ticks: number[], y: (v: number) => number, x0: number, x1: number, fmt: (v: number) => string) {
  for (const t of ticks) {
    const yy = y(t);
    root.append(svg('line', { x1: x0, x2: x1, y1: yy, y2: yy, class: t === 0 ? 'zero' : 'gridline' }));
    const tx = svg('text', { x: x0 - 6, y: yy + 3.5, 'text-anchor': 'end', class: 'tick' });
    tx.textContent = fmt(t);
    root.append(tx);
  }
}

// ---- line / area -------------------------------------------------------------

export interface LineSeriesSpec {
  name: string;
  color: string; // CSS var reference or hex
  xs: number[];
  ys: number[];
  area?: boolean;
  dashed?: boolean;
  width?: number;
}

export function lineChart(opts: {
  series: LineSeriesSpec[];
  band?: { xs: number[]; lo: number[]; hi: number[]; color: string; opacity?: number }[];
  height?: number;
  yFmt: (v: number) => string;
  xFmt: (v: number) => string;
  baseline?: number;
  zeroArea?: boolean;
}) {
  const H = opts.height ?? 240;
  return responsive(H, (root, W) => {
    const m = { l: 64, r: 14, t: 12, b: 26 };
    const all = opts.series.flatMap((s) => s.ys).concat(opts.band?.flatMap((b) => [...b.lo, ...b.hi]) ?? []);
    const xsAll = opts.series.flatMap((s) => s.xs);
    if (!xsAll.length) return;
    let lo = Math.min(...all), hi = Math.max(...all);
    if (opts.baseline != null) (lo = Math.min(lo, opts.baseline)), (hi = Math.max(hi, opts.baseline));
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad;
    hi += pad;
    const xlo = Math.min(...xsAll), xhi = Math.max(...xsAll) || xlo + 1;
    const x = (v: number) => m.l + ((v - xlo) / (xhi - xlo || 1)) * (W - m.l - m.r);
    const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    axisY(root, niceTicks(lo, hi, 5), y, m.l, W - m.r, opts.yFmt);
    if (opts.baseline != null) root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(opts.baseline), y2: y(opts.baseline), class: 'baseline' }));
    // x labels
    const nx = Math.max(2, Math.floor((W - m.l - m.r) / 110));
    for (let i = 0; i <= nx; i++) {
      const v = xlo + ((xhi - xlo) * i) / nx;
      const t = svg('text', { x: x(v), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === nx ? 'end' : 'middle', class: 'tick' });
      t.textContent = opts.xFmt(v);
      root.append(t);
    }
    for (const b of opts.band ?? []) {
      let d = '';
      b.xs.forEach((xv, i) => (d += `${i ? 'L' : 'M'}${x(xv)},${y(b.hi[i])}`));
      for (let i = b.xs.length - 1; i >= 0; i--) d += `L${x(b.xs[i])},${y(b.lo[i])}`;
      root.append(svg('path', { d: d + 'Z', fill: b.color, opacity: b.opacity ?? 0.18 }));
    }
    for (const s of opts.series) {
      let d = '';
      s.xs.forEach((xv, i) => (d += `${i ? 'L' : 'M'}${x(xv).toFixed(1)},${y(s.ys[i]).toFixed(1)}`));
      if (s.area) {
        const base = y(opts.zeroArea ? 0 : Math.max(lo, Math.min(hi, opts.baseline ?? lo)));
        root.append(svg('path', { d: `${d}L${x(s.xs[s.xs.length - 1])},${base}L${x(s.xs[0])},${base}Z`, fill: s.color, opacity: 0.16 }));
      }
      root.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width ?? 2, 'stroke-linejoin': 'round', 'stroke-dasharray': s.dashed ? '5 4' : 'none' }));
    }
    // crosshair + tooltip
    const cross = svg('line', { y1: m.t, y2: H - m.b, class: 'crossline', visibility: 'hidden' });
    const dots = opts.series.map((s) => {
      const c = svg('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
      root.append(c);
      return c;
    });
    root.append(cross);
    const hit = svg('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
    root.append(hit);
    hit.addEventListener('mousemove', (e) => {
      const rect = root.getBoundingClientRect();
      const xv = xlo + ((e.clientX - rect.left - m.l) / (W - m.l - m.r)) * (xhi - xlo);
      const rows: string[] = [];
      let cx = 0;
      opts.series.forEach((s, si) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < s.xs.length; i++) {
          const d = Math.abs(s.xs[i] - xv);
          if (d < bd) (bd = d), (bi = i);
        }
        cx = x(s.xs[bi]);
        dots[si].setAttribute('cx', String(cx));
        dots[si].setAttribute('cy', String(y(s.ys[bi])));
        dots[si].setAttribute('visibility', 'visible');
        rows.push(`<div><i style="background:${s.color}"></i>${s.name}<b>${opts.yFmt(s.ys[bi])}</b></div>`);
        if (si === 0) rows.unshift(`<div class="tt-h">${opts.xFmt(s.xs[bi])}</div>`);
      });
      cross.setAttribute('x1', String(cx));
      cross.setAttribute('x2', String(cx));
      cross.setAttribute('visibility', 'visible');
      showTip(e, rows.join(''));
    });
    hit.addEventListener('mouseleave', () => {
      hideTip();
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    });
  });
}

// ---- bars -------------------------------------------------------------------

export interface BarItem {
  label: string;
  value: number;
  tip?: string;
  color?: string;
}

export function barChart(opts: { items: BarItem[]; height?: number; yFmt: (v: number) => string; posColor?: string; negColor?: string; showValues?: boolean }) {
  const H = opts.height ?? 220;
  return responsive(H, (root, W) => {
    const items = opts.items;
    if (!items.length) return;
    const m = { l: 60, r: 10, t: 16, b: 34 };
    let lo = Math.min(0, ...items.map((i) => i.value)), hi = Math.max(0, ...items.map((i) => i.value));
    const pad = (hi - lo) * 0.1 || 1;
    if (hi > 0) hi += pad;
    if (lo < 0) lo -= pad;
    const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    axisY(root, niceTicks(lo, hi, 4), y, m.l, W - m.r, opts.yFmt);
    const bw = (W - m.l - m.r) / items.length;
    const gap = Math.max(2, Math.min(bw * 0.28, 18));
    const labelEvery = Math.ceil(items.length / Math.max(1, Math.floor((W - m.l - m.r) / 38)));
    items.forEach((it, i) => {
      const w = Math.max(1, Math.min(bw - gap, 64));
      const x0 = m.l + i * bw + (bw - w) / 2;
      const y0 = y(Math.max(0, it.value)), y1 = y(Math.min(0, it.value));
      const color = it.color ?? (it.value >= 0 ? opts.posColor ?? 'var(--good)' : opts.negColor ?? 'var(--bad)');
      const hgt = Math.max(1, y1 - y0);
      const r = Math.min(4, w / 2, hgt);
      // rounded at the data end only, flat at the baseline
      const d = it.value >= 0
        ? `M${x0},${y1}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${y1}Z`
        : `M${x0},${y0}V${y1 - r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + w - r}Q${x0 + w},${y1} ${x0 + w},${y1 - r}V${y0}Z`;
      root.append(svg('path', { d, fill: color }));
      if (opts.showValues && items.length <= 12 && it.value !== 0) {
        const t = svg('text', { x: x0 + w / 2, y: it.value >= 0 ? y0 - 4 : y1 + 11, 'text-anchor': 'middle', class: 'val' });
        t.textContent = opts.yFmt(it.value);
        root.append(t);
      }
      if (i % labelEvery === 0) {
        const t = svg('text', { x: x0 + w / 2, y: H - 14, 'text-anchor': 'middle', class: 'tick' });
        t.textContent = it.label;
        root.append(t);
      }
      const hitR = svg('rect', { x: m.l + i * bw, y: m.t, width: bw, height: H - m.t - m.b, fill: 'transparent' });
      hitR.addEventListener('mousemove', (e) => showTip(e, `<div class="tt-h">${it.label}</div>${it.tip ?? `<b>${opts.yFmt(it.value)}</b>`}`));
      hitR.addEventListener('mouseleave', hideTip);
      root.append(hitR);
    });
  });
}

// ---- scatter -------------------------------------------------------------------

export interface ScatterPt {
  x: number;
  y: number;
  color: string;
  tip: string;
}

export function scatter(opts: { points: ScatterPt[]; height?: number; xFmt: (v: number) => string; yFmt: (v: number) => string; xLabel: string; yLabel: string; diagonal?: boolean }) {
  const H = opts.height ?? 260;
  return responsive(H, (root, W) => {
    const P = opts.points;
    if (!P.length) return;
    const m = { l: 56, r: 14, t: 12, b: 38 };
    let xlo = Math.min(0, ...P.map((p) => p.x)), xhi = Math.max(...P.map((p) => p.x));
    let ylo = Math.min(0, ...P.map((p) => p.y)), yhi = Math.max(...P.map((p) => p.y));
    xhi += (xhi - xlo) * 0.05 || 1;
    yhi += (yhi - ylo) * 0.05 || 1;
    const x = (v: number) => m.l + ((v - xlo) / (xhi - xlo)) * (W - m.l - m.r);
    const y = (v: number) => m.t + (1 - (v - ylo) / (yhi - ylo)) * (H - m.t - m.b);
    axisY(root, niceTicks(ylo, yhi, 4), y, m.l, W - m.r, opts.yFmt);
    for (const t of niceTicks(xlo, xhi, Math.max(3, Math.floor(W / 90)))) {
      const tx = svg('text', { x: x(t), y: H - 22, 'text-anchor': 'middle', class: 'tick' });
      tx.textContent = opts.xFmt(t);
      root.append(tx);
    }
    const xl = svg('text', { x: (W + m.l) / 2, y: H - 4, 'text-anchor': 'middle', class: 'axis-label' });
    xl.textContent = opts.xLabel;
    const yl = svg('text', { x: 12, y: (H - m.b) / 2, 'text-anchor': 'middle', class: 'axis-label', transform: `rotate(-90 12 ${(H - m.b) / 2})` });
    yl.textContent = opts.yLabel;
    root.append(xl, yl);
    if (opts.diagonal) {
      const e = Math.min(xhi, yhi);
      root.append(svg('line', { x1: x(0), y1: y(0), x2: x(e), y2: y(e), class: 'baseline' }));
    }
    for (const p of P) {
      const c = svg('circle', { cx: x(p.x), cy: y(p.y), r: 4.5, fill: p.color, stroke: 'var(--surface)', 'stroke-width': 1.5, opacity: 0.9 });
      c.addEventListener('mousemove', (e) => showTip(e, p.tip));
      c.addEventListener('mouseleave', hideTip);
      root.append(c);
    }
  });
}
