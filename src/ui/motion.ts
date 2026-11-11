/**
 * Small motion helpers shared by the landing page, analytics and the workspace.
 * Everything is skipped when the visitor prefers reduced motion: the final state
 * is written at once, so nothing depends on an animation having run.
 */
export const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const seenFns = new WeakMap<Element, () => void>();
let io: IntersectionObserver | null = null;
function observer() {
  if (io || typeof IntersectionObserver !== 'function') return io;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io!.unobserve(e.target);
      const fn = seenFns.get(e.target);
      seenFns.delete(e.target);
      fn?.();
    }
  }, { threshold: 0.01 });
  return io;
}

/** Run `fn` once, the first time `el` scrolls into view (at once when motion is reduced). */
export function onSeen(el: Element, fn: () => void) {
  const o = reduced() ? null : observer();
  if (!o) return fn();
  seenFns.set(el, fn);
  o.observe(el);
}

/** Fade + rise when the element enters the viewport. */
export function reveal<T extends HTMLElement>(el: T, delay = 0): T {
  if (reduced() || !observer()) return el;
  el.classList.add('rv');
  if (delay) el.style.setProperty('--rv-d', `${delay}ms`);
  onSeen(el, () => {
    el.classList.add('in');
    // drop the classes afterwards so the transform never interferes with sticky or fixed children
    setTimeout(() => { el.classList.remove('rv', 'in'); el.style.removeProperty('--rv-d'); }, 900 + delay);
  });
  return el;
}

/** Reveal several elements one after the other. */
export function revealAll(els: Iterable<Element>, step = 70, max = 420) {
  let i = 0;
  for (const el of els) reveal(el as HTMLElement, Math.min(max, i++ * step));
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Parts of a formatted number such as "+$58,416.91", "33.1%" or "−7.8%". */
export function splitNumber(text: string) {
  const m = /[\d,]*\d(\.\d+)?/.exec(text);
  if (!m) return null;
  const value = parseFloat(m[0].replace(/,/g, ''));
  if (!isFinite(value)) return null;
  return { pre: text.slice(0, m.index), post: text.slice(m.index + m[0].length), value, decimals: m[1] ? m[1].length - 1 : 0, grouped: m[0].includes(',') };
}

export function formatNumber(v: number, decimals: number, grouped: boolean) {
  return grouped ? v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : v.toFixed(decimals);
}

/**
 * Count the first number inside the element's text up from zero to its value, keeping
 * the prefix, suffix, decimals and thousands separators. The element must hold text only.
 */
export function countUpText(el: HTMLElement, ms = 900, delay = 0) {
  const final = el.textContent ?? '';
  const p = splitNumber(final);
  if (!p || reduced() || el.childElementCount) return;
  const draw = (t: number) => (el.textContent = `${p.pre}${formatNumber(p.value * t, p.decimals, p.grouped)}${p.post}`);
  // the real value stays in place until the element is on screen, so text that is never
  // scrolled to (print, copy, search) is always correct
  onSeen(el, () => {
    draw(0);
    const t0 = performance.now() + delay;
    const step = (now: number) => {
      if (!el.isConnected) return;
      const t = Math.min(1, Math.max(0, (now - t0) / ms));
      if (t >= 1) return void (el.textContent = final);
      draw(ease(t));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Brief green/red flash, restartable. Uses the Web Animations API so it needs no
 * forced layout (this runs on every price change) and survives in-place DOM updates.
 */
export function flash(el: Element, dir: 'up' | 'dn') {
  if (reduced() || typeof el.animate !== 'function') return;
  const c = dir === 'up' ? '#39db7f' : '#ff8a8f';
  el.animate([{ color: c, textShadow: `0 0 12px ${c}` }, {}], { duration: 450, easing: 'ease-out' });
}

const NS = 'http://www.w3.org/2000/svg';

/**
 * A ring that fills to `score` out of 100 around whatever is placed inside it.
 * The stroke colour comes from CSS (`.ring-fg`), so it follows the tier.
 */
export function scoreRing(score: number | null, inner: Node, animate = true) {
  const R = 54, C = 2 * Math.PI * R;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('aria-hidden', 'true');
  const circle = (cls: string) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '60'); c.setAttribute('cy', '60'); c.setAttribute('r', String(R));
    c.setAttribute('class', cls);
    return c;
  };
  const fg = circle('ring-fg');
  const target = C * (1 - Math.max(0, Math.min(100, score ?? 0)) / 100);
  fg.setAttribute('stroke-dasharray', C.toFixed(2));
  fg.setAttribute('stroke-dashoffset', (animate && !reduced() ? C : target).toFixed(2));
  svg.append(circle('ring-bg'), fg);
  const box = document.createElement('div');
  box.className = 'score-ring';
  const mid = document.createElement('div');
  mid.className = 'ring-mid';
  mid.append(inner);
  box.append(svg, mid);
  if (animate && !reduced()) onSeen(box, () => requestAnimationFrame(() => fg.setAttribute('stroke-dashoffset', target.toFixed(2))));
  return box;
}
