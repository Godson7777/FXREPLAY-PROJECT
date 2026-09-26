type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Minimal hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else if (k === 'value' || k === 'checked' || k === 'selected') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function money(x: number, signed = false) {
  if (!isFinite(x)) return x > 0 ? '∞' : '—';
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${x < 0 ? '−' : signed && x > 0 ? '+' : ''}$${s}`;
}
export function pct(x: number, digits = 1, signed = false) {
  if (!isFinite(x)) return '—';
  return `${x < 0 ? '−' : signed && x > 0 ? '+' : ''}${Math.abs(x * 100).toFixed(digits)}%`;
}
export function num(x: number | null | undefined, digits = 2, signed = false) {
  if (x == null || !isFinite(x)) return x != null && x > 0 ? '∞' : '—';
  return `${x < 0 ? '−' : signed && x > 0 ? '+' : ''}${Math.abs(x).toFixed(digits)}`;
}
export const cls = (x: number) => (x > 0 ? 'up' : x < 0 ? 'dn' : '');

export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return { bg: v('--chart-bg') || '#131722', text: v('--text-2') || '#b2b5be', grid: v('--grid') || '#1f2430' };
}

// ---- toast ------------------------------------------------------------------
export function toast(msg: string, kind: 'info' | 'ok' | 'err' = 'info') {
  let box = $('#toasts');
  if (!box) document.body.append((box = h('div', { id: 'toasts' })));
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  while (box.children.length > 3) box.firstElementChild!.remove();
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

// ---- modal -------------------------------------------------------------------
export function modal(title: string, body: HTMLElement, opts: { wide?: boolean; onClose?: () => void } = {}) {
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const back = h(
    'div',
    { class: 'modal-back' },
    h('div', { class: `modal${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')),
      body,
    ),
  );
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  (body.querySelector('input,select,textarea') as HTMLElement | null)?.focus();
  return close;
}

export function field(label: string, input: HTMLElement, hint?: string) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
}

export function dateInputValue(utc: number) {
  return new Date(utc * 1000).toISOString().slice(0, 16);
}
export function parseDateInput(v: string): number {
  return Math.floor(Date.parse(v + (v.length <= 16 ? ':00Z' : 'Z')) / 1000);
}

export function download(name: string, content: string, type = 'text/csv') {
  const a = h('a', { href: URL.createObjectURL(new Blob([content], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
