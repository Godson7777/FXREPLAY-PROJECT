import { importTradesModal, liveSessionModal, newSessionModal } from './home/session-dialogs';
import { exportBackup, importBackup } from './home/backup';
import { renderData } from './home/data-page';
import { fmtDate } from './home/shared';
import { generateSynthetic } from '../data/synthetic';
import { listDatasets } from '../data/store';
import { storeBars } from '../data/ingest';
import { listSessions, saveSession, deleteSession } from '../data/sessions';
import { computeStats } from '../analytics/stats';
import { newSession, type Session } from '../engine/replay';
import { reportsFor } from '../analytics/service';
import { heroDemo } from './hero-demo';
import { compactMoney } from './an-widgets';
import { revealAll } from './motion';
import { h, money, pct, cls, toast, uid } from './dom';
import { pageHead, pageShell, scoreBadge } from './layout';
import { addToStrategyModal } from './strategies';

/** Tiny equity curve of a session's closed trades, for its card. */
function equitySpark(s: Session) {
  const tr = s.state.broker.trades;
  if (tr.length < 2) return null;
  const ys = [s.balance];
  for (const t of tr) ys.push(ys[ys.length - 1] + t.pnl);
  const lo = Math.min(...ys),
    hi = Math.max(...ys),
    W = 300,
    H = 40;
  const pts = ys.map((v, i) => `${((i / (ys.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const box = h('div', { class: `spark ${up ? 'up' : 'dn'}`, title: `Balance after each of the ${tr.length} closed trades` });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${pts} ${W},${H}"/><polyline points="${pts}" pathLength="1"/></svg>`;
  return box;
}

export async function renderHome(root: HTMLElement, nav: (h: string) => void, tab: 'sessions' | 'data') {
  const [sessions, datasets] = await Promise.all([listSessions(), listDatasets()]);
  const { page, main } = pageShell(tab);
  root.replaceChildren(page);
  if (tab === 'data') return renderData(main, datasets, () => renderHome(root, nav, 'data'));

  if (!datasets.length && !sessions.length) {
    const demo = h(
      'button',
      {
        class: 'primary lg',
        onclick: async () => {
          demo.disabled = true;
          demo.textContent = 'Generating…';
          try {
            await loadDemo();
            void renderHome(root, nav, 'sessions');
          } catch (e) {
            demo.disabled = false;
            toast(String((e as Error).message ?? e), 'err');
          }
        },
      },
      'Load demo data',
    );
    main.append(
      h(
        'section',
        { class: 'hero' },
        h(
          'div',
          { class: 'wrap' },
          h('span', { class: 'pill' }, h('i', {}), 'New: Overflow Score for every backtest'),
          h('h1', { html: 'Replay any market, <em>bar by bar</em>.' }),
          h(
            'p',
            {},
            'Backtest manually as if it were live: the future stays hidden, any timeframe you can type (7m, 2H, 3D…), multi-chart sync, a real order engine with SL/TP at 1-minute precision — and a quant-grade report that tells you whether your edge is real.',
          ),
          h(
            'div',
            { class: 'hero-actions' },
            h(
              'button',
              { class: 'ghost lg', title: 'Analyse a trade history CSV (FX Replay export, broker statement)', onclick: () => importTradesModal(nav) },
              'Import trades (CSV)',
            ),
            h('button', { class: 'ghost lg', onclick: () => nav('#/data') }, 'Import your data'),
            h(
              'button',
              {
                class: 'ghost lg',
                title: 'Forward-test on the live Hyperliquid market',
                onclick: () =>
                  liveSessionModal(async (s) => {
                    await saveSession(s);
                    nav(`#/replay/${s.id}`);
                  }),
              },
              '● Live market',
            ),
            demo,
          ),
          h(
            'p',
            { class: 'muted small' },
            'Demo data is synthetic (realistic-looking, generated in your browser) and never ranked. For real history, import CSVs from HistData, Dukascopy or MT4/MT5, or connect Binance, Bybit, OKX, Hyperliquid or Twelve Data (forex & gold) on the Data tab. Live market paper-trades Hyperliquid perps in real time.',
          ),
        ),
      ),
      h(
        'section',
        { class: 'sec alt' },
        h(
          'div',
          { class: 'wrap' },
          h(
            'div',
            { class: 'sec-head center' },
            h('span', { class: 'eyebrow' }, 'Why Overflow Trade'),
            h('h2', { html: 'Find out if your edge is <em>real</em>.' }),
          ),
          h(
            'div',
            { class: 'points' },
            h(
              'div',
              { class: 'point' },
              h('span', { class: 'n' }, '01'),
              h('h5', { 'aria-level': 2 }, 'Unlimited timeframes'),
              h('p', {}, 'Any timeframe from one-minute data — 3m, 45m, 6H, 2D — with exact OHLC aggregation and multi-chart sync.'),
            ),
            h(
              'div',
              { class: 'point' },
              h('span', { class: 'n' }, '02'),
              h('h5', { 'aria-level': 2 }, '1-minute execution'),
              h('p', {}, 'Market, limit and stop orders, SL/TP, trailing and break-even stops, spreads and commissions, filled on 1-minute bars.'),
            ),
            h(
              'div',
              { class: 'point' },
              h('span', { class: 'n' }, '03'),
              h('h5', { 'aria-level': 2 }, 'The Overflow Score'),
              h(
                'p',
                {},
                'Sharpe, drawdown, monthly consistency, market regimes, significance, costs and Monte Carlo — summed up in one score and a leaderboard.',
              ),
            ),
          ),
        ),
      ),
    );
    const hero = main.querySelector<HTMLElement>('.hero .wrap')!;
    hero.querySelector('.hero-actions')!.after(heroDemo());
    revealAll(hero.children, 90);
    revealAll(main.querySelectorAll('.point'), 110);
    return;
  }

  const start = async (s: Session) => {
    await saveSession(s);
    nav(`#/replay/${s.id}`);
  };
  const newBtn = h('button', { class: 'primary', onclick: () => (datasets.length ? newSessionModal(datasets, start) : nav('#/data')) }, '+ New session');
  const liveBtn = h(
    'button',
    { class: 'ghost', title: 'Forward-test on the live Hyperliquid market', onclick: () => liveSessionModal(start) },
    '● Live market',
  );
  main.append(
    pageHead({
      eyebrow: 'Sessions',
      titleHtml: 'Your backtesting <em>sessions</em>.',
      compact: true,
      lead: 'Each session replays the market from a start date with the future hidden. Every closed trade feeds its analytics and Overflow Score; group sessions into a strategy to compete on the leaderboard.',
      actions: [
        newBtn,
        liveBtn,
        h(
          'button',
          { class: 'ghost', title: 'Analyse a trade history CSV (FX Replay export, broker statement)', onclick: () => importTradesModal(nav) },
          'Import trades',
        ),
        h(
          'button',
          {
            class: 'ghost',
            title: 'Download all sessions, strategies, trades, drawings & journal screenshots as one JSON file',
            onclick: () => exportBackup(sessions),
          },
          'Backup',
        ),
        h(
          'button',
          { class: 'ghost', title: 'Restore sessions and strategies from a backup file', onclick: () => importBackup(() => renderHome(root, nav, 'sessions')) },
          'Restore',
        ),
      ],
    }),
  );
  const body = h('div', { class: 'wrap page-body' });
  main.append(body);
  if (!sessions.length) {
    body.append(
      h(
        'div',
        { class: 'card empty-state' },
        h('h3', {}, 'No sessions yet'),
        h('p', {}, 'Create a session: pick symbols, a start date and your account size. Everything after the start date stays hidden until you replay it.'),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => newBtn.click() }, 'Create a session')),
      ),
    );
    return;
  }
  const grid = h('div', { class: 'cards' });
  const badges = new Map<string, HTMLElement>();
  for (const s of sessions) {
    const st = computeStats(s.state.broker.trades, s.balance);
    const bal = s.state.broker.balance;
    const scoreSlot = h('span', {}, scoreBadge(null, '', 'loading'));
    badges.set(s.id, scoreSlot);
    const status = s.state.challenge
      ? h(
          'span',
          { class: `badge ${s.state.challenge.status}` },
          s.state.challenge.status === 'active'
            ? `Challenge · ${s.rules?.name ?? 'active'}`
            : s.state.challenge.status === 'passed'
              ? 'Challenge passed'
              : 'Challenge failed',
        )
      : s.imported
        ? h(
            'span',
            { class: 'badge accent', title: `Imported from ${s.imported.file}` },
            `Imported · ${s.imported.source === 'fxreplay' ? 'FX Replay' : 'CSV'}`,
          )
        : s.state.finished
          ? h('span', { class: 'badge' }, 'Finished')
          : null;
    const card = h(
      'article',
      { class: 'scard' },
      h(
        'div',
        { class: 'scard-head' },
        h(
          'div',
          {},
          h('h3', {}, s.name, s.live ? h('span', { class: 'live-badge live', style: 'margin-left:.5rem;vertical-align:middle' }, '● LIVE') : null),
          h(
            'div',
            { class: 'by' },
            `${s.symbols.join(' · ')} · ${s.live ? 'live since' : 'started'} ${fmtDate(s.start).slice(0, 10)}${s.leverage ? ` · ${s.leverage}×` : ''}`,
          ),
        ),
        scoreSlot,
      ),
      status ? h('div', { class: 'badges' }, status) : null,
      h(
        'div',
        { class: 'muted small' },
        s.imported
          ? `${fmtDate(s.start).slice(0, 10)} → ${fmtDate(s.end ?? s.start).slice(0, 10)} · ${s.imported.file}`
          : `Replay clock: ${fmtDate(s.state.clock - 1)} UTC`,
      ),
      equitySpark(s),
      h(
        'div',
        { class: 'scard-stats' },
        h(
          'div',
          {},
          h('span', {}, 'Balance'),
          h('b', { title: money(bal) }, Math.abs(bal) >= 100000 ? compactMoney(bal) : `$${Math.round(bal).toLocaleString('en-US')}`),
        ),
        h('div', {}, h('span', {}, 'Net'), h('b', { class: cls(bal - s.balance) }, pct((bal - s.balance) / s.balance, 2, true))),
        h('div', {}, h('span', {}, 'Trades'), h('b', {}, String(st.trades))),
        h('div', {}, h('span', {}, 'Win rate'), h('b', {}, st.trades ? pct(st.winRate) : '—')),
        h('div', {}, h('span', {}, 'PF'), h('b', {}, st.trades ? (isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '∞') : '—')),
      ),
      h(
        'div',
        { class: 'scard-actions' },
        s.imported ? null : h('button', { class: 'primary', onclick: () => nav(`#/replay/${s.id}`) }, 'Continue'),
        h('button', { class: s.imported ? 'primary' : 'ghost', onclick: () => nav(`#/analytics/${s.id}`) }, 'Analytics'),
        h(
          'button',
          { class: 'ghost', title: 'Add this session to a strategy', onclick: () => addToStrategyModal(s, sessions, () => renderHome(root, nav, 'sessions')) },
          '+ Strategy',
        ),
      ),
      h(
        'div',
        { class: 'scard-foot' },
        s.imported
          ? null
          : h(
              'button',
              {
                class: 'link',
                type: 'button',
                title: 'Duplicate the settings into a fresh session',
                onclick: async () => {
                  const copy = newSession({ ...s, id: uid(), name: s.name + ' (copy)', createdAt: Date.now() });
                  await saveSession(copy);
                  void renderHome(root, nav, 'sessions');
                },
              },
              'Duplicate',
            ),
        h(
          'button',
          {
            class: 'link danger',
            type: 'button',
            onclick: async () => {
              if (!confirm(`Delete session "${s.name}" and its ${st.trades} trades?`)) return;
              await deleteSession(s.id);
              void renderHome(root, nav, 'sessions');
            },
          },
          'Delete',
        ),
      ),
    );
    grid.append(card);
  }
  body.append(grid);
  revealAll(grid.children, 60);
  // scores load in the background (regime tagging may need the market data)
  void reportsFor(
    sessions.map((s) => [s]),
    sessions,
  )
    .then((reps) => {
      reps.forEach((r, i) => {
        const slot = badges.get(sessions[i].id);
        if (!slot?.isConnected) return;
        slot.replaceChildren(r ? scoreBadge(r.score.score, r.score.grade, r.score.tier, r.score.label) : scoreBadge(null, '—', 'insufficient'));
      });
    })
    .catch((e) => {
      console.error(e);
      for (const slot of badges.values()) if (slot.isConnected) slot.replaceChildren(scoreBadge(null, '—', 'insufficient'));
    });
}

async function loadDemo() {
  // the last 365 days up to yesterday, so recent start dates are inside the data
  const today = Math.floor(Date.now() / 86400000) * 86400;
  const start = today - 366 * 86400;
  const defs = [
    { sym: 'EURUSD', price: 1.1, vol: 0.07, seed: 11 },
    { sym: 'GBPUSD', price: 1.27, vol: 0.08, seed: 22 },
    { sym: 'XAUUSD', price: 2050, vol: 0.15, seed: 33 },
  ];
  for (const d of defs) {
    const bars = generateSynthetic({ start, days: 365, price: d.price, annualVol: d.vol, seed: d.seed });
    await storeBars(d.sym, bars, 'synthetic');
  }
  toast('Demo data ready — create a session!', 'ok');
}
