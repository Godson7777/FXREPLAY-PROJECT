import type { Session } from '../engine/replay';
import type { DatasetMeta } from '../core/types';
import { offsetFn, fmtLocal, fmtDuration, type OffsetFn } from '../core/tz';
import { strategySessions, saveStrategy, type Strategy } from '../data/strategies';
import { getShot, patchTradeJournal } from '../data/sessions';
import { groupBy, type GroupStats, type Report, type ReportTrade } from '../analytics/report';
import { sessionOf, SESSIONS, DOW, holdBucket, HOLD_BUCKETS, rHistogram } from '../analytics/stats';
import { TREND_LABEL, VOL_LABEL } from '../analytics/regime';
import { buildBoard, datasetMetas, eligibility, prepareSessions, reportOf, trialSharpes, RANK_MIN_DAYS, RANK_MIN_TRADES, type ReportFilter } from '../analytics/service';
import type { TradeRecord } from '../analytics/records';
import { lineChart, barChart, scatter, showTip, hideTip } from './charts';
import { h, money, num, cls, modal, field, download, toast } from './dom';
import { pageShell, pageHead, section, infoCard } from './layout';
import { scoreHero } from './an-score';
import { monteCarloCards } from './an-montecarlo';
import { kpi, stat, statsGrid, hbars, heatmap, ciChart, compactMoney, fmtP, signedUnit, pctTxt, daysTxt } from './an-widgets';
import { addToStrategyModal, strategyModal } from './strategies';
import type { ExplainId } from '../analytics/explain';

export type Scope = { kind: 'all' } | { kind: 'session'; id: string } | { kind: 'strategy'; id: string };

type Metric = 'pnl' | 'exp' | 'winrate' | 'count';
type SortKey = 'id' | 'sessionName' | 'symbol' | 'side' | 'entryTime' | 'exitTime' | 'lots' | 'pips' | 'r' | 'pnl' | 'pct' | 'maeR' | 'mfeR' | 'holdSec' | 'exitReason' | 'trend' | 'tags' | 'note';

/** View preferences shared by every analytics page (kept across re-renders). */
const prefs = { metric: 'pnl' as Metric, sort: { key: 'exitTime' as SortKey, dir: -1 as 1 | -1 } };

const SECTIONS: [string, string][] = [
  ['score', 'Score'], ['performance', 'Performance'], ['risk', 'Risk'], ['consistency', 'Consistency'], ['regimes', 'Regimes'],
  ['confidence', 'Confidence'], ['robustness', 'Robustness'], ['montecarlo', 'Monte Carlo'], ['breakdowns', 'Breakdowns'],
  ['distributions', 'Distributions'], ['trades', 'Trades'],
];

const offCache = new Map<string, OffsetFn>();
const offOf = (tz: string) => {
  let f = offCache.get(tz);
  if (!f) offCache.set(tz, (f = offsetFn(tz)));
  return f;
};
const localDate = (utc: number, tz: string) => fmtLocal(utc + offOf(tz)(utc));
const dateOnly = (utc: number) => new Date(utc * 1000).toISOString().slice(0, 10);

export class AnalyticsView {
  root: HTMLElement;
  private main: HTMLElement;
  private body: HTMLElement = h('div', { class: 'an-body' });
  private filters = { symbol: '', side: '', tag: '', reason: '', from: '', to: '' };
  private metas = new Map<string, DatasetMeta>();
  private trials: number[] = [];
  private scopeSessions: Session[] = [];
  private strategy: Strategy | null = null;
  private base: Report | null = null;
  private report: Report | null = null;
  private rankEl = h('span', {});
  private toolbarEl: HTMLElement | null = null;

  constructor(
    private all: Session[],
    private strategies: Strategy[],
    private scope: Scope,
    private nav: (hash: string) => void,
  ) {
    const { page, main } = pageShell(scope.kind === 'strategy' ? 'strategies' : 'analytics');
    this.root = h('div', { class: 'an' }, page);
    this.main = main;
    main.append(h('div', { class: 'loading' }, 'Crunching the numbers…'));
    void this.load();
  }

  private async load() {
    const sc = this.scope;
    if (sc.kind === 'session') this.scopeSessions = this.all.filter((s) => s.id === sc.id);
    else if (sc.kind === 'strategy') {
      this.strategy = this.strategies.find((s) => s.id === sc.id) ?? null;
      this.scopeSessions = this.strategy ? strategySessions(this.strategy, this.all) : [];
    } else this.scopeSessions = this.all;
    try {
      await prepareSessions(this.scopeSessions);
      this.metas = await datasetMetas();
      this.trials = trialSharpes(this.all, this.metas);
    } catch (e) {
      console.error(e);
    }
    if (!this.root.isConnected) return;
    this.renderAll();
    if (this.strategy) void this.loadRank();
  }

  private async loadRank() {
    try {
      const board = await buildBoard(this.all, this.strategies);
      const me = board.find((e) => e.strategy.id === this.strategy?.id);
      if (!me || !this.rankEl.isConnected) return;
      const ranked = board.filter((e) => e.rank != null).length;
      this.rankEl.textContent = me.rank != null ? `Ranked #${me.rank} of ${ranked}` : 'Not ranked yet';
    } catch (e) {
      console.warn(e);
    }
  }

  // ---- filters --------------------------------------------------------------------------

  private filterSpec(): ReportFilter | undefined {
    const f = this.filters;
    if (!Object.values(f).some(Boolean)) return undefined;
    const from = f.from ? Date.parse(f.from + 'T00:00:00Z') / 1000 : -Infinity;
    const to = f.to ? Date.parse(f.to + 'T00:00:00Z') / 1000 + 86400 : Infinity;
    return {
      key: JSON.stringify(f),
      test: (t: TradeRecord) =>
        (!f.symbol || t.symbol === f.symbol) && (!f.side || t.side === f.side) && (!f.tag || t.tags.includes(f.tag)) &&
        (!f.reason || t.exitReason === f.reason) && t.exitTime >= from && t.exitTime < to,
    };
  }

  private get filtered() {
    return Object.values(this.filters).some(Boolean);
  }

  // ---- render ---------------------------------------------------------------------------

  private renderAll() {
    this.base = reportOf(this.scopeSessions, this.metas, this.trials);
    this.main.innerHTML = '';
    this.main.append(this.head());
    if (!this.scopeSessions.length) {
      this.main.append(this.emptyScope());
      return;
    }
    this.main.append(this.subnav(), this.body);
    this.renderBody();
  }

  private renderBody() {
    hideTip();
    this.report = this.filtered ? reportOf(this.scopeSessions, this.metas, this.trials, this.filterSpec()) : this.base;
    const r = this.report;
    const out: HTMLElement[] = [];
    if (!r) {
      out.push(h('div', { class: 'wrap' }, h('div', { class: 'empty-state' },
        h('h2', {}, this.base ? 'No trades match these filters' : 'No closed trades yet'),
        h('p', {}, this.base ? 'Clear a filter to see results.' : 'Open the session, replay the market and take some trades — every closed trade feeds these analytics and the Overflow Score.'),
        this.scope.kind === 'session' && !this.base ? h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => this.nav(`#/replay/${this.scopeSessions[0].id}`) }, 'Open the replay')) : null)));
    } else {
      out.push(
        this.scoreSection(r), this.performanceSection(r), this.riskSection(r), this.consistencySection(r), this.regimeSection(r),
        this.confidenceSection(r), this.robustnessSection(r), this.monteCarloSection(r), this.breakdownSection(r),
        this.distributionSection(r), this.tradesSection(r),
      );
    }
    this.body.replaceChildren(...out);
  }

  private emptyScope() {
    const what = this.scope.kind === 'strategy' ? (this.strategy ? 'This strategy has no sessions yet' : 'Strategy not found') : this.scope.kind === 'session' ? 'Session not found' : 'No sessions yet';
    return h('div', { class: 'wrap' }, h('div', { class: 'empty-state' },
      h('h2', {}, what),
      h('p', {}, this.strategy ? 'Edit the strategy and tick the sessions that belong to it.' : 'Create a backtesting session and close some trades to see analytics here.'),
      h('div', { class: 'actions' },
        this.strategy ? h('button', { class: 'primary', onclick: () => this.editStrategy() }, 'Edit strategy') : h('button', { class: 'primary', onclick: () => this.nav('#/') }, 'Go to sessions'))));
  }

  private head() {
    const sc = this.scope;
    const nTrades = this.base?.n ?? 0;
    const toolbar = (this.toolbarEl = this.toolbar());
    if (sc.kind === 'strategy' && this.strategy) {
      const st = this.strategy;
      const markets = [...new Set(this.scopeSessions.flatMap((s) => s.symbols))];
      const meta = h('div', { class: 'strategy-meta' },
        h('span', {}, 'By ', h('b', {}, st.author || 'Anonymous')),
        st.timeframe ? h('span', {}, 'Timeframe ', h('b', {}, st.timeframe)) : null,
        h('span', {}, h('b', {}, String(this.scopeSessions.length)), ` session${this.scopeSessions.length === 1 ? '' : 's'}`),
        markets.length ? h('span', {}, 'Markets ', h('b', {}, markets.join(', '))) : null,
        h('span', {}, h('b', {}, st.published ? 'Published' : 'Private')),
        h('span', {}, this.rankEl),
      );
      return pageHead({
        eyebrow: 'Strategy', title: st.name, compact: true,
        lead: st.description || `${nTrades} closed trades. Add a description to tell readers how the strategy works.`,
        extra: h('div', { class: 'stack', style: 'gap:1.5rem' }, meta, toolbar),
        actions: [
          h('button', { class: 'ghost', onclick: () => this.editStrategy() }, 'Edit strategy'),
          h('button', { class: st.published ? 'ghost' : 'secondary', onclick: () => this.togglePublish() }, st.published ? 'Unpublish' : 'Publish to leaderboard'),
          h('button', { class: 'ghost', onclick: () => this.nav('#/leaderboard') }, 'Leaderboard'),
          this.exportBtn(),
        ],
      });
    }
    if (sc.kind === 'session') {
      const s = this.scopeSessions[0];
      if (!s) return pageHead({ eyebrow: 'Session analytics', title: 'Session not found', compact: true });
      return pageHead({
        eyebrow: 'Session analytics', title: s.name, compact: true,
        lead: `${s.symbols.join(' · ')} · started ${dateOnly(s.start)} · $${Math.round(s.balance).toLocaleString('en-US')} account · ${nTrades} closed trade${nTrades === 1 ? '' : 's'}`,
        extra: toolbar,
        actions: [
          h('button', { class: 'primary', onclick: () => this.nav(`#/replay/${s.id}`) }, 'Continue replay'),
          h('button', { class: 'ghost', onclick: () => addToStrategyModal(s, this.all, () => this.nav(location.hash)) }, 'Add to strategy'),
          this.exportBtn(),
        ],
      });
    }
    return pageHead({
      eyebrow: 'Analytics', titleHtml: 'All sessions, <em>combined</em>.', compact: true,
      lead: `${this.all.length} session${this.all.length === 1 ? '' : 's'} · ${nTrades} closed trades. Every trade is measured as a % of the account at the time, so sessions of any size combine into one track record.`,
      extra: toolbar,
      actions: [h('button', { class: 'ghost', onclick: () => this.nav('#/strategies') }, 'Strategies'), h('button', { class: 'ghost', onclick: () => this.nav('#/leaderboard') }, 'Leaderboard'), this.exportBtn()],
    });
  }

  private exportBtn() {
    return h('button', { class: 'ghost', type: 'button', title: 'Download the trades in this view as CSV', onclick: () => this.exportCsv(), disabled: !this.base?.n }, 'Export CSV');
  }

  private toolbar() {
    const sel = h('select', { 'aria-label': 'What to analyse' },
      h('option', { value: 'all', selected: this.scope.kind === 'all' }, 'All sessions combined'));
    if (this.strategies.length) {
      const g = h('optgroup', { label: 'Strategies' });
      for (const st of this.strategies) g.append(h('option', { value: `st:${st.id}`, selected: this.scope.kind === 'strategy' && this.scope.id === st.id }, st.name));
      sel.append(g);
    }
    if (this.all.length) {
      const g = h('optgroup', { label: 'Sessions' });
      for (const s of this.all) g.append(h('option', { value: s.id, selected: this.scope.kind === 'session' && this.scope.id === s.id }, s.name));
      sel.append(g);
    }
    sel.onchange = () => this.nav(sel.value === 'all' ? '#/analytics/all' : sel.value.startsWith('st:') ? `#/strategy/${sel.value.slice(3)}` : `#/analytics/${sel.value}`);

    const trades = this.base?.trades ?? [];
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    const f = this.filters;
    const clear = h('button', { class: 'ghost', type: 'button' }, 'Clear filters');
    const sync = () => clear.classList.toggle('hidden', !this.filtered);
    const mk = (key: keyof typeof f, label: string, opts: [string, string][]) => {
      const s = h('select', {}, h('option', { value: '' }, `All`), ...opts.map(([v, t]) => h('option', { value: v, selected: f[key] === v }, t)));
      s.onchange = () => {
        f[key] = s.value;
        sync();
        this.renderBody();
      };
      return h('label', { class: 'field' }, h('span', {}, label), s);
    };
    const date = (key: 'from' | 'to', label: string) => {
      const i = h('input', { type: 'date', value: f[key] });
      i.onchange = () => {
        f[key] = i.value;
        sync();
        this.renderBody();
      };
      return h('label', { class: 'field' }, h('span', {}, label), i);
    };
    clear.onclick = () => {
      (Object.keys(f) as (keyof typeof f)[]).forEach((k) => (f[k] = ''));
      this.renderAll();
    };
    sync();
    return h('div', { class: 'an-toolbar' },
      h('label', { class: 'field wide' }, h('span', {}, 'Analyse'), sel),
      mk('symbol', 'Symbol', uniq(trades.map((t) => t.symbol)).map((x) => [x, x])),
      mk('side', 'Side', [['long', 'Long'], ['short', 'Short']]),
      mk('tag', 'Setup tag', uniq(trades.flatMap((t) => t.tags)).map((x) => [x, x])),
      mk('reason', 'Exit', uniq(trades.map((t) => t.exitReason)).map((x) => [x, x.toUpperCase()])),
      date('from', 'From (exit)'), date('to', 'To (exit)'),
      clear,
    );
  }

  private subnav() {
    const bar = h('nav', { class: 'subnav', 'aria-label': 'Sections' });
    const wrap = h('div', { class: 'wrap' });
    const btns = SECTIONS.map(([id, label]) => {
      const b = h('button', { type: 'button', 'data-target': id }, label);
      b.onclick = () => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return b;
    });
    wrap.append(...btns);
    bar.append(wrap);
    let raf = 0;
    const onScroll = () => {
      if (!bar.isConnected) {
        window.removeEventListener('scroll', onScroll);
        return;
      }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = bar.getBoundingClientRect().bottom + 24;
        let cur = SECTIONS[0][0];
        for (const [id] of SECTIONS) {
          const el = document.getElementById(`sec-${id}`);
          if (el && el.getBoundingClientRect().top <= y) cur = id;
        }
        for (const b of btns) b.classList.toggle('on', b.dataset.target === cur);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(onScroll);
    return bar;
  }

  // ---- sections -------------------------------------------------------------------------

  private scoreSection(r: Report) {
    let extra: HTMLElement | null = null;
    if (this.strategy) {
      const el = eligibility(this.strategy, this.filtered ? this.base : r);
      const prog = (label: string, v: number, max: number, txt: string) =>
        h('div', { class: 'prog-row' }, h('span', {}, label), h('div', { class: 'prog' }, h('i', { style: `width:${Math.min(100, (v / max) * 100).toFixed(1)}%` })), h('span', {}, txt));
      extra = h('div', { class: 'score-box' }, h('h5', {}, 'Leaderboard'),
        el.ranked ? h('p', { class: 'empty' }, 'Eligible and published — this strategy is ranked on the leaderboard.') : h('ul', {}, ...el.reasons.map((x) => h('li', {}, x))),
        h('div', { class: 'stack', style: 'margin-top:1rem' },
          prog('Trades', el.trades, RANK_MIN_TRADES, `${Math.min(el.trades, 9999)} / ${RANK_MIN_TRADES}`),
          prog('History', el.days, RANK_MIN_DAYS, `${Math.floor(el.days)} / ${RANK_MIN_DAYS} days`)));
    } else if (this.scope.kind === 'session') {
      const s = this.scopeSessions[0];
      extra = h('div', { class: 'score-box' }, h('h5', {}, 'Compete on the leaderboard'),
        h('p', { class: 'empty' }, 'Group the sessions where you traded the same rules into a strategy, publish it, and it is ranked once it has 50+ trades over 3+ months of real market data.'),
        h('div', { class: 'row-btns', style: 'margin-top:1rem' }, h('button', { class: 'link', type: 'button', onclick: () => addToStrategyModal(s, this.all, () => this.nav(location.hash)) }, 'Add this session to a strategy →')));
    }
    return section({ id: 'score', eyebrow: 'Overflow Score', titleHtml: 'Does this method have a <em>real</em> edge?', tone: 'band' },
      scoreHero(r, { filtered: this.filtered, combined: this.scopeSessions.length, extraBox: extra }));
  }

  private performanceSection(r: Report) {
    const c = r.core;
    const tiles = h('div', { class: 'kpis' },
      kpi('Net result', money(r.netPnl, true), cls(r.netPnl), `${pctTxt(r.returnPct, 2, true)} on ${money(r.initial)}`),
      kpi('Annualized return', r.cagrReliable && r.cagr != null ? pctTxt(r.cagr, 1, true) : '—', cls(r.cagr ?? 0), r.cagrReliable ? `over ${daysTxt(r.spanDays)}` : 'needs 60+ days of history'),
      kpi('Win rate', pctTxt(c.winRate), '', `${c.wins}W · ${c.losses}L · ${c.breakeven} BE`),
      kpi('Profit factor', num(c.profitFactor), c.profitFactor >= 1 ? 'up' : 'dn', `${compactMoney(c.grossProfit)} won / ${compactMoney(c.grossLoss)} lost`),
      kpi('Expectancy', signedUnit(r.significance.mean, r.unitLabel), cls(r.significance.mean), `${money(c.expectancy, true)} per trade`),
      kpi('Max drawdown', pctTxt(-r.risk.maxDD, 2), r.risk.maxDD > 0 ? 'dn' : '', `${money(-r.risk.maxDDAbs)} · longest slump ${daysTxt(r.risk.maxDDDays)}`),
    );
    const out: (HTMLElement | null)[] = [infoCard('Headline numbers', 'kpis', tiles)];
    const s0 = this.scopeSessions[0];
    if (this.scope.kind === 'session' && s0?.rules && s0.state.challenge) {
      const ru = s0.rules, ch = s0.state.challenge;
      const statusTxt = ch.status === 'active' ? 'In progress' : ch.status === 'passed' ? 'Passed' : 'Failed';
      out.push(infoCard(`Challenge · ${ru.name}`, 'challenge', h('div', { class: 'kpis small' },
        kpi('Status', statusTxt, ch.status === 'passed' ? 'up' : ch.status === 'failed' ? 'dn' : '', ch.reason || 'rules are checked on every 1-minute bar'),
        kpi('Profit vs target', pctTxt((s0.state.broker.balance - s0.balance) / s0.balance, 2, true), cls(s0.state.broker.balance - s0.balance), `target +${ru.profitTarget}%`),
        kpi('Worst daily loss', pctTxt(-ch.worstDailyLoss / s0.balance, 2), 'dn', ru.maxDailyLoss ? `limit −${ru.maxDailyLoss}%` : 'no daily limit'),
        kpi('Max drawdown', pctTxt(-ch.maxDrawdown / s0.balance, 2), 'dn', `limit −${ru.maxTotalLoss}%${ru.trailingDrawdown ? ' (trailing)' : ''}`),
        kpi('Trading days', String(ch.tradingDays.length), '', `minimum ${ru.minTradingDays}`),
      )));
    }
    // equity & drawdown
    const tz = this.refTz();
    const off = offOf(tz);
    const xs = r.equity.t.map((t) => t + off(t));
    const span = xs[xs.length - 1] - xs[0];
    const dFmt = (t: number) => (span < 5 * 86400 ? fmtLocal(t).slice(5) : fmtLocal(t).slice(0, 10));
    const eqSeries = [{ name: 'Closed balance', color: 'var(--series-1)', xs, ys: r.equity.v, area: true }];
    if (this.scope.kind === 'session' && !this.filtered && s0) {
      const e = s0.state.broker.equity;
      if (e.length > 2) {
        const step = Math.ceil(e.length / 1500);
        const es = e.filter((_, i) => i % step === 0 || i === e.length - 1);
        eqSeries.push({ name: 'Equity incl. open trades', color: 'var(--series-2)', xs: es.map((p) => p.t + off(p.t)), ys: es.map((p) => p.equity), area: false });
      }
    }
    out.push(infoCard('Equity curve', 'equity', lineChart({ series: eqSeries, height: 300, yFmt: (v) => money(v), xFmt: dFmt, baseline: r.initial }),
      eqSeries.length > 1 ? legend(eqSeries) : null));
    out.push(infoCard('Drawdown (underwater)', 'drawdown', lineChart({ series: [{ name: 'Drawdown', color: 'var(--bad)', xs, ys: r.ddPath.map((d) => d * 100), area: true }], height: 170, yFmt: (v) => `${v.toFixed(1)}%`, xFmt: dFmt, baseline: 0, zeroArea: true }),
      h('p', { class: 'card-note' }, `Max drawdown ${pctTxt(-r.risk.maxDD, 2)} · longest time below a high ${daysTxt(r.risk.maxDDDays)} · under water ${pctTxt(r.risk.underwaterPct, 0)} of trading days.`)));
    const S = stat;
    out.push(infoCard('Key statistics', 'keystats', statsGrid(
      S('Trades', String(r.n)), S('Avg win', money(c.avgWin), 'up'), S('Avg loss', money(c.avgLoss), 'dn'),
      S('Payoff ratio', num(c.payoff), '', 'Average win / average loss'),
      S('Largest win', money(c.largestWin), 'up'), S('Largest loss', money(c.largestLoss), 'dn'), S('Commission paid', money(-c.commission)),
      S('Avg win (R)', c.avgWinR != null ? num(c.avgWinR, 2, true) : '—', 'up'), S('Avg loss (R)', c.avgLossR != null ? num(c.avgLossR, 2, true) : '—', 'dn'),
      S('Total R', c.totalR != null ? num(c.totalR, 1, true) : '—', cls(c.totalR ?? 0)),
      S('SQN', c.sqn != null ? num(c.sqn) : '—', '', 'System Quality Number (Van Tharp): above 1.6 ok, above 2.5 good, above 5 superb'),
      S('Kelly %', pctTxt(c.kellyPct), '', 'Theoretical optimal risk fraction — use a quarter to half of it at most'),
      S('Recovery factor', num(c.recoveryFactor), '', 'Net profit / max drawdown'),
      S('Max win streak', `${c.maxWinStreak}`), S('Max loss streak', `${c.maxLossStreak}`),
      S('Current streak', c.currentStreak ? `${Math.abs(c.currentStreak)} ${c.currentStreak > 0 ? (c.currentStreak === 1 ? 'win' : 'wins') : c.currentStreak === -1 ? 'loss' : 'losses'}` : '—', cls(c.currentStreak)),
      S('Avg hold', fmtDuration(c.avgHoldSec)), S('Avg hold · winners', fmtDuration(c.avgHoldWinSec)), S('Avg hold · losers', fmtDuration(c.avgHoldLossSec)),
      S('Longs', `${c.longs} · ${pctTxt(c.longWinRate, 0)} win`), S('Shorts', `${c.shorts} · ${pctTxt(c.shortWinRate, 0)} win`),
      S('Avg MAE', c.avgMaeR != null ? `${num(c.avgMaeR)} R` : '—', '', 'How far trades went against you on average'),
      S('Avg MFE', c.avgMfeR != null ? `${num(c.avgMfeR)} R` : '—', '', 'How far trades went in your favour on average'),
      S('Edge ratio', c.edgeRatio != null ? num(c.edgeRatio) : '—', '', 'Avg MFE / avg MAE — above 1 means entries tend to move your way first'),
      S('TP hit rate', pctTxt(c.tpHitRate, 0)), S('SL hit rate', pctTxt(c.slHitRate, 0)),
      S('Best day', money(c.bestDay, true), cls(c.bestDay)), S('Worst day', money(c.worstDay, true), cls(c.worstDay)),
      S('Profitable days', pctTxt(c.profitableDaysPct, 0)), S('Trades / active day', num(c.avgTradesPerDay, 1)),
    )));
    return section({ id: 'performance', eyebrow: 'Performance', titleHtml: 'What the track record <em>shows</em>.' }, ...out);
  }

  private riskSection(r: Report) {
    const ra = r.ratios, rk = r.risk;
    const S = stat;
    const ratios = infoCard('Risk-adjusted ratios', 'riskAdjusted', statsGrid(
      S('Sharpe (annualized)', num(ra.sharpe), cls((ra.sharpe ?? 0) - 1 + 1e-9), `Daily returns, ${r.daily.ppy} periods per year`),
      S('Sortino (annualized)', num(ra.sortino)),
      S('Calmar', num(ra.calmar), '', 'Annual return / max drawdown (needs 60+ days)'),
      S('Martin (Ulcer performance)', num(ra.martin), '', 'Annual return / Ulcer index'),
      S('Gain-to-pain (monthly)', num(ra.gainToPain)),
      S('Equity smoothness R²', ra.r2 != null ? ra.r2.toFixed(3) : '—'),
      S('Recovery factor', num(r.core.recoveryFactor)),
      S('Return / max DD', rk.maxDD > 0 ? num(r.returnPct / rk.maxDD) : '—'),
    ));
    const tail = infoCard('Tail risk', 'tailRisk', statsGrid(
      S('VaR 95% per trade', rk.varPct != null ? pctTxt(rk.varPct, 2) : '—', 'dn', rk.varU != null ? signedUnit(rk.varU, r.unitLabel) : ''),
      S('CVaR 95% per trade', rk.cvarPct != null ? pctTxt(rk.cvarPct, 2) : '—', 'dn', rk.cvarU != null ? signedUnit(rk.cvarU, r.unitLabel) : ''),
      S('VaR 95% per day', rk.varDay != null ? pctTxt(rk.varDay, 2) : '—', 'dn'),
      S('CVaR 95% per day', rk.cvarDay != null ? pctTxt(rk.cvarDay, 2) : '—', 'dn'),
      S('Worst trade', pctTxt(rk.worstTradePct, 2), 'dn'),
      S('Worst day', rk.worstDayPct != null ? pctTxt(rk.worstDayPct, 2) : '—', 'dn'),
      S('Ulcer index', rk.ulcer != null ? rk.ulcer.toFixed(2) : '—'),
      S('Time under water', pctTxt(rk.underwaterPct, 0)),
      S('Longest drawdown', daysTxt(rk.maxDDDays)),
    ));
    const exp = rk.expectedMaxLossStreak;
    const streaks = infoCard('Losing streaks', 'streaks', hbars([
      { label: 'Longest in test', value: rk.maxLossStreak, display: `${rk.maxLossStreak} in a row`, color: 'var(--bad)' },
      { label: 'Expected by chance', value: exp ?? 0, display: exp != null ? `≈ ${exp.toFixed(1)}` : '—', color: 'var(--border-strong)', title: 'ln(n·p) / ln(1/q) for n trades with loss rate q' },
      { label: 'Longest win streak', value: r.core.maxWinStreak, display: `${r.core.maxWinStreak} in a row`, color: 'var(--good)' },
    ]), h('p', { class: 'card-note' }, exp != null && rk.maxLossStreak > exp * 1.5 + 1 ? 'Losses cluster more than chance would explain — check the regime and month breakdowns for the cause.' : 'The longest losing streak is in line with what the win rate predicts.'));
    return section({ id: 'risk', eyebrow: 'Risk', titleHtml: 'Is the return worth the <em>risk</em>?', tone: 'alt' },
      h('div', { class: 'grid2' }, ratios, tail), streaks);
  }

  private consistencySection(r: Report) {
    const c = r.consistency;
    let verdict: HTMLElement;
    if (c.monthsCount < 3) verdict = h('p', { class: 'rule-verdict' }, `Needs 3 months (${c.monthsCount} so far)`);
    else if ((c.worstMonth ?? 0) >= 0) verdict = h('p', { class: 'rule-verdict ok' }, 'Passes — no losing month');
    else if ((c.worstVsAvg ?? Infinity) <= 1) verdict = h('p', { class: 'rule-verdict ok' }, `Passes — worst month ${c.worstVsAvg!.toFixed(2)}× an average month`);
    else verdict = h('p', { class: 'rule-verdict bad' }, isFinite(c.worstVsAvg ?? Infinity) ? `Fails — worst month ${c.worstVsAvg!.toFixed(2)}× an average month` : 'Fails — the average month is not positive');
    const rule = infoCard('The monthly rule', 'monthlyRule', h('div', { class: 'rule-card' },
      h('div', { class: 'stack' }, verdict,
        h('p', { class: 'muted' }, 'One bad month should never cost more than an average month earns.'),
        statsGrid(stat('Profitable months', c.greenMonthsPct != null ? pctTxt(c.greenMonthsPct, 0) : '—'), stat('Months in test', String(c.monthsCount)), stat('Months with trades', String(c.monthsTraded)))),
      hbars([
        { label: 'Worst month', value: c.worstMonth ?? 0, display: pctTxt(c.worstMonth, 2, true), color: (c.worstMonth ?? 0) < 0 ? 'var(--bad)' : 'var(--good)' },
        { label: 'Average month', value: c.avgMonth ?? 0, display: pctTxt(c.avgMonth, 2, true), color: (c.avgMonth ?? 0) >= 0 ? 'var(--good)' : 'var(--bad)' },
        { label: 'Best month', value: c.bestMonth ?? 0, display: pctTxt(c.bestMonth, 2, true), color: 'var(--good)' },
      ])));
    const monthly = infoCard('Monthly returns', 'monthlyTable', this.monthlyTable(r));
    const roll = c.rolling.x.length
      ? lineChart({ series: [{ name: `Expectancy (last ${c.rolling.window})`, color: 'var(--series-2)', xs: c.rolling.x, ys: c.rolling.y }], height: 220, yFmt: (v) => `${v.toFixed(2)} ${r.unitLabel}`, xFmt: (v) => `#${Math.round(v)}`, baseline: 0 })
      : h('p', { class: 'muted' }, 'Needs at least 20 trades.');
    const rolling = infoCard(`Rolling expectancy${c.rolling.window ? ` (last ${c.rolling.window} trades)` : ''}`, 'rolling', roll);
    const half = (g: GroupStats | null) => g;
    const h1 = half(c.half1), h2 = half(c.half2);
    const halves = infoCard('First half vs second half', 'halves', h1 && h2
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'r' }, 'First half'), h('th', { class: 'r' }, 'Second half'))),
          h('tbody', {},
            h('tr', {}, h('td', {}, 'Trades'), h('td', { class: 'r' }, String(h1.trades)), h('td', { class: 'r' }, String(h2.trades))),
            h('tr', {}, h('td', {}, 'Expectancy'), h('td', { class: `r ${cls(h1.exp ?? 0)}` }, signedUnit(h1.exp, r.unitLabel)), h('td', { class: `r ${cls(h2.exp ?? 0)}` }, signedUnit(h2.exp, r.unitLabel))),
            h('tr', {}, h('td', {}, 'Win rate'), h('td', { class: 'r' }, pctTxt(h1.winRate, 0)), h('td', { class: 'r' }, pctTxt(h2.winRate, 0))),
            h('tr', {}, h('td', {}, 'Profit factor'), h('td', { class: 'r' }, num(h1.pf)), h('td', { class: 'r' }, num(h2.pf))),
            h('tr', {}, h('td', {}, 'Sum of returns'), h('td', { class: `r ${cls(h1.sumPct)}` }, pctTxt(h1.sumPct, 1, true)), h('td', { class: `r ${cls(h2.sumPct)}` }, pctTxt(h2.sumPct, 1, true))))))
      : h('p', { class: 'muted' }, 'Needs at least 10 trades.'));
    const cal = infoCard('Daily P&L calendar', 'calendar', this.calendar(r));
    return section({ id: 'consistency', eyebrow: 'Consistency', titleHtml: 'Steady, <em>month</em> after month?' },
      rule, monthly, h('div', { class: 'grid2' }, rolling, halves), cal);
  }

  private regimeSection(r: Report) {
    const rg = r.regimes;
    const bars = (gs: GroupStats[]) => barChart({
      items: gs.map((g) => ({
        label: g.trades < 5 ? `${g.label} (n<5)` : g.label,
        value: g.exp ?? 0,
        color: g.trades < 5 ? 'var(--border-strong)' : undefined,
        tip: `<div>Trades <b>${g.trades}</b></div><div>Expectancy <b>${signedUnit(g.exp, r.unitLabel)}</b></div><div>Win rate <b>${pctTxt(g.winRate, 0)}</b></div><div>Profit factor <b>${num(g.pf)}</b></div>`,
      })),
      yFmt: (v) => `${v.toFixed(2)} ${r.unitLabel}`, height: 220, showValues: true,
    });
    const summary = (gs: GroupStats[]) => {
      const t = gs.filter((g) => g.trades >= 5);
      return h('p', { class: 'card-note' }, t.length ? `${t.filter((g) => (g.exp ?? 0) > 0).length} of ${t.length} tested regimes profitable · ${gs.map((g) => `${g.label}: ${g.trades}`).join(' · ')}` : 'No regime has 5+ tagged trades yet.');
    };
    const out: (HTMLElement | null)[] = [];
    const cov = regimeCoverage(r);
    if (cov) out.push(h('div', { class: 'callout warn', style: 'margin-bottom:1rem' }, cov));
    out.push(
      h('div', { class: 'grid2' },
        infoCard('By trend (4-hour, at entry)', 'regimeTrend', bars(rg.trend), summary(rg.trend)),
        infoCard('By volatility (4-hour ATR, at entry)', 'regimeVol', bars(rg.vol), summary(rg.vol))),
      infoCard('Trend × volatility', 'regimeMatrix', heatmap(rg.matrix, r.unitLabel)),
    );
    return section({ id: 'regimes', eyebrow: 'Market regimes', titleHtml: 'Trending, ranging, calm or <em>wild</em>?', tone: 'alt',
      lead: `Every trade is tagged with the market state at entry on the 4-hour chart: ${TREND_LABEL.up.toLowerCase()}, ${TREND_LABEL.down.toLowerCase()} or ${TREND_LABEL.range.toLowerCase()}, and ${VOL_LABEL.low.toLowerCase()}, normal or high volatility.` }, ...out);
  }

  private confidenceSection(r: Report) {
    const s = r.significance;
    const sig = s.pValue != null && s.pValue < 0.05;
    const test = infoCard('Significance test', 'significance', statsGrid(
      stat('Trades', String(s.n)), stat('Mean per trade', signedUnit(s.mean, r.unitLabel), cls(s.mean)), stat('Standard deviation', `${s.sd.toFixed(2)} ${r.unitLabel}`),
      stat('t-statistic', num(s.tStat)), stat('p-value (one-sided)', fmtP(s.pValue), sig ? 'up' : ''),
    ), h('p', { class: 'card-note' }, s.pValue == null ? 'Needs more trades.' : sig ? `Significant at 95% confidence: an average this good would appear by luck only ${pctTxt(s.pValue, 2)} of the time.` : `Not significant yet: a zero-edge strategy would do this well ${pctTxt(s.pValue, 0)} of the time.`));
    const ci = infoCard('95% confidence interval of the expectancy', 'bootstrapCI',
      s.ciLow != null && s.ciHigh != null ? ciChart(s.ciLow, s.mean, s.ciHigh, r.unitLabel) : h('p', { class: 'muted' }, 'Needs at least 10 trades.'),
      s.ciLow != null ? h('p', { class: 'card-note' }, s.ciLow > 0 ? `Even the pessimistic end (${signedUnit(s.ciLow, r.unitLabel)}) is above zero.` : `The interval includes zero (${signedUnit(s.ciLow, r.unitLabel)} to ${signedUnit(s.ciHigh, r.unitLabel)}), so a zero edge cannot be ruled out yet.`) : null);
    const sharpe = infoCard('Sharpe confidence', 'sharpeConfidence', statsGrid(
      stat('Per-trade Sharpe', num(s.sr, 3)),
      stat('Probabilistic Sharpe (PSR)', s.psr != null ? pctTxt(s.psr, 1) : '—', (s.psr ?? 0) >= 0.95 ? 'up' : ''),
      stat('Min. track record (MinTRL)', s.minTrl != null ? `${Math.ceil(s.minTrl)} trades` : '—'),
      stat('Trades still needed', s.tradesNeeded != null ? (s.tradesNeeded === 0 ? 'none' : String(s.tradesNeeded)) : '—', s.tradesNeeded === 0 ? 'up' : ''),
      stat('Deflated Sharpe (DSR)', s.dsr != null ? pctTxt(s.dsr, 1) : '—', '', s.trials ? `${s.trials} backtests counted as trials` : 'needs 2+ sessions with 10+ trades'),
      stat('Trials counted', String(s.trials)),
      stat('Skewness', s.skew.toFixed(2), '', 'Positive = occasional big winners'),
      stat('Kurtosis', s.kurt.toFixed(2), '', 'Normal distribution = 3; higher = fat tails'),
    ));
    return section({ id: 'confidence', eyebrow: 'Statistical confidence', titleHtml: 'Edge, or <em>luck</em>?' },
      h('div', { class: 'grid2' }, test, ci), sharpe);
  }

  private robustnessSection(r: Report) {
    const ro = r.robustness;
    const fr = infoCard('Cost stress test', 'friction', h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Extra cost per trade'), h('th', { class: 'r' }, 'Expectancy'), h('th', { class: 'r' }, 'Profit factor'), h('th', { class: 'r' }, 'Net return'))),
      h('tbody', {}, ...ro.friction.map((f) => h('tr', {},
        h('td', {}, f.k === 0 ? 'As tested' : `+${f.k} unit${f.k > 1 ? 's' : ''}`),
        h('td', { class: `r ${cls(f.exp)}` }, signedUnit(f.exp, r.unitLabel)),
        h('td', { class: `r ${f.pf >= 1 ? 'up' : 'dn'}` }, num(f.pf)),
        h('td', { class: `r ${cls(f.netPct)}` }, pctTxt(f.netPct, 1, true))))))),
      h('p', { class: 'card-note' }, ro.breakEvenFriction != null ? `Break-even: about ${ro.breakEvenFriction.toFixed(1)} extra units per trade would erase the profit (1 unit = 1 pip, or 0.01% of price if larger).` : 'Break-even cost not available.'));
    const o = ro.outlier;
    const out = infoCard('Without the best 5% of trades', 'outliers', o
      ? statsGrid(
          stat('Trades removed', String(o.removed)),
          stat('Expectancy without them', signedUnit(o.exp, r.unitLabel), cls(o.exp)),
          stat('Edge that remains', o.share != null ? pctTxt(Math.max(0, o.share), 0) : '—', (o.share ?? 0) >= 0.5 ? 'up' : 'dn'),
          stat('Profit factor without them', num(o.pf)),
          stat('Net return without them', pctTxt(o.netPct, 1, true), cls(o.netPct)))
      : h('p', { class: 'muted' }, 'Needs at least 20 trades.'));
    const ex = infoCard('Execution & discipline', 'execution', statsGrid(
      stat('Profit capture (winners)', ro.capture != null ? pctTxt(ro.capture, 0) : '—', '', 'Realised R / best open R on winning trades'),
      stat('Trades with a stop loss', pctTxt(ro.slUsage, 0), ro.slUsage >= 0.98 ? 'up' : ro.slUsage < 0.9 ? 'dn' : ''),
      stat('Risk consistency (CV)', ro.riskCV != null ? ro.riskCV.toFixed(2) : '—', '', 'Lower = more consistent position sizing'),
      stat('Median risk per trade', ro.medianRiskPct != null ? pctTxt(ro.medianRiskPct, 2) : '—'),
      stat('TP hit rate', pctTxt(r.core.tpHitRate, 0)), stat('SL hit rate', pctTxt(r.core.slHitRate, 0)),
      stat('Avg MAE', r.core.avgMaeR != null ? `${num(r.core.avgMaeR)} R` : '—'), stat('Avg MFE', r.core.avgMfeR != null ? `${num(r.core.avgMfeR)} R` : '—'),
    ));
    return section({ id: 'robustness', eyebrow: 'Robustness', titleHtml: 'Will it survive <em>real</em> trading?', tone: 'alt' },
      h('div', { class: 'grid2' }, fr, out), ex);
  }

  private monteCarloSection(r: Report) {
    return section({ id: 'montecarlo', eyebrow: 'Monte Carlo', titleHtml: 'A thousand <em>possible</em> futures.',
      lead: 'Your trades, reshuffled and resampled thousands of times, show the range of outcomes the same edge could produce — including the drawdowns and losing streaks to prepare for.' },
      ...monteCarloCards(r));
  }

  private breakdownSection(r: Report) {
    const T = r.trades;
    const prevRes = new Map<ReportTrade, string>();
    const nthOfDay = new Map<ReportTrade, string>();
    let prev: ReportTrade | null = null;
    const dayCount = new Map<string, number>();
    for (const t of [...T].sort((a, b) => a.entryTime - b.entryTime)) {
      prevRes.set(t, prev ? (prev.pnl > 0 ? 'After a win' : prev.pnl < 0 ? 'After a loss' : 'After BE') : 'First trade');
      const d = t.sessionId + localDate(t.entryTime, t.tz).slice(0, 10);
      const n = (dayCount.get(d) || 0) + 1;
      dayCount.set(d, n);
      nthOfDay.set(t, n >= 4 ? '4th+ trade' : `${['1st', '2nd', '3rd'][n - 1]} trade`);
      prev = t;
    }
    const hourOf = (t: ReportTrade) => new Date((t.entryTime + offOf(t.tz)(t.entryTime)) * 1000).getUTCHours();
    const dowOf = (t: ReportTrade) => DOW[(new Date((t.entryTime + offOf(t.tz)(t.entryTime)) * 1000).getUTCDay() + 6) % 7];
    const monthOf = (t: ReportTrade) => localDate(t.exitTime, t.tz).slice(0, 7);
    const metricSel = h('div', { class: 'segs', role: 'group', 'aria-label': 'Breakdown metric' }, ...(['pnl', 'exp', 'winrate', 'count'] as Metric[]).map((m) =>
      h('button', { class: `seg${prefs.metric === m ? ' on' : ''}`, type: 'button', onclick: () => { prefs.metric = m; this.renderBody(); } }, { pnl: 'Net P&L', exp: `Expectancy (${r.unitLabel})`, winrate: 'Win rate', count: 'Trades' }[m])));
    const tzName = this.refTz();
    const grid = h('div', { class: 'grid2' });
    const B = (title: string, what: string, groups: GroupStats[]) => grid.append(infoCardWith(title, 'breakdowns', what, this.groupChart(groups, r.unitLabel)));
    B('By day of week (entry)', 'Results grouped by the weekday the trade was opened, in each session’s chart timezone.', groupBy(T, dowOf, DOW));
    B(`By hour of day (entry)`, `Results grouped by the hour the trade was opened (chart timezone${this.scopeSessions.length === 1 ? `, ${tzName}` : ''}).`, groupBy(T, (t) => String(hourOf(t)).padStart(2, '0'), Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))));
    B('By market session (entry, UTC)', 'Results grouped by the trading session at entry: Sydney, Asia, London, the London/New York overlap and New York (UTC hours).', groupBy(T, (t) => sessionOf(t.entryTime), SESSIONS));
    B('By symbol', 'Results per instrument.', groupBy(T, (t) => t.symbol));
    B('Long vs short', 'Results of buy trades against sell trades.', groupBy(T, (t) => (t.side === 'long' ? 'Long' : 'Short'), ['Long', 'Short']));
    B('By setup / tag', 'Results per journal tag. Tag your trades in the trade log to compare setups.', groupBy(T, (t) => (t.tags.length ? t.tags : ['(untagged)'])));
    B('By exit reason', 'How trades ended: take profit, stop loss, break-even, trailing stop, manual close or session end.', groupBy(T, (t) => t.exitReason.toUpperCase(), ['TP', 'SL', 'BE', 'TRAIL', 'MANUAL', 'END']));
    B('By holding time', 'Results grouped by how long the trade was open.', groupBy(T, (t) => holdBucket(t.holdSec), HOLD_BUCKETS));
    B('By order type', 'Market orders against limit and stop entries.', groupBy(T, (t) => t.orderType, ['market', 'limit', 'stop']));
    B('By month', 'Results per calendar month of the exit.', groupBy(T, monthOf));
    B('Psychology: after a win or a loss', 'Results depending on how the previous trade ended — reveals revenge trading or overconfidence.', groupBy(T, (t) => prevRes.get(t)!, ['First trade', 'After a win', 'After a loss', 'After BE']));
    B('Overtrading: Nth trade of the day', 'Results of the first, second, third and later trades of a day — reveals fatigue and overtrading.', groupBy(T, (t) => nthOfDay.get(t)!, ['1st trade', '2nd trade', '3rd trade', '4th+ trade']));
    if (T.some((t) => t.rating)) B('By self-rating', 'Results per your own trade rating from the journal.', groupBy(T, (t) => (t.rating ? '★'.repeat(t.rating) : 'unrated')));
    return section({ id: 'breakdowns', eyebrow: 'Breakdowns', titleHtml: 'Where the edge <em>comes</em> from.', tone: 'alt' },
      h('div', { class: 'row-btns', style: 'margin-bottom:1.25rem' }, metricSel), grid);
  }

  private distributionSection(r: Report) {
    const T = r.trades;
    const g = h('div', { class: 'grid2' });
    const withR = T.filter((t) => t.r != null);
    if (withR.length) {
      const hist = rHistogram(T);
      g.append(infoCard('R-multiple distribution', 'rDist', barChart({
        items: hist.map((b) => ({ label: `${b.lo}`, value: b.count, color: b.lo >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<b>${b.count}</b> trades between ${b.lo}R and ${b.hi}R` })),
        yFmt: (v) => String(Math.round(v)), height: 230,
      })));
      const mm = T.filter((t) => t.maeR != null && t.mfeR != null);
      if (mm.length) {
        g.append(infoCard('MAE vs MFE (in R)', 'maeMfe', scatter({
          points: mm.map((t) => ({ x: t.maeR!, y: t.mfeR!, color: t.pnl >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<div class="tt-h">#${t.id} ${t.symbol} ${t.side}</div>MAE ${num(t.maeR, 2)}R · MFE ${num(t.mfeR, 2)}R<br>Result <b>${num(t.r, 2, true)}R</b>` })),
          xFmt: (v) => `${v.toFixed(1)}R`, yFmt: (v) => `${v.toFixed(1)}R`, xLabel: 'Max adverse excursion (R)', yLabel: 'Max favourable excursion (R)', diagonal: true,
        }), legend([{ name: 'Winner', color: 'var(--good)' }, { name: 'Loser', color: 'var(--bad)' }])));
        g.append(infoCard('Left on the table: MFE vs realised R', 'leftOnTable', scatter({
          points: mm.map((t) => ({ x: t.mfeR!, y: t.r ?? 0, color: t.pnl >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<div class="tt-h">#${t.id}</div>Peak ${num(t.mfeR, 2)}R → closed ${num(t.r, 2, true)}R` })),
          xFmt: (v) => `${v.toFixed(1)}R`, yFmt: (v) => `${v.toFixed(1)}R`, xLabel: 'Max favourable excursion (R)', yLabel: 'Realised R', diagonal: true,
        })));
      }
    } else {
      g.append(infoCard('R-multiple distribution', 'rDist', h('p', { class: 'muted' }, 'No trade had a stop loss, so R multiples are not available. Set a stop on every trade to unlock R statistics.')));
    }
    g.append(infoCard('Holding time vs result', 'holdVsResult', scatter({
      points: T.map((t) => ({ x: t.holdSec / 3600, y: t.pct * 100, color: t.pnl >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<div class="tt-h">#${t.id} ${t.symbol}</div>Held ${fmtDuration(t.holdSec)} · <b>${pctTxt(t.pct, 2, true)}</b> (${money(t.pnl, true)})` })),
      xFmt: (v) => `${v.toFixed(0)}h`, yFmt: (v) => `${v.toFixed(1)}%`, xLabel: 'Hours held', yLabel: 'Result (% of equity)',
    })));
    return section({ id: 'distributions', eyebrow: 'Distributions', titleHtml: 'The <em>shape</em> of the results.' }, g);
  }

  private tradesSection(r: Report) {
    return section({ id: 'trades', eyebrow: 'Trade log', titleHtml: `Every <em>trade</em> (${r.n}).`, tone: 'alt' },
      infoCard('Closed trades', 'tradeLog', this.tradeTable(r)));
  }

  // ---- pieces -----------------------------------------------------------------------------

  private refTz() {
    const s = [...this.scopeSessions].sort((a, b) => a.start - b.start || a.createdAt - b.createdAt)[0];
    return s?.timezone ?? 'UTC';
  }

  private groupChart(groups: GroupStats[], unit: string) {
    const m = prefs.metric;
    const val = (g: GroupStats) => (m === 'pnl' ? g.pnl : m === 'exp' ? g.exp ?? 0 : m === 'winrate' ? g.winRate * 100 : g.trades);
    const fmt = (v: number) => (m === 'pnl' ? compactMoney(v) : m === 'exp' ? `${v.toFixed(2)}` : m === 'winrate' ? `${v.toFixed(0)}%` : String(Math.round(v)));
    const neutral = m === 'count' || m === 'winrate';
    return barChart({
      items: groups.map((g) => ({
        label: g.label, value: val(g), color: neutral ? 'var(--series-2)' : undefined,
        tip: `<div>Trades <b>${g.trades}</b></div><div>Win rate <b>${pctTxt(g.winRate, 0)}</b></div><div>Net <b>${money(g.pnl, true)}</b></div><div>Expectancy <b>${signedUnit(g.exp, unit)}</b></div><div>PF <b>${num(g.pf)}</b></div>`,
      })),
      yFmt: fmt, height: 220, showValues: true,
    });
  }

  private monthlyTable(r: Report) {
    const map = new Map(r.months.map((m) => [m.key, m]));
    const years = [...new Set(r.months.map((m) => m.key.slice(0, 4)))].sort();
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const t = h('table', { class: 'tbl monthly' }, h('thead', {}, h('tr', {}, h('th', {}, 'Year'), ...M.map((m) => h('th', {}, m)), h('th', {}, 'Total'))));
    const tb = h('tbody');
    for (const y of years) {
      let comp = 1, any = false;
      const tr = h('tr', {}, h('td', {}, h('b', {}, y)));
      for (let mo = 1; mo <= 12; mo++) {
        const v = map.get(`${y}-${String(mo).padStart(2, '0')}`);
        if (v) {
          comp *= 1 + v.ret;
          any = true;
        }
        tr.append(h('td', { class: !v ? 'muted' : cls(v.ret), title: v ? `${money(v.pnl, true)} · ${v.trades} trade${v.trades === 1 ? '' : 's'}` : '' }, !v ? '·' : pctTxt(v.ret, 1, true)));
      }
      tr.append(h('td', { class: any ? cls(comp - 1) : 'muted' }, h('b', {}, any ? pctTxt(comp - 1, 1, true) : '·')));
      tb.append(tr);
    }
    t.append(tb);
    return h('div', { class: 'table-wrap' }, t);
  }

  private calendar(r: Report) {
    const days = new Map(r.localDays.map((d) => [d.key, d]));
    const keys = [...days.keys()].sort();
    const wrap = h('div', { class: 'cal-wrap' });
    if (!keys.length) return wrap;
    const maxAbs = Math.max(...r.localDays.map((v) => Math.abs(v.pnl)), 1e-9);
    const first = new Date(keys[0] + 'T00:00:00Z'), last = new Date(keys[keys.length - 1] + 'T00:00:00Z');
    let guard = 0;
    for (let y = first.getUTCFullYear(), mo = first.getUTCMonth(); (y < last.getUTCFullYear() || (y === last.getUTCFullYear() && mo <= last.getUTCMonth())) && guard < 240; mo === 11 ? (y++, (mo = 0)) : mo++, guard++) {
      const monthStart = new Date(Date.UTC(y, mo, 1));
      const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const lead = (monthStart.getUTCDay() + 6) % 7;
      const grid = h('div', { class: 'cal-grid' }, ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('div', { class: 'cal-dow' }, d)));
      for (let i = 0; i < lead; i++) grid.append(h('div', { class: 'cal-cell blank' }));
      let total = 0;
      for (let d = 1; d <= dim; d++) {
        const k = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const v = days.get(k);
        const cell = h('div', { class: 'cal-cell' + (v ? (v.pnl >= 0 ? ' pos' : ' neg') : '') }, h('span', {}, String(d)));
        if (v) {
          total += v.pnl;
          cell.style.setProperty('--a', (0.18 + 0.72 * Math.min(1, Math.abs(v.pnl) / maxAbs)).toFixed(2));
          cell.append(h('small', {}, compactMoney(v.pnl)));
          cell.addEventListener('mousemove', (e) => showTip(e, `<div class="tt-h">${k}</div><b>${money(v.pnl, true)}</b> · ${v.n} trade${v.n > 1 ? 's' : ''}`));
          cell.addEventListener('mouseleave', hideTip);
        }
        grid.append(cell);
      }
      wrap.append(h('div', { class: 'cal-month' },
        h('div', { class: 'cal-title' }, h('b', {}, monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })), h('span', { class: cls(total) }, money(total, true))),
        grid));
    }
    return wrap;
  }

  private tradeTable(r: Report) {
    const multi = this.scopeSessions.length > 1;
    type Col = { key: SortKey; label: string; fmt: (t: ReportTrade) => string; cls?: (t: ReportTrade) => string; r?: boolean };
    const cols: Col[] = [
      { key: 'id', label: '#', fmt: (t) => String(t.id) },
      ...(multi ? [{ key: 'sessionName' as SortKey, label: 'Session', fmt: (t: ReportTrade) => t.sessionName }] : []),
      { key: 'symbol', label: 'Symbol', fmt: (t) => t.symbol },
      { key: 'side', label: 'Side', fmt: (t) => t.side.toUpperCase(), cls: (t) => (t.side === 'long' ? 'up' : 'dn') },
      { key: 'entryTime', label: 'Entry', fmt: (t) => localDate(t.entryTime, t.tz) },
      { key: 'exitTime', label: 'Exit', fmt: (t) => localDate(t.exitTime, t.tz) },
      { key: 'lots', label: 'Lots', fmt: (t) => t.lots.toFixed(2), r: true },
      { key: 'pips', label: 'Pips', fmt: (t) => num(t.pips, 1, true), cls: (t) => cls(t.pips), r: true },
      { key: 'r', label: 'R', fmt: (t) => (t.r != null ? num(t.r, 2, true) : '—'), cls: (t) => cls(t.r ?? 0), r: true },
      { key: 'pnl', label: 'P&L', fmt: (t) => money(t.pnl, true), cls: (t) => cls(t.pnl), r: true },
      { key: 'pct', label: '% equity', fmt: (t) => pctTxt(t.pct, 2, true), cls: (t) => cls(t.pct), r: true },
      { key: 'maeR', label: 'MAE R', fmt: (t) => num(t.maeR, 2), r: true },
      { key: 'mfeR', label: 'MFE R', fmt: (t) => num(t.mfeR, 2), r: true },
      { key: 'holdSec', label: 'Held', fmt: (t) => fmtDuration(t.holdSec) },
      { key: 'exitReason', label: 'Exit by', fmt: (t) => t.exitReason.toUpperCase() },
      { key: 'trend', label: 'Regime', fmt: (t) => (t.trend ? `${TREND_LABEL[t.trend]} · ${t.vol ? VOL_LABEL[t.vol].replace(' volatility', '') : '?'}` : '—') },
      { key: 'tags', label: 'Tags', fmt: (t) => t.tags.join(', ') },
      { key: 'note', label: 'Note', fmt: (t) => (t.note.length > 40 ? t.note.slice(0, 40) + '…' : t.note) },
    ];
    const sk = prefs.sort.key;
    const val = (t: ReportTrade): number | string => {
      const v = (t as unknown as Record<string, unknown>)[sk];
      if (Array.isArray(v)) return v.join(',');
      return typeof v === 'number' ? v : v == null ? '' : String(v);
    };
    const sorted = [...r.trades].sort((a, b) => {
      const va = val(a), vb = val(b);
      const x = typeof va === 'number' && typeof vb === 'number' ? va - vb : typeof va === 'number' ? 1 : typeof vb === 'number' ? -1 : String(va).localeCompare(String(vb));
      return x * prefs.sort.dir || a.exitTime - b.exitTime;
    });
    const thead = h('thead', {}, h('tr', {}, ...cols.map((c) => {
      const th = h('th', { class: `sortable${c.r ? ' r' : ''}`, 'aria-sort': prefs.sort.key === c.key ? (prefs.sort.dir > 0 ? 'ascending' : 'descending') : null }, c.label, prefs.sort.key === c.key ? (prefs.sort.dir > 0 ? ' ▲' : ' ▼') : '');
      th.onclick = () => {
        prefs.sort = { key: c.key, dir: prefs.sort.key === c.key ? ((-prefs.sort.dir) as 1 | -1) : -1 };
        this.renderBody();
        document.getElementById('sec-trades')?.scrollIntoView({ block: 'start' });
      };
      return th;
    })));
    const tb = h('tbody');
    const LIMIT = 2000;
    for (const t of sorted.slice(0, LIMIT)) {
      const tr = h('tr', { class: 'clickable', tabindex: 0 }, ...cols.map((c) => h('td', { class: `${c.cls?.(t) ?? ''}${c.r ? ' r' : ''}` }, c.fmt(t))));
      tr.onclick = () => this.tradeModal(t);
      tr.onkeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.tradeModal(t);
      };
      tb.append(tr);
    }
    return h('div', {},
      h('div', { class: 'table-wrap tall' }, h('table', { class: 'tbl' }, thead, tb)),
      sorted.length > LIMIT ? h('p', { class: 'card-note' }, `Showing the first ${LIMIT} of ${sorted.length} trades — export CSV for all of them.`) : null);
  }

  private tradeModal(rt: ReportTrade) {
    const s = this.all.find((x) => x.id === rt.sessionId);
    const t = s?.state.broker.trades.find((x) => x.id === rt.id);
    if (!s || !t) return toast('This trade is no longer available', 'err');
    const img = h('img', { class: 'shot', alt: 'Chart when the trade closed' });
    if (t.shot) void getShot(t.shot).then((u) => (u ? (img.src = u) : img.remove())).catch(() => img.remove());
    else img.remove();
    const tags = h('input', { value: t.tags.join(', '), placeholder: 'e.g. breakout, london' });
    const note = h('textarea', { rows: 4 }, t.note);
    const rating = h('select', {}, ...[0, 1, 2, 3, 4, 5].map((x) => h('option', { value: x, selected: (t.rating ?? 0) === x }, x ? '★'.repeat(x) : 'No rating')));
    const save = h('button', { class: 'primary' }, 'Save journal');
    const off = offOf(s.timezone);
    const kvb = (k: string, v: string, c = '') => h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: c }, v));
    const close = modal(`#${t.id} · ${t.symbol} ${t.side.toUpperCase()} · ${s.name}`, h('div', { class: 'stack' },
      h('div', { class: 'kv-grid' },
        kvb('P&L', money(t.pnl, true), cls(t.pnl)), kvb('R', t.r != null ? num(t.r, 2, true) : '—', cls(t.r ?? 0)), kvb('Pips', num(t.pips, 1, true), cls(t.pips)),
        kvb('Entry', `${t.entry} @ ${fmtLocal(t.entryTime + off(t.entryTime))}`), kvb('Exit', `${+t.exit.toFixed(6)} @ ${fmtLocal(t.exitTime + off(t.exitTime))}`),
        kvb('Held', fmtDuration(t.holdSec)), kvb('MAE', `${num(t.maePips, 1)} pips`), kvb('MFE', `${num(t.mfePips, 1)} pips`), kvb('Exit by', t.exitReason.toUpperCase()),
        kvb('Regime at entry', rt.trend ? `${TREND_LABEL[rt.trend]}${rt.vol ? ` · ${VOL_LABEL[rt.vol]}` : ''}` : 'unknown'),
        kvb('% of equity', pctTxt(rt.pct, 2, true), cls(rt.pct)), kvb('Risk', rt.riskPct != null ? pctTxt(rt.riskPct, 2) : 'no stop'),
      ),
      img, field('Tags', tags, 'Comma separated — they power the setup breakdown.'), field('Notes', note), field('Rating', rating), save,
    ), { wide: true });
    save.onclick = async () => {
      save.disabled = true;
      const j = { tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean), note: note.value, rating: +rating.value || undefined };
      try {
        const at = await patchTradeJournal(s.id, t.id, j);
        t.tags = j.tags;
        t.note = j.note;
        t.rating = j.rating;
        if (at) s.state.updatedAt = at;
        close();
        toast('Journal saved', 'ok');
        this.base = reportOf(this.scopeSessions, this.metas, this.trials);
        // new tags must show up in the filter
        const tb = this.toolbar();
        this.toolbarEl?.replaceWith(tb);
        this.toolbarEl = tb;
        this.renderBody();
      } catch (e) {
        save.disabled = false;
        toast(String((e as Error).message ?? e), 'err');
      }
    };
  }

  private exportCsv() {
    const r = this.report;
    if (!r) return;
    const head = ['session', 'id', 'symbol', 'side', 'lots', 'entry', 'exit', 'entry_time_utc', 'exit_time_utc', 'pips', 'r', 'pnl', 'pct_of_equity', 'risk_pct', 'commission_pct', 'mae_pips', 'mfe_pips', 'mae_r', 'mfe_r', 'hold_sec', 'exit_reason', 'order_type', 'trend', 'volatility', 'tags', 'note', 'rating'];
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = r.trades.map((t) => [t.sessionName, t.id, t.symbol, t.side, t.lots, t.entry, t.exit, new Date(t.entryTime * 1000).toISOString(), new Date(t.exitTime * 1000).toISOString(),
      t.pips.toFixed(1), t.r?.toFixed(3) ?? '', t.pnl.toFixed(2), t.pct.toFixed(6), t.riskPct?.toFixed(6) ?? '', t.commissionPct.toFixed(6), t.maePips.toFixed(1), t.mfePips.toFixed(1),
      t.maeR?.toFixed(3) ?? '', t.mfeR?.toFixed(3) ?? '', t.holdSec, t.exitReason, t.orderType, t.trend ?? '', t.vol ?? '', t.tags.join('|'), t.note, t.rating ?? ''].map(q).join(','));
    const name = this.scope.kind === 'all' ? 'all' : this.scope.kind === 'strategy' ? `strategy-${this.strategy?.name ?? this.scope.id}` : this.scopeSessions[0]?.name ?? this.scope.id;
    download(`overflowtrade-${name.replace(/[^\w.-]+/g, '_').slice(0, 60)}.csv`, [head.join(','), ...lines].join('\n'));
  }

  // ---- strategy actions -----------------------------------------------------------------------

  private editStrategy() {
    if (!this.strategy) return;
    strategyModal(this.strategy, this.all, () => this.nav(location.hash));
  }

  private async togglePublish() {
    const st = this.strategy;
    if (!st) return;
    const next = { ...st, published: !st.published, updatedAt: Date.now() };
    try {
      await saveStrategy(next);
      toast(next.published ? 'Published — it is ranked once it meets the rules' : 'Unpublished', 'ok');
      this.nav(location.hash);
    } catch (e) {
      toast(String((e as Error).message ?? e), 'err');
    }
  }
}

/** Why some trades have no market-regime tag (missing data vs. too little history). */
export function regimeCoverage(r: Report): string | null {
  const untagged = r.trades.filter((t) => t.trend == null || t.vol == null);
  if (!untagged.length) return null;
  const missing = untagged.filter((t) => t.synthetic === null);
  const missingSyms = [...new Set(missing.map((t) => t.symbol))];
  const early = untagged.length - missing.length;
  const parts: string[] = [];
  if (missing.length) parts.push(`${missing.length} use ${missingSyms.join(', ')}, whose market data is not on this device (import it on the Data tab)`);
  if (early) parts.push(`${early} entered before enough price history was available (about two weeks of 4-hour bars)`);
  return `Market regime known for ${r.n - untagged.length} of ${r.n} trades: ${parts.join('; ')}.`;
}

function legend(items: { name: string; color: string }[]) {
  return h('div', { class: 'legend' }, ...items.map((i) => h('span', {}, h('i', { style: `background:${i.color}` }), i.name)));
}

/** infoCard with a tool-specific "What it measures" line on top of a shared explanation. */
function infoCardWith(title: string, id: ExplainId, what: string, ...children: (Node | null)[]) {
  return infoCard(title, { id, what }, ...children);
}
