import './styles.css';
import { renderHome } from './ui/home';
import { Workspace } from './ui/workspace';
import { AnalyticsView, type Scope } from './ui/analytics';
import { renderStrategies } from './ui/strategies';
import { renderLeaderboard } from './ui/leaderboard';
import { renderMethodology } from './ui/methodology';
import { getSession, listSessions } from './data/sessions';
import { listStrategies } from './data/strategies';
import { loadBars } from './data/store';
import { initCloud, onCloudChange, cloudState, restoreMissingData } from './data/cloud';
import type { Bars } from './core/types';
import { h, esc } from './ui/dom';

const app = document.getElementById('app')!;
let current: { destroy?: () => void } | null = null;
/** Incremented on every navigation, so slow async pages never render over a newer one. */
let routeToken = 0;

const nav = (hash: string) => {
  if (location.hash === hash) void route();
  else location.hash = hash;
};

/**
 * Remove page-level overlays a previous page may have left on <body> (chart tooltip,
 * context menu, modals), so nothing from the replay can paint over the next page.
 */
function cleanupOverlays() {
  document.querySelectorAll('.viz-tip, .ctx-menu, .modal-back, .draw-toolbar').forEach((el) => {
    if (!app.contains(el)) el.remove();
  });
  // nothing from lightweight-charts may outlive its page
  document.querySelectorAll('body > .tv-lightweight-charts, body > table.tv-lightweight-charts').forEach((el) => el.remove());
}

// dev-only hook for the Playwright suites (stripped from production builds)
if (import.meta.env.DEV) (window as unknown as { __page: () => unknown }).__page = () => current;

async function route() {
  const token = ++routeToken;
  const stale = () => token !== routeToken;
  current?.destroy?.();
  current = null;
  app.innerHTML = '';
  cleanupOverlays();
  window.scrollTo(0, 0);
  const [, view, id] = (location.hash.replace(/^#/, '') || '/').split('/');
  try {
    if (view === 'replay' && id) {
      const s = await getSession(id);
      if (stale()) return;
      if (!s) return nav('#/');
      app.append(h('div', { class: 'loading' }, 'Loading market data…'));
      let cloudError = '';
      const data: Record<string, Bars> = {};
      try {
        const got = await restoreMissingData(s.symbols);
        if (got.length && !stale()) app.firstElementChild!.textContent = `Downloaded ${got.join(', ')} from your cloud…`;
      } catch (e) {
        cloudError = (e as Error).message ?? String(e);
      }
      for (const sym of s.symbols) {
        const b = await loadBars(sym);
        if (stale()) return;
        if (!b) {
          app.innerHTML = `<div class="empty-state"><h2>Missing data for ${esc(sym)}</h2><p>Re-import it on the Data tab (same symbol name) to reopen this session${cloudError ? ` (cloud download failed: ${esc(cloudError)})` : ''}.</p><div class="actions"><a href="#/data">Go to Data</a></div></div>`;
          return;
        }
        data[sym] = b;
      }
      if (stale()) return;
      app.innerHTML = '';
      const ws = new Workspace(s, data, nav);
      ws.mount(app);
      current = ws;
    } else if (view === 'analytics' || view === 'strategy') {
      const [sessions, strategies] = await Promise.all([listSessions(), listStrategies()]);
      if (stale()) return;
      const scope: Scope = view === 'strategy' ? { kind: 'strategy', id: id ?? '' } : !id || id === 'all' ? { kind: 'all' } : { kind: 'session', id };
      const v = new AnalyticsView(sessions, strategies, scope, nav);
      app.append(v.root);
    } else if (view === 'strategies') {
      await renderInto((root) => renderStrategies(root, nav), stale);
    } else if (view === 'leaderboard') {
      await renderInto((root) => renderLeaderboard(root, nav), stale);
    } else if (view === 'methodology') {
      renderMethodology(app, nav);
    } else {
      await renderInto((root) => renderHome(root, nav, view === 'data' ? 'data' : 'sessions'), stale);
    }
  } catch (e) {
    console.error(e);
    if (stale()) return;
    app.innerHTML = `<div class="empty-state"><h2>Something went wrong</h2><pre>${esc(String(e))}</pre><div class="actions"><a href="#/">Home</a></div></div>`;
  }
}

/** Renders an async page into a detached box and swaps it in only if the route is still current. */
async function renderInto(render: (root: HTMLElement) => Promise<void>, stale: () => boolean) {
  const box = h('div', {});
  app.append(box);
  await render(box);
  if (stale()) box.remove();
}

window.addEventListener('hashchange', () => void route());
void route();
void initCloud();

// when a background sync brings in changes, refresh list pages (never the live replay)
let seenSync = 0;
onCloudChange(() => {
  const st = cloudState();
  if (st.lastChanged && st.lastChanged !== seenSync) {
    seenSync = st.lastChanged;
    const view = location.hash.replace(/^#\/?/, '').split('/')[0];
    if (view !== 'replay') void route();
  }
});
