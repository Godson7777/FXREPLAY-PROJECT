import { h } from './dom';
import { IDEAL, type IdealKind } from '../analytics/ideal';
import type { ExplainId } from '../analytics/explain';

/**
 * Mini drawings for the "How to read" guides: the ideal picture next to a weak one.
 * Each drawing is a 120×64 SVG that takes its colours from CSS (classes g/b/m/ax),
 * so it follows the theme and the dark band.
 */
const W = 120, H = 64;
const n = (v: number) => +v.toFixed(1);
const line = (pts: number[][], c: string, extra = '') => `<polyline class="${c}" fill="none" points="${pts.map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" ${extra}/>`;
const rect = (x: number, y: number, w: number, hh: number, c: string, rx = 1.5) => `<rect class="${c} f" x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, hh))}" rx="${rx}"/>`;
const dot = (x: number, y: number, c: string, r = 2.4) => `<circle class="${c} f" cx="${n(x)}" cy="${n(y)}" r="${r}"/>`;
const axis = (y: number, dash = false) => `<line class="ax" x1="4" x2="${W - 4}" y1="${n(y)}" y2="${n(y)}"${dash ? ' stroke-dasharray="3 3"' : ''}/>`;
const vline = (x: number, dash = true) => `<line class="ax" x1="${n(x)}" x2="${n(x)}" y1="6" y2="${H - 6}"${dash ? ' stroke-dasharray="3 3"' : ''}/>`;
const text = (x: number, y: number, s: string, c = 'm') => `<text class="${c} t" x="${n(x)}" y="${n(y)}" text-anchor="middle">${s}</text>`;
const tick = (x: number, y: number) => line([[x - 3, y], [x - 0.8, y + 2.4], [x + 3.4, y - 2.8]], 'g', 'stroke-width="1.8"');
const cross = (x: number, y: number) => line([[x - 2.6, y - 2.6], [x + 2.6, y + 2.6]], 'b', 'stroke-width="1.8"') + line([[x + 2.6, y - 2.6], [x - 2.6, y + 2.6]], 'b', 'stroke-width="1.8"');

/** bars from a baseline: positive values go up (green), negative down (red) */
function bars(vals: number[], base: number, scale: number, o: { x0?: number; x1?: number; color?: (v: number, i: number) => string } = {}) {
  const x0 = o.x0 ?? 10, x1 = o.x1 ?? W - 10, step = (x1 - x0) / vals.length, bw = step * 0.62;
  return vals.map((v, i) => {
    const hh = Math.abs(v) * scale;
    return rect(x0 + i * step + (step - bw) / 2, v >= 0 ? base - hh : base, bw, hh, o.color ? o.color(v, i) : v >= 0 ? 'g' : 'b');
  }).join('');
}

function gauge(pos: number, c: string) {
  const cx = W / 2, cy = 52, r = 36;
  const pt = (f: number, rr = r) => [cx - rr * Math.cos(Math.PI * f), cy - rr * Math.sin(Math.PI * f)];
  const arc = (a: number, b: number, cls: string) => {
    const [x1, y1] = pt(a), [x2, y2] = pt(b);
    return `<path class="${cls}" fill="none" stroke-width="6" stroke-linecap="butt" d="M${n(x1)} ${n(y1)} A${r} ${r} 0 0 1 ${n(x2)} ${n(y2)}"/>`;
  };
  const [nx, ny] = pt(pos, r - 9);
  return arc(0, 0.5, 'b soft') + arc(0.5, 0.75, 'w soft') + arc(0.75, 1, 'g soft') + line([[cx, cy], [nx, ny]], c, 'stroke-width="2.2" stroke-linecap="round"') + dot(cx, cy, c, 3);
}

function grid(cells: string[], cols: number, x0 = 14, y0 = 8, cw = 13, ch = 11, gap = 2.5) {
  return cells.map((c, i) => rect(x0 + (i % cols) * (cw + gap), y0 + Math.floor(i / cols) * (ch + gap), cw, ch, c, 2)).join('');
}

function hist(vals: number[], colors: string[], markAt?: number) {
  const step = (W - 16) / vals.length;
  return axis(56) + vals.map((v, i) => rect(8 + i * step + 1, 56 - v, step - 2, v, colors[i])).join('') + (markAt != null ? vline(8 + markAt * step) : '');
}

function scatter(pts: [number, number, string][], diagonal = true) {
  return axis(58) + `<line class="ax" x1="8" x2="8" y1="6" y2="58"/>` + (diagonal ? `<line class="ax" x1="8" y1="58" x2="${W - 10}" y2="8" stroke-dasharray="3 3"/>` : '') + pts.map(([x, y, c]) => dot(x, y, c, 2.2)).join('');
}

function fan(lowEnd: number) {
  const band = (a: number, b: number, cls: string) => `<path class="${cls} f" d="M8 40 L${W - 8} ${a} L${W - 8} ${b} Z"/>`;
  return axis(40, true) + band(8, lowEnd, 'g soft') + band(16, Math.min(lowEnd, (lowEnd + 22) / 2), 'g mid') + line([[8, 40], [W - 8, 22]], 'g', 'stroke-width="1.8"') + line([[8, 40], [W - 8, lowEnd]], lowEnd > 40 ? 'b' : 'g', 'stroke-dasharray="3 2"');
}

const rows = (cells: [string, number][], hi = -1) =>
  cells.map(([c, w], i) => (i === hi ? `<rect class="g soft f" x="6" y="${6 + i * 13.5}" width="${W - 12}" height="11.5" rx="2"/>` : '') + rect(12, 9.5 + i * 13.5, 18, 4.5, 'm', 2) + rect(40, 9.5 + i * 13.5, w, 4.5, c, 2)).join('');

type Pair = [good: string, bad: string];

const DRAW: Record<IdealKind, () => Pair> = {
  gauge: () => [gauge(0.88, 'g'), gauge(0.22, 'b')],
  bars: () => [axis(56) + bars([40, 44, 38, 42, 45, 39, 41], 56, 1), axis(56) + bars([42, 40, 9, 44, 38, 41, 43], 56, 1, { color: (v) => (v < 20 ? 'b' : 'g') })],
  checklist: () => {
    const row = (y: number, ok: boolean) => (ok ? tick(18, y) : cross(18, y)) + rect(30, y - 2.5, ok ? 70 : 58, 5, 'm', 2.5);
    return [row(14, true) + row(32, true) + row(50, true), row(14, true) + row(32, false) + row(50, false)];
  },
  tiles: () => {
    const tile = (x: number, c: string, up: boolean) => `<rect class="ax" fill="none" x="${x}" y="12" width="32" height="40" rx="3"/>` + rect(x + 6, 19, 14, 3.5, 'm', 1.5) + rect(x + 6, 29, 20, 7, c, 2) + line(up ? [[x + 6, 46], [x + 14, 43], [x + 26, 40]] : [[x + 6, 40], [x + 14, 43], [x + 26, 46]], c);
    return [tile(6, 'g', true) + tile(44, 'g', true) + tile(82, 'g', true), tile(6, 'g', true) + tile(44, 'b', false) + tile(82, 'b', false)];
  },
  line: () => [
    axis(58) + line([[8, 54], [22, 48], [30, 49], [44, 40], [54, 41], [68, 31], [78, 32], [92, 22], [100, 23], [112, 12]], 'g', 'stroke-width="2"'),
    axis(58) + line([[8, 50], [24, 52], [38, 47], [52, 53], [66, 49], [76, 52], [80, 18], [92, 22], [102, 19], [112, 23]], 'b', 'stroke-width="2"'),
  ],
  underwater: () => {
    const area = (pts: number[][], c: string) => `<path class="${c} soft f" d="M8 12 ${pts.map((p) => `L${p[0]} ${p[1]}`).join(' ')} L${W - 8} 12 Z"/>` + line([[8, 12], ...pts, [W - 8, 12]], c, 'stroke-width="1.6"');
    return [axis(12) + area([[20, 20], [30, 12], [46, 24], [58, 12], [74, 18], [84, 12], [98, 22], [106, 13]], 'g'), axis(12) + area([[18, 22], [32, 44], [50, 56], [70, 50], [88, 40], [104, 26]], 'b')];
  },
  payoff: () => [axis(32) + rect(30, 8, 22, 24, 'g') + rect(68, 32, 22, 11, 'b') + text(41, 62, 'avg win', 'm') + text(79, 62, 'avg loss', 'm'), axis(32) + rect(30, 23, 22, 9, 'g') + rect(68, 32, 22, 22, 'b') + text(41, 62, 'avg win', 'm') + text(79, 62, 'avg loss', 'm')],
  hist: () => [
    hist([0, 0, 0, 34, 6, 10, 14, 11, 8, 6, 4], ['b', 'b', 'b', 'b', 'g', 'g', 'g', 'g', 'g', 'g', 'g'], 3) + text(34, 9, '−1R'),
    hist([6, 9, 12, 24, 14, 12, 7, 3, 1, 0, 0], ['b', 'b', 'b', 'b', 'g', 'g', 'g', 'g', 'g', 'g', 'g'], 3) + text(34, 9, '−1R'),
  ],
  streak: () => {
    const seq = (s: string) => [...s].map((ch, i) => dot(10 + i * 7.4, 32, ch === 'w' ? 'g' : 'b', 2.8)).join('');
    return [seq('wllwlwllwwlwllw'), seq('wlwwlllllllllwl')];
  },
  monthPair: () => [axis(40) + rect(28, 12, 24, 28, 'g') + rect(68, 40, 24, 12, 'b') + text(40, 62, 'avg') + text(80, 62, 'worst'), axis(26) + rect(28, 14, 24, 12, 'g') + rect(68, 26, 24, 30, 'b') + text(40, 62, 'avg') + text(80, 62, 'worst')],
  monthGrid: () => [grid('g g g b g g g g g b g g g g g g g g b g g g g g'.split(' ').map((c, i) => (c === 'g' ? (i % 3 ? 'g mid' : 'g') : 'b mid')), 6), grid('g g m g m g b b b b g m g m g g g g b b b m g g'.split(' ').map((c) => (c === 'm' ? 'm soft' : c)), 6)],
  zeroLine: () => [
    axis(44, true) + line([[8, 30], [22, 24], [36, 28], [50, 20], [64, 26], [78, 18], [92, 24], [112, 20]], 'g', 'stroke-width="2"') + text(104, 54, 'zero'),
    axis(30, true) + line([[8, 12], [22, 16], [36, 14], [50, 22], [64, 28], [78, 36], [92, 46], [112, 54]], 'b', 'stroke-width="2"') + text(20, 42, 'zero'),
  ],
  halves: () => [axis(52) + rect(26, 16, 26, 36, 'g') + rect(68, 20, 26, 32, 'g'), axis(40) + rect(26, 10, 26, 30, 'g') + rect(68, 40, 26, 14, 'b')],
  regimeBars: () => [axis(48) + bars([30, 24, 20], 48, 1, { x0: 16, x1: W - 16 }), axis(34) + bars([24, 16, -20], 34, 1, { x0: 16, x1: W - 16 })],
  regimeGrid: () => [grid(['g', 'g mid', 'g', 'g mid', 'g', 'g mid', 'g', 'g mid', 'g soft'], 3, 24, 6, 22, 15, 3), grid(['g', 'g mid', 'b', 'g mid', 'b', 'b mid', 'g', 'm soft', 'b'], 3, 24, 6, 22, 15, 3)],
  interval: () => {
    const ci = (a: number, b: number, c: string) => axis(32) + vline(40, true) + text(40, 60, '0') + line([[a, 32], [b, 32]], c, 'stroke-width="5" stroke-linecap="round" opacity=".45"') + dot((a + b) / 2, 32, c, 4);
    return [ci(56, 104, 'g'), ci(18, 84, 'b')];
  },
  costBars: () => [axis(48) + bars([36, 28, 20], 48, 1, { x0: 16, x1: W - 16 }) + text(32, 60, 'now') + text(60, 60, '+1') + text(88, 60, '+2'), axis(34) + bars([22, -6, -18], 34, 1, { x0: 16, x1: W - 16 }) + text(32, 60, 'now') + text(60, 60, '+1') + text(88, 60, '+2')],
  fan: () => [fan(34), fan(54)],
  ddHist: () => [hist([30, 38, 22, 10, 4, 1, 0, 0, 0, 0], ['g', 'g', 'g', 'g', 'w', 'w', 'b', 'b', 'b', 'b']), hist([6, 12, 20, 26, 24, 20, 16, 12, 8, 5], ['g', 'g', 'g', 'w', 'w', 'b', 'b', 'b', 'b', 'b'])],
  ruin: () => {
    const meter = (f: number, c: string) => `<rect class="ax" fill="none" x="12" y="24" width="96" height="14" rx="7"/>` + rect(14, 26, 92 * f, 10, c, 5) + text(60, 54, `${Math.round(f * 100)}%`, c);
    return [meter(0.03, 'g'), meter(0.62, 'b')];
  },
  sizing: () => [rows([['g', 22], ['g', 38], ['g', 52], ['w', 44]], 1), rows([['g', 22], ['g', 38], ['w', 44], ['b', 30]], 3).replace('class="g soft f"', 'class="b soft f"')],
  scatter: () => [
    scatter([[20, 46, 'g'], [26, 30, 'g'], [18, 20, 'g'], [30, 14, 'g'], [24, 38, 'g'], [84, 52, 'b'], [92, 54, 'b'], [78, 50, 'b']], false) + text(60, 9, 'MFE ↑ · MAE →'),
    scatter([[70, 22, 'g'], [88, 34, 'g'], [60, 16, 'g'], [82, 28, 'b'], [96, 24, 'b'], [90, 36, 'b'], [76, 30, 'b']], false) + text(60, 9, 'MFE ↑ · MAE →'),
  ],
  capture: () => [scatter([[30, 42, 'g'], [46, 30, 'g'], [62, 22, 'g'], [78, 15, 'g'], [94, 10, 'g'], [22, 50, 'g']]), scatter([[30, 52, 'b'], [46, 48, 'b'], [62, 50, 'b'], [78, 42, 'b'], [94, 46, 'b'], [54, 38, 'g']])],
  hold: () => {
    const bar = (y: number, w: number, c: string, lbl: string) => rect(34, y, w, 9, c, 2) + `<text class="m t" x="30" y="${y + 7.5}" text-anchor="end">${lbl}</text>`;
    return [bar(16, 72, 'g', 'win') + bar(38, 24, 'b', 'loss'), bar(16, 22, 'g', 'win') + bar(38, 74, 'b', 'loss')];
  },
  log: () => {
    const row = (y: number, tags: boolean) => rect(8, y, 24, 5, 'm', 2.5) + rect(38, y, 16, 5, 'm', 2.5) + (tags ? rect(62, y - 1.5, 20, 8, 'g mid', 4) + rect(86, y - 1.5, 24, 8, 'g soft', 4) : `<rect class="ax" fill="none" stroke-dasharray="2 2" x="62" y="${y - 1.5}" width="48" height="8" rx="4"/>`);
    return [row(12, true) + row(29, true) + row(46, true), row(12, false) + row(29, false) + row(46, false)];
  },
};

function fig(svg: string, tone: 'good' | 'bad', label: string, cap: string) {
  const box = h('div', { class: 'iv-svg' });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}: ${cap.replace(/"/g, '')}">${svg}</svg>`;
  return h('figure', { class: `iv-fig ${tone}` }, box, h('figcaption', {}, h('b', {}, label), cap));
}

export function idealSvg(kind: IdealKind): Pair {
  return DRAW[kind]();
}

/** "Ideal looks like this" block for one guide: ideal vs weak drawing and why it is ideal. */
export function idealVisual(id: ExplainId) {
  const d = IDEAL[id];
  const [good, bad] = DRAW[d.kind]();
  return h('div', { class: 'how-ideal' },
    h('div', { class: 'iv-pair' }, fig(good, 'good', 'Ideal', d.good), fig(bad, 'bad', 'Weak', d.bad)),
    h('div', { class: 'iv-why' }, h('h6', {}, 'Why this is ideal'), h('p', {}, d.why)));
}
