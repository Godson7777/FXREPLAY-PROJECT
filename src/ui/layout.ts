import { h, themeButton } from './dom';
import { cloudButton } from './cloudui';
import { LOGO } from './logo';
import { EXPLAIN, type ExplainId } from '../analytics/explain';
import type { TierId } from '../analytics/score';

export type NavId = 'sessions' | 'strategies' | 'leaderboard' | 'analytics' | 'data' | 'methodology' | '';

/** Site-wide header: brand, main navigation, cloud and theme controls. */
export function siteHeader(active: NavId, ...extra: (Node | null)[]) {
  const link = (id: NavId, href: string, label: string) =>
    h('a', { href, class: active === id ? 'on' : '', 'aria-current': active === id ? 'page' : null }, label);
  return h('header', { class: 'site-header' },
    h('div', { class: 'wrap' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Overflow Trade — home' }, h('span', { class: 'logo', html: LOGO }), h('b', {}, 'Overflow Trade')),
      h('nav', { class: 'site-nav', 'aria-label': 'Main' },
        link('sessions', '#/', 'Sessions'),
        link('strategies', '#/strategies', 'Strategies'),
        link('leaderboard', '#/leaderboard', 'Leaderboard'),
        link('analytics', '#/analytics/all', 'Analytics'),
        link('data', '#/data', 'Data'),
      ),
      h('div', { class: 'nav-right' }, ...extra, cloudButton(), themeButton()),
    ),
  );
}

export function siteFooter() {
  return h('footer', { class: 'site-footer' },
    h('div', { class: 'wrap' },
      h('span', {}, '© Overflow Trade · Backtest results are hypothetical and do not guarantee future performance.'),
      h('span', {}, h('a', { href: '#/methodology' }, 'How the Overflow Score works'), ' · ', h('a', { href: '#/leaderboard' }, 'Leaderboard')),
    ),
  );
}

/** Standard page shell: header, main, footer. Returns the page and its main element. */
export function pageShell(active: NavId, ...extra: (Node | null)[]) {
  const main = h('main', {});
  const page = h('div', { class: 'page' }, siteHeader(active, ...extra), main, siteFooter());
  return { page, main };
}

/**
 * Page heading: eyebrow, serif title (static HTML with an <em> keyword — never
 * pass user content as `titleHtml`), lead paragraph and actions.
 */
export function pageHead(o: { eyebrow: string; titleHtml?: string; title?: string; lead?: string | Node; actions?: (Node | null)[]; center?: boolean; compact?: boolean; extra?: Node | null }) {
  const title = h('h1', {});
  if (o.titleHtml) title.innerHTML = o.titleHtml;
  else title.textContent = o.title ?? '';
  return h('section', { class: `page-head${o.center ? ' center' : ''}${o.compact ? ' compact' : ''}` },
    h('div', { class: 'wrap' },
      h('span', { class: 'eyebrow' }, o.eyebrow),
      title,
      o.lead ? h('p', { class: 'lead' }, o.lead) : null,
      o.extra ? h('div', { class: 'head-extra' }, o.extra) : null,
      o.actions?.length ? h('div', { class: 'actions' }, ...o.actions) : null,
    ),
  );
}

/** A full-width section with its own background and a heading block. */
export function section(o: { id: string; eyebrow: string; titleHtml: string; lead?: string | Node; tone?: 'plain' | 'alt' | 'band'; tight?: boolean; center?: boolean }, ...children: (Node | null | false)[]) {
  const h2 = h('h2', {});
  h2.innerHTML = o.titleHtml;
  const sec = h('section', { class: `sec${o.tight === false ? '' : ' tight'}${o.tone && o.tone !== 'plain' ? ' ' + o.tone : ''}`, id: `sec-${o.id}`, 'data-sec': o.id },
    h('div', { class: 'wrap' },
      h('div', { class: `sec-head${o.center ? ' center' : ''}` }, h('span', { class: 'eyebrow' }, o.eyebrow), h2, o.lead ? h('p', {}, o.lead) : null),
      ...children,
    ),
  );
  return sec;
}

// ---- "How to read" ---------------------------------------------------------------------

/** Remembers which explanations are open, so re-renders (filters, theme, sync) keep them. */
const openHow = new Set<string>();

export type ExplainRef = ExplainId | { id: ExplainId; what: string };

export function explainPanel(ref: ExplainRef) {
  const id = typeof ref === 'string' ? ref : ref.id;
  const base = EXPLAIN[id] as { what: string; read: string; good: string; watch?: string };
  const e = typeof ref === 'string' ? base : { ...base, what: `${ref.what} ${base.what}` };
  const part = (t: string, s?: string) => (s ? h('div', {}, h('h6', {}, t), h('p', {}, s)) : null);
  return h('div', { class: 'how', role: 'region', 'aria-label': 'How to read' },
    part('What it measures', e.what), part('How to read it', e.read), part('What good looks like', e.good), part('Watch out for', e.watch));
}

/** Button that toggles a "How to read" panel, inserted where `mount` says. */
export function howButton(id: ExplainRef, key: string, mount: (panel: HTMLElement | null) => void) {
  const b = h('button', { class: 'how-btn', type: 'button', 'aria-expanded': 'false', title: 'How to read this' }, 'ⓘ How to read');
  let panel: HTMLElement | null = null;
  const set = (open: boolean) => {
    b.setAttribute('aria-expanded', String(open));
    if (open) {
      openHow.add(key);
      panel = explainPanel(id);
      mount(panel);
    } else {
      openHow.delete(key);
      panel?.remove();
      panel = null;
      mount(null);
    }
  };
  b.onclick = () => set(!panel);
  if (openHow.has(key)) queueMicrotask(() => set(true));
  return b;
}

/** A card with a title, an optional "How to read" toggle and content. */
export function infoCard(title: string, explainId: ExplainRef | null, ...children: (Node | null | false)[]) {
  const body = h('div', { class: 'card-body' }, ...children.filter((c): c is Node => !!c));
  const head = h('div', { class: 'card-title' }, h('span', {}, title));
  const card = h('section', { class: 'card' }, head, body);
  if (explainId) {
    const key = `${typeof explainId === 'string' ? explainId : explainId.id}:${title}`;
    head.append(h('div', { class: 'tools-r' }, howButton(explainId, key, (p) => {
      if (p) card.insertBefore(p, body);
    })));
  }
  return card;
}

/** Card without a title row (for tables etc.). */
export function plainCard(...children: (Node | null | false)[]) {
  return h('section', { class: 'card' }, ...children.filter((c): c is Node => !!c));
}

// ---- score badge -----------------------------------------------------------------------

export function scoreBadge(score: number | null, grade: string, tier: TierId | 'loading', label?: string, lg = false) {
  if (tier === 'loading') return h('span', { class: 'score-badge', title: 'Calculating the Overflow Score…' }, h('b', {}, '…'), h('span', {}, 'Score'));
  const title = score == null ? 'Not enough trades for an Overflow Score yet' : `Overflow Score ${score}/100 · ${grade} · ${label ?? ''}`;
  return h('span', { class: `score-badge t-${tier}${lg ? ' lg' : ''}`, title },
    h('b', {}, score == null ? '—' : String(score)),
    h('span', {}, score == null ? 'No score yet' : label ? `${grade} · ${label}` : grade));
}
