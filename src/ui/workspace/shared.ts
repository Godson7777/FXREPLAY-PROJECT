import { h, esc } from '../dom';

export type PlayUnit = 'candle' | 'base';

export interface Prefs {
  speed: number;
  unit: PlayUnit;
  autoShot: boolean;
  sizeMode: 'risk%' | 'risk$' | 'lots';
  sizeVal: number;
  slPips: number;
  tpMode: 'rr' | 'pips';
  tpVal: number;
  confirmClose: boolean;
  bottomH: number;
  bottomCollapsed: boolean;
  panel: Panel;
  sideCollapsed: boolean;
  preview: boolean;
  toolsOpen: boolean;
}

export type Panel = 'order' | 'goto' | 'watch' | 'tree' | 'data';
export const PANELS: { id: Panel; icon: string; label: string; title: string }[] = [
  { id: 'order', icon: '⊕', label: 'Order', title: 'Order ticket & account' },
  { id: 'goto', icon: '↷', label: 'Go To', title: 'Jump forward to a date or session open' },
  { id: 'watch', icon: '☰', label: 'Watch', title: 'Watchlist — symbols in this session' },
  { id: 'tree', icon: '⧉', label: 'Objects', title: 'Object tree — drawings, indicators, orders' },
  { id: 'data', icon: '▦', label: 'Data', title: 'Data window — OHLC and indicator values under the cursor' },
];

export const PREF_KEY = 'overflowtrade.prefs';
export function loadPrefs(): Prefs {
  const def: Prefs = {
    speed: 2,
    unit: 'candle',
    autoShot: true,
    sizeMode: 'risk%',
    sizeVal: 1,
    slPips: 20,
    tpMode: 'rr',
    tpVal: 2,
    confirmClose: false,
    bottomH: 210,
    bottomCollapsed: false,
    panel: 'order',
    sideCollapsed: false,
    preview: true,
    toolsOpen: typeof window === 'undefined' || window.innerWidth >= 768,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as Record<string, unknown>;
    const out = { ...def, ...saved } as Prefs;
    // a value saved while a field was empty or half-typed must not survive a reload as null/NaN
    const o = out as unknown as Record<string, unknown>,
      d = def as unknown as Record<string, unknown>;
    for (const k of Object.keys(d))
      if (typeof d[k] === 'number' && !(typeof o[k] === 'number' && isFinite(o[k] as number) && (o[k] as number) >= 0)) o[k] = d[k];
    return out;
  } catch {
    return def;
  }
}

export function kv(k: string, v: string, c = '') {
  return h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: c }, v));
}

export function emptyRow(span: number, text: string) {
  return h('tr', {}, h('td', { colspan: span, class: 'empty', html: esc(text) }));
}

export function nextUtcHour(clock: number, hour: number) {
  const day = Math.floor(clock / 86400) * 86400;
  let t = day + hour * 3600;
  while (t <= clock) t += 86400;
  const dow = new Date(t * 1000).getUTCDay();
  if (dow === 6) t += 2 * 86400;
  if (dow === 0) t += 86400;
  return t;
}
