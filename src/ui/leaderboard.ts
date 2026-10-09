import { listSessions } from '../data/sessions';
import { listStrategies } from '../data/strategies';
import { badges, buildBoard, RANK_RULES, type BoardEntry } from '../analytics/service';
import { h, num, toast } from './dom';
import { pageHead, pageShell, scoreBadge } from './layout';
import { pctTxt } from './an-widgets';
import { eligibilityBars, strategyModal } from './strategies';

type SortKey = 'score' | 'return' | 'sharpe' | 'dd' | 'trades';
/** Leaderboard controls survive re-renders and navigation. */
const ui = { q: '', market: '', sort: 'score' as SortKey, practice: false };

const months = (days: number) => `${(days / 30.44).toFixed(days < 304 ? 1 : 0)} mo`;
const markets = (e: BoardEntry) => [...new Set(e.sessions.flatMap((s) => s.symbols))];

export async function renderLeaderboard(root: HTMLElement, nav: (hash: string) => void) {
  const [sessions, strategies] = await Promise.all([listSessions(), listStrategies()]);
  const { page, main } = pageShell('leaderboard');
  root.replaceChildren(page);
  main.append(pageHead({
    eyebrow: 'Leaderboard', titleHtml: 'Strategies with a <em>real</em> edge.', center: true,
    lead: `${RANK_RULES} Rankings are calculated in this browser from the strategies saved on this device.`,
    actions: [
      h('button', { class: 'primary', onclick: () => strategyModal(null, sessions, (st) => nav(`#/strategy/${st.id}`)) }, '+ New strategy'),
      h('button', { class: 'ghost', onclick: () => nav('#/methodology') }, 'How the score works'),
    ],
  }));
  const body = h('div', { class: 'wrap page-body' }, h('div', { class: 'loading' }, 'Ranking strategies…'));
  main.append(body);
  let board: BoardEntry[] = [];
  try {
    board = await buildBoard(sessions, strategies);
  } catch (e) {
    console.error(e);
    toast('Could not build the leaderboard: ' + String((e as Error).message ?? e), 'err');
  }
  if (!body.isConnected) return;
  const draw = () => body.replaceChildren(...content(board, nav, draw));
  draw();
}

function content(board: BoardEntry[], nav: (hash: string) => void, redraw: () => void): HTMLElement[] {
  const allMarkets = [...new Set(board.flatMap(markets))].sort();
  const q = h('input', { type: 'search', value: ui.q, placeholder: 'Strategy or author' });
  const mk = h('select', {}, h('option', { value: '' }, 'All markets'), ...allMarkets.map((m) => h('option', { value: m, selected: ui.market === m }, m)));
  const sort = h('select', {}, ...([['score', 'Overflow Score'], ['return', 'Annualized return'], ['sharpe', 'Sharpe ratio'], ['dd', 'Smallest drawdown'], ['trades', 'Most trades']] as [SortKey, string][]).map(([v, t]) => h('option', { value: v, selected: ui.sort === v }, t)));
  const practice = h('input', { type: 'checkbox', checked: ui.practice });
  q.oninput = () => {
    ui.q = q.value;
    const pos = q.selectionStart;
    redraw();
    const nq = document.querySelector<HTMLInputElement>('.lb-controls input[type=search]');
    nq?.focus();
    if (nq && pos != null) nq.setSelectionRange(pos, pos);
  };
  mk.onchange = () => ((ui.market = mk.value), redraw());
  sort.onchange = () => ((ui.sort = sort.value as SortKey), redraw());
  practice.onchange = () => ((ui.practice = practice.checked), redraw());
  const controls = h('div', { class: 'lb-controls' },
    h('label', { class: 'field wide' }, h('span', {}, 'Search'), q),
    h('label', { class: 'field' }, h('span', {}, 'Market'), mk),
    h('label', { class: 'field' }, h('span', {}, 'Sort by'), sort),
    h('label', { class: 'check', style: 'height:2.5rem' }, practice, ' Include practice & in-progress strategies'));

  const needle = ui.q.trim().toLowerCase();
  const match = (e: BoardEntry) =>
    (!needle || e.strategy.name.toLowerCase().includes(needle) || e.strategy.author.toLowerCase().includes(needle)) && (!ui.market || markets(e).includes(ui.market));
  const ranked = board.filter((e) => e.rank != null && match(e));
  const val = (e: BoardEntry): number => {
    const r = e.report!;
    switch (ui.sort) {
      case 'return': return r.cagrReliable && r.cagr != null ? r.cagr : r.returnPct;
      case 'sharpe': return r.ratios.sharpe ?? -Infinity;
      case 'dd': return -r.risk.maxDD;
      case 'trades': return r.n;
      default: return -(e.rank ?? 1e9);
    }
  };
  const list = [...ranked].sort((a, b) => val(b) - val(a) || (a.rank ?? 0) - (b.rank ?? 0));
  const out: HTMLElement[] = [controls];

  if (!board.length) {
    out.push(h('div', { class: 'card empty-state' }, h('h3', {}, 'No strategies yet'),
      h('p', {}, 'Group your sessions into a strategy, publish it, and it is ranked here once it has 50+ trades over 3+ months of real market data.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => nav('#/strategies') }, 'Go to strategies'))));
    return out;
  }
  if (!ranked.length) {
    out.push(h('div', { class: 'card empty-state' }, h('h3', {}, needle || ui.market ? 'No ranked strategy matches' : 'No ranked strategies yet'),
      h('p', {}, needle || ui.market ? 'Clear the search or market filter.' : 'None of the strategies meets the ranking rules yet. See what is missing below — usually more trades, a longer test or real market data.')));
  } else {
    // podium: best three by score among the matches
    const podium = [...ranked].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, 3);
    out.push(h('div', { class: 'podium' }, ...podium.map((e, i) => {
      const r = e.report!;
      return h('article', { class: `card${i === 0 ? ' first' : ''}` },
        h('div', { class: 'rank' }, `#${e.rank}`),
        h('div', {}, h('h3', {}, e.strategy.name), h('div', { class: 'by' }, `by ${e.strategy.author || 'Anonymous'}`)),
        h('div', { class: 'big' }, h('b', {}, String(r.score.score)), h('span', { class: `score-badge t-${r.score.tier}` }, h('span', {}, `${r.score.grade} · ${r.score.label}`))),
        h('div', { class: 'mini-stats' },
          h('div', {}, h('span', {}, 'Return / yr'), h('b', { class: (r.cagr ?? r.returnPct) >= 0 ? 'up' : 'dn' }, r.cagrReliable ? pctTxt(r.cagr, 1, true) : pctTxt(r.returnPct, 1, true))),
          h('div', {}, h('span', {}, 'Max DD'), h('b', {}, pctTxt(-r.risk.maxDD, 1))),
          h('div', {}, h('span', {}, 'Trades'), h('b', {}, String(r.n)))),
        h('div', { class: 'badges' }, ...badges(r).map((b) => h('span', { class: `badge${b.id === 'allweather' ? ' accent' : ''}`, title: b.title }, b.label))),
        h('div', { class: 'actions' }, h('button', { class: i === 0 ? 'primary' : 'ghost', onclick: () => nav(`#/strategy/${e.strategy.id}`) }, 'Detail')));
    })));
    const th = (t: string, r = false) => h('th', { class: r ? 'r' : '' }, t);
    out.push(h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, th('Rank'), th('Strategy'), th('Score'), th('Trades', true), th('History', true), th('Return / yr', true), th('Max DD', true), th('Sharpe', true), th('Profit factor', true), th('Badges'), th(''))),
      h('tbody', {}, ...list.map((e) => {
        const r = e.report!;
        const ret = r.cagrReliable ? r.cagr : r.returnPct;
        return h('tr', {},
          h('td', {}, h('span', { class: 'lb-rank' }, `#${e.rank}`)),
          h('td', {}, h('div', { class: 'lb-name' }, h('b', {}, e.strategy.name), h('small', {}, `by ${e.strategy.author || 'Anonymous'}${markets(e).length ? ` · ${markets(e).join(', ')}` : ''}`))),
          h('td', {}, scoreBadge(r.score.score, r.score.grade, r.score.tier, r.score.label)),
          h('td', { class: 'r' }, String(r.n)),
          h('td', { class: 'r' }, months(r.spanDays)),
          h('td', { class: `r ${(ret ?? 0) >= 0 ? 'up' : 'dn'}` }, pctTxt(ret, 1, true)),
          h('td', { class: 'r' }, pctTxt(-r.risk.maxDD, 1)),
          h('td', { class: 'r' }, num(r.ratios.sharpe)),
          h('td', { class: 'r' }, num(r.core.profitFactor)),
          h('td', {}, h('div', { class: 'badges' }, ...badges(r).map((b) => h('span', { class: `badge${b.id === 'allweather' ? ' accent' : ''}`, title: b.title }, b.label)))),
          h('td', { class: 'acts' }, h('button', { class: 'ghost sm', onclick: () => nav(`#/strategy/${e.strategy.id}`) }, 'Detail')));
      }))))));
  }

  // not yet ranked
  const pending = board.filter((e) => e.rank == null && match(e));
  if (pending.length) {
    if (!ui.practice) {
      out.push(h('p', { class: 'muted', style: 'margin-top:2rem' }, `${pending.length} strateg${pending.length === 1 ? 'y is' : 'ies are'} not ranked yet. `,
        h('button', { class: 'link', type: 'button', onclick: () => ((ui.practice = true), redraw()) }, 'Show them and what they still need →')));
    } else {
      out.push(h('div', { class: 'sub-head' }, h('div', {}, h('span', { class: 'eyebrow' }, 'Not yet ranked'), h('h3', {}, 'Practice & in-progress strategies'))),
        h('div', { class: 'pending-list' }, ...pending.map((e) => {
          const r = e.report;
          return h('article', { class: 'card stack' },
            h('div', { class: 'scard-head' }, h('div', {}, h('h3', { style: 'font:600 1.05rem/1.3 var(--font-ui);letter-spacing:0' }, e.strategy.name), h('div', { class: 'by muted small' }, `by ${e.strategy.author || 'Anonymous'}`)),
              r ? scoreBadge(r.score.score, r.score.grade, r.score.tier, r.score.label) : scoreBadge(null, '—', 'insufficient')),
            eligibilityBars(e),
            h('ul', {}, ...e.elig.reasons.map((x) => h('li', {}, x))),
            h('div', { class: 'row-btns' }, h('button', { class: 'ghost sm', onclick: () => nav(`#/strategy/${e.strategy.id}`) }, 'Detail')));
        })));
    }
  }
  return out;
}
