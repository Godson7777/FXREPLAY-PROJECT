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

export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  text: string;
  text2: string;
  muted: string;
  grid: string;
  border: string;
  accent: string;
  up: string;
  down: string;
  series1: string;
  series2: string;
}

/** Current resolved theme colours, read from the CSS custom properties. */
export function theme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    dark: cs.colorScheme.includes('dark'),
    bg: v('--chart-bg', '#262624'),
    surface: v('--surface', '#30302e'),
    text: v('--text', '#faf9f5'),
    text2: v('--text-2', '#c2c0b6'),
    muted: v('--muted', '#9c9a92'),
    grid: v('--grid', '#33332f'),
    border: v('--border', '#3f3e3a'),
    accent: v('--accent', '#d97757'),
    up: v('--up', '#1a9e93'),
    down: v('--down', '#e0605a'),
    series1: v('--series-1', '#cf6a49'),
    series2: v('--series-2', '#5b93d6'),
  };
}

// ---- theme mode (system / light / dark) ------------------------------------------

export type ThemeMode = 'system' | 'light' | 'dark';
const THEME_KEY = 'overflowtrade.theme';

export function getThemeMode(): ThemeMode {
  try {
    const m = localStorage.getItem(THEME_KEY);
    return m === 'light' || m === 'dark' ? m : 'system';
  } catch {
    return 'system';
  }
}

export function setThemeMode(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    if (mode === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event('themechange'));
}

// follow the OS while in system mode
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getThemeMode() === 'system') window.dispatchEvent(new Event('themechange'));
});

const MODE_ICON: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const MODE_LABEL: Record<ThemeMode, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

/** Button that cycles System → Light → Dark. */
export function themeButton(): HTMLButtonElement {
  const b = h('button', { class: 'ghost theme-btn' });
  const render = () => {
    const m = getThemeMode();
    b.textContent = MODE_ICON[m];
    b.title = `${MODE_LABEL[m]} (click to change)`;
    b.setAttribute('aria-label', MODE_LABEL[m]);
  };
  b.onclick = () => {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    setThemeMode(order[(order.indexOf(getThemeMode()) + 1) % 3]);
  };
  const onChange = () => (b.isConnected ? render() : window.removeEventListener('themechange', onChange));
  window.addEventListener('themechange', onChange);
  render();
  return b;
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
