import { h } from './dom';
import { showTip, hideTip } from './charts';
import type { GroupStats } from '../analytics/report';
import { TRENDS, TREND_LABEL, VOLS, VOL_LABEL, type Trend, type Vol } from '../analytics/regime';

/** Small building blocks shared by the analytics, strategy and leaderboard pages. */

export function kpi(label: string, value: string, c: string, sub: string, title = '') {
  return h('div', { class: 'kpi', title: title || null }, h('span', {}, label), h('b', { class: c }, value), h('small', {}, sub));
}

export function stat(label: string, value: string, c = '', title = '') {
  return h('div', { class: 'stat', title: title || null }, h('span', {}, label), h('b', { class: c }, value));
}

export const statsGrid = (...items: (HTMLElement | null)[]) => h('div', { class: 'stats-grid' }, ...items);

export function compactMoney(v: number) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : a >= 1e3 ? (a / 1e3).toFixed(2) + 'k' : a.toFixed(0);
  return `${v < 0 ? '−' : ''}$${s}`;
}

export const fmtP = (p: number | null | undefined) => (p == null ? '—' : p < 0.001 ? '< 0.001' : p.toFixed(3));

export function signedUnit(v: number | null | undefined, unit: string, d = 2) {
  if (v == null || !isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)} ${unit}`;
}

/** Horizontal bars, scaled to the largest absolute value. */
export function hbars(items: { label: string; value: number; display: string; color: string; title?: string }[]) {
  const max = Math.max(1e-12, ...items.map((i) => Math.abs(i.value)));
  return h('div', { class: 'hbars' }, ...items.map((i) =>
    h('div', { class: 'hbar', title: i.title || null },
      h('span', {}, i.label),
      h('div', { class: 'track' }, h('i', { style: `width:${Math.max(i.value ? 1.5 : 0, (Math.abs(i.value) / max) * 100).toFixed(1)}%;background:${i.color}` })),
      h('b', {}, i.display))));
}

/** Stacked 100% bar with a legend. */
export function stackBar(parts: { label: string; value: number; color: string }[]) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return h('div', { class: 'stack' },
    h('div', { class: 'stackbar', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ') },
      ...parts.map((p) => h('i', { style: `width:${((p.value / total) * 100).toFixed(2)}%;background:${p.color}`, title: `${p.label}: ${((p.value / total) * 100).toFixed(1)}%` }))),
    h('div', { class: 'legend' }, ...parts.map((p) => h('span', {}, h('i', { style: `background:${p.color}` }), `${p.label} ${((p.value / total) * 100).toFixed(1)}%`))));
}

/** Trend × volatility heatmap of expectancy. */
export function heatmap(matrix: Record<Trend, Record<Vol, GroupStats | null>>, unit: string) {
  const cells = TRENDS.flatMap((t) => VOLS.map((v) => matrix[t][v])).filter((g): g is GroupStats => g != null && g.trades > 0);
  const maxAbs = Math.max(0.05, ...cells.map((g) => Math.abs(g.exp ?? 0)));
  const grid = h('div', { class: 'heat', role: 'table', 'aria-label': 'Expectancy by trend and volatility' },
    h('div', { class: 'h' }),
    ...VOLS.map((v) => h('div', { class: 'h col' }, VOL_LABEL[v].replace(' volatility', ' vol.'))));
  for (const t of TRENDS) {
    grid.append(h('div', { class: 'h' }, TREND_LABEL[t]));
    for (const v of VOLS) {
      const g = matrix[t][v];
      if (!g || !g.trades) {
        grid.append(h('div', { class: 'cell na' }, h('b', {}, '—'), h('small', {}, 'no trades')));
        continue;
      }
      const e = g.exp ?? 0;
      const cell = h('div', { class: `cell ${e > 0 ? 'pos' : e < 0 ? 'neg' : ''}` }, h('b', {}, signedUnit(e, unit)), h('small', {}, `${g.trades} trade${g.trades === 1 ? '' : 's'} · ${Math.round(g.winRate * 100)}% win`));
      cell.style.setProperty('--a', (0.1 + 0.32 * Math.min(1, Math.abs(e) / maxAbs) * Math.min(1, g.trades / 10)).toFixed(2));
      cell.addEventListener('mousemove', (ev) => showTip(ev, `<div class="tt-h">${TREND_LABEL[t]} · ${VOL_LABEL[v]}</div><div>Trades <b>${g.trades}</b></div><div>Expectancy <b>${signedUnit(e, unit)}</b></div><div>Win rate <b>${Math.round(g.winRate * 100)}%</b></div>`));
      cell.addEventListener('mouseleave', hideTip);
      grid.append(cell);
    }
  }
  return h('div', { class: 'table-wrap' }, grid);
}

const NS = 'http://www.w3.org/2000/svg';
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Confidence interval drawn against zero. */
export function ciChart(lo: number, mid: number, hi: number, unit: string) {
  const box = h('div', { class: 'viz ci-wrap' });
  const draw = () => {
    const W = Math.max(240, Math.floor(box.clientWidth || 480));
    const H = 86;
    box.innerHTML = '';
    const span = Math.max(Math.abs(lo), Math.abs(hi), 0.05) * 1.25;
    const minX = Math.min(-span * 0.35, lo - span * 0.1), maxX = Math.max(span * 0.35, hi + span * 0.1);
    const m = { l: 12, r: 12 };
    const x = (v: number) => m.l + ((v - minX) / (maxX - minX)) * (W - m.l - m.r);
    const root = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `95% confidence interval from ${lo.toFixed(2)} to ${hi.toFixed(2)} ${unit}` });
    root.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: 44, y2: 44, class: 'gridline' }));
    root.append(svgEl('line', { x1: x(0), x2: x(0), y1: 16, y2: 70, class: 'zero' }));
    const t0 = svgEl('text', { x: x(0), y: 84, 'text-anchor': 'middle', class: 'tick' });
    t0.textContent = `0 ${unit}`;
    root.append(t0);
    const good = lo > 0;
    const color = good ? 'var(--good)' : hi < 0 ? 'var(--bad)' : 'var(--warn)';
    root.append(svgEl('rect', { x: x(lo), y: 36, width: Math.max(2, x(hi) - x(lo)), height: 16, rx: 2, fill: color, opacity: 0.28 }));
    root.append(svgEl('line', { x1: x(lo), x2: x(lo), y1: 32, y2: 56, stroke: color, 'stroke-width': 2 }));
    root.append(svgEl('line', { x1: x(hi), x2: x(hi), y1: 32, y2: 56, stroke: color, 'stroke-width': 2 }));
    root.append(svgEl('circle', { cx: x(mid), cy: 44, r: 5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }));
    const lab = (v: number, s: string, anchor: string) => {
      const t = svgEl('text', { x: x(v), y: 24, 'text-anchor': anchor, class: 'val' });
      t.textContent = s;
      root.append(t);
    };
    const sgn = (v: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(2)}`;
    lab(lo, sgn(lo), 'end');
    lab(hi, sgn(hi), 'start');
    const tm = svgEl('text', { x: x(mid), y: 72, 'text-anchor': 'middle', class: 'lbl' });
    tm.textContent = `${mid >= 0 ? '+' : '−'}${Math.abs(mid).toFixed(2)} ${unit}`;
    root.append(tm);
    box.append(root);
  };
  let lastW = 0;
  new ResizeObserver(() => {
    const w = Math.floor(box.clientWidth);
    if (w && w !== lastW) {
      lastW = w;
      draw();
    }
  }).observe(box);
  return box;
}

export const pctTxt = (x: number | null | undefined, d = 1, signed = false) => {
  if (x == null || !isFinite(x)) return '—';
  return `${x < 0 ? '−' : signed && x > 0 ? '+' : ''}${Math.abs(x * 100).toFixed(d)}%`;
};

export const daysTxt = (d: number) => `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
