import { GATES, PILLARS, TIERS, MIN_TRADES_FOR_SCORE } from '../analytics/score';
import { RANK_MIN_DAYS, RANK_MIN_TRADES } from '../analytics/service';
import { h } from './dom';
import { pageHead, pageShell, section } from './layout';

/** "How the Overflow Score works" — rendered straight from the score definitions. */
export function renderMethodology(root: HTMLElement, nav: (hash: string) => void) {
  const { page, main } = pageShell('methodology');
  root.replaceChildren(page);
  main.append(pageHead({
    eyebrow: 'Methodology', titleHtml: 'How the Overflow Score <em>works</em>.', center: true,
    lead: 'One number from 0 to 100 that answers a simple question: does this backtest show a real, durable edge — one that holds in trending and ranging markets, keeps losses in check and is unlikely to be luck?',
    actions: [h('button', { class: 'primary', onclick: () => nav('#/leaderboard') }, 'See the leaderboard'), h('button', { class: 'ghost', onclick: () => nav('#/strategies') }, 'Your strategies')],
  }));

  const pillarCards = PILLARS.map((p) => h('article', { class: 'card' },
    h('span', { class: 'eyebrow' }, `${p.weight}% of the score`),
    h('h3', {}, p.label),
    h('p', {}, p.question),
    h('div', { class: 'stack', style: 'margin-top:1rem' }, ...p.metrics.map((m) => h('div', { class: 'stat', style: 'flex-direction:column;align-items:flex-start;gap:.35rem' },
      h('b', {}, `${m.label} · ${Math.round(m.weight * 100)}%`),
      h('span', { class: 'small', style: 'color:var(--text-2)' }, m.about),
      h('span', { class: 'anchors' }, 'Points: ' + m.anchors.map(([x, y]) => `${m.anchorFmt(x)} → ${y}`).join(' · ') + (m.requires ? ` · needs ${m.requires}` : '')))))));

  main.append(
    section({ id: 'pillars', eyebrow: 'Seven pillars', titleHtml: 'Not just win rate and <em>RR</em>.', lead: 'Each pillar turns a few metrics into points using the fixed anchor tables below (values in between are interpolated). Pillars are averaged by weight; a pillar without enough data is left out instead of counting as zero.' },
      h('div', { class: 'method-grid' }, ...pillarCards)),
    section({ id: 'gates', eyebrow: 'Hard caps', titleHtml: 'Some flaws cannot be <em>averaged</em> away.', tone: 'alt', lead: 'Whatever the pillars say, these checks cap the score. When several apply, the lowest cap wins.' },
      h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Check'), h('th', {}, 'Rule'), h('th', { class: 'r' }, 'Score capped at'))),
        h('tbody', {}, ...GATES.map((g) => h('tr', {}, h('td', {}, h('b', {}, g.label)), h('td', { style: 'white-space:normal' }, g.rule), h('td', { class: 'r' }, String(g.cap))))))))),
    section({ id: 'tiers', eyebrow: 'Grades', titleHtml: 'From <em>no edge</em> to all-weather.' },
      h('section', { class: 'card' }, ...TIERS.map((t) => h('div', { class: 'tier-row' }, h('b', {}, t.grade), h('span', {}, `${t.label} · ${t.min}+`), h('p', {}, t.meaning)))),
      h('div', { class: 'callout', style: 'margin-top:1.5rem' }, h('b', {}, 'All-weather '), 'is earned, not only scored: 80+ points and profitable in ranging markets and in at least one trend direction, no losing trend or volatility regime (5+ trades each), a max drawdown within 20%, statistically significant (p < 0.05), and no month that lost more than an average month earns. Otherwise an 80+ score is graded A (robust).'),
      h('p', { class: 'muted small', style: 'margin-top:1rem' }, `A score needs at least ${MIN_TRADES_FOR_SCORE} closed trades.`)),
    section({ id: 'rules', eyebrow: 'Leaderboard', titleHtml: 'How strategies get <em>ranked</em>.', tone: 'band' },
      h('div', { class: 'score-cols' },
        h('div', { class: 'score-box' }, h('h5', {}, 'Eligibility'), h('ul', {},
          h('li', {}, 'The strategy is published by its author.'),
          h('li', {}, `At least ${RANK_MIN_TRADES} closed trades.`),
          h('li', {}, `At least 3 months (${RANK_MIN_DAYS} days) between the first entry and the last exit.`),
          h('li', {}, 'Real market data only: sessions on synthetic practice data are scored but never ranked.'))),
        h('div', { class: 'score-box good' }, h('h5', {}, 'Badges'), h('ul', {},
          h('li', {}, h('b', {}, 'All-weather'), ' — meets every all-weather condition above.'),
          h('li', {}, h('b', {}, 'Prop-ready'), ' — at least 50% simulated chance to pass a 10% target / 5% daily / 10% max-loss evaluation at 1% risk.'),
          h('li', {}, h('b', {}, '100+ trades'), ' and ', h('b', {}, '1-year record'), ' — depth of the evidence.'),
          h('li', {}, h('b', {}, 'Significant'), ' — the expectancy passes a one-sided t-test at p < 0.05.'))))),
    section({ id: 'numbers', eyebrow: 'Behind the numbers', titleHtml: 'What the engine <em>measures</em>.', tone: 'alt' },
      h('div', { class: 'prose' },
        h('p', {}, h('b', {}, 'Risk units. '), 'Results are measured in R — the amount risked at the initial stop. When fewer than 80% of trades have a stop, the average loss is used as the unit instead (ALU), so strategies without stops are still comparable.'),
        h('p', {}, h('b', {}, 'Combining sessions. '), 'Every trade is converted to its % of the account at the time. A strategy places all its trades, in order of exit, on one reference account, so sessions of different sizes and symbols combine fairly.'),
        h('p', {}, h('b', {}, 'Market regimes. '), 'Each trade is tagged with the state of its market on the 4-hour chart, using only bars that closed before the entry (no lookahead): trending when ADX(14) ≥ 20 (up or down from +DI/−DI), otherwise ranging; volatility from ATR(14) as % of price, ranked against the previous 500 four-hour bars.'),
        h('p', {}, h('b', {}, 'Statistics. '), 'Sharpe and Sortino use daily returns (252 trading days a year, or 365 for markets that trade at weekends). Significance uses a one-sided t-test, a 2,000-sample bootstrap of the expectancy and the probabilistic Sharpe ratio, which accounts for skew and fat tails. The deflated Sharpe ratio corrects for the number of backtests you ran.'),
        h('p', {}, h('b', {}, 'Monte Carlo. '), 'Simulations resample your own trades (with replacement, or reshuffled), compound them like a fixed-% risk account and report the spread of outcomes, drawdowns, losing streaks, risk of ruin, position sizing and prop-firm pass rates.'),
        h('p', {}, h('b', {}, 'Costs. '), 'The stress test adds 1 and 2 cost units per trade — 1 pip, or 0.01% of price if that is larger — to see whether the edge survives wider spreads and slippage.'),
        h('p', { class: 'muted small' }, 'Backtest results are hypothetical. A high score means the evidence so far is strong; it is not a guarantee of future results.'))),
  );
}
