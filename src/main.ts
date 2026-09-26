import './styles.css';
import { renderHome } from './ui/home';
import { Workspace } from './ui/workspace';
import { AnalyticsView } from './ui/analytics';
import { getSession, listSessions } from './data/sessions';
import { loadBars } from './data/store';
import type { Bars } from './core/types';
import { h } from './ui/dom';

const app = document.getElementById('app')!;
let current: { destroy?: () => void } | null = null;

const nav = (hash: string) => {
  if (location.hash === hash) void route();
  else location.hash = hash;
};

async function route() {
  current?.destroy?.();
  current = null;
  app.innerHTML = '';
  const [, view, id] = (location.hash.replace(/^#/, '') || '/').split('/');
  try {
    if (view === 'replay' && id) {
      const s = await getSession(id);
      if (!s) return nav('#/');
      app.append(h('div', { class: 'loading' }, 'Loading market data…'));
      const data: Record<string, Bars> = {};
      for (const sym of s.symbols) {
        const b = await loadBars(sym);
        if (!b) {
          app.innerHTML = `<div class="empty-state"><h2>Missing data for ${sym}</h2><p>Re-import it on the Data tab (same symbol name) to reopen this session.</p><a href="#/data">Go to Data</a></div>`;
          return;
        }
        data[sym] = b;
      }
      app.innerHTML = '';
      const ws = new Workspace(s, data, nav);
      ws.mount(app);
      current = ws;
    } else if (view === 'analytics') {
      const sessions = await listSessions();
      const v = new AnalyticsView(sessions, id || 'all', nav);
      app.append(v.root);
    } else {
      await renderHome(app, nav, view === 'data' ? 'data' : 'sessions');
    }
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty-state"><h2>Something went wrong</h2><pre>${String(e)}</pre><a href="#/">Home</a></div>`;
  }
}

window.addEventListener('hashchange', route);
void route();
