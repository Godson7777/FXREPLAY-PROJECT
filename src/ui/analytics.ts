import type { Trade } from '../engine/broker';
import type { Session } from '../engine/replay';
import { computeStats, groupBy, monteCarlo, rHistogram, sessionOf, SESSIONS, DOW, holdBucket, HOLD_BUCKETS, type Group } from '../analytics/stats';
import { offsetFn, fmtLocal, fmtDuration } from '../core/tz';
import { lineChart, barChart, scatter, showTip, hideTip } from './charts';
import { h, money, pct, num, cls, modal, field, download, esc } from './dom';
import { getShot, saveSession } from '../data/sessions';

type Metric = 'pnl' | 'r' | 'winrate' | 'count';
interface Row extends Trade {
  session: string;
  sessionId: string;
  tz: string;
}

export class AnalyticsView {
  root: HTMLDivElement;
  private body: HTMLDivElement;
  private filters = { symbol: '', side: '', tag: '', reason: '', from: '', to: '' };
  private metric: Metric = 'pnl';
  private sort: { key: keyof Row; dir: 1 | -1 } = { key: 'exitTime', dir: -1 };
  private mc = { runs: 1000, steps: 100, ruin: 30 };

  constructor(
    private sessions: Session[],
    private selectedId: string | 'all',
    private nav: (hash: string) => void,
  ) {
    this.body = h('div', { class: 'an-body' });
    this.root = h('div', { class: 'an' }, this.header(), this.body);
    this.render();
  }

  private get scope(): Session[] {
    return this.selectedId === 'all' ? this.sessions : this.sessions.filter((s) => s.id === this.selectedId);
  }

  private allRows(): Row[] {
    return this.scope.flatMap((s) => s.state.broker.trades.map((t) => ({ ...t, session: s.name, sessionId: s.id, tz: s.timezone })));
  }

  private rows(): Row[] {
    const f = this.filters;
    const from = f.from ? Date.parse(f.from) / 1000 : -Infinity;
    const to = f.to ? Date.parse(f.to) / 1000 + 86400 : Infinity;
    return this.allRows().filter((t) =>
      (!f.symbol || t.symbol === f.symbol) && (!f.side || t.side === f.side) && (!f.tag || t.tags.includes(f.tag)) &&
      (!f.reason || t.exitReason === f.reason) && t.exitTime >= from && t.exitTime < to);
  }

  private header() {
    const sel = h('select', { class: 'sess-select' },
      h('option', { value: 'all', selected: this.selectedId === 'all' }, 'All sessions combined'),
      ...this.sessions.map((s) => h('option', { value: s.id, selected: s.id === this.selectedId }, s.name)));
    sel.onchange = () => this.nav(`#/analytics/${sel.value}`);
    const back = this.selectedId !== 'all'
      ? h('button', { class: 'ghost', onclick: () => this.nav(`#/replay/${this.selectedId}`) }, '▶ Back to replay')
      : null;
    return h('header', { class: 'topbar' },
      h('button', { class: 'ghost', onclick: () => this.nav('#/') }, '← Sessions'),
      h('div', { class: 'brand-sm' }, h('b', {}, 'Analytics'), h('small', {}, 'Performance deep-dive')),
      sel,
      h('div', { class: 'spacer' }),
      back,
      h('button', { class: 'ghost', onclick: () => this.exportCsv() }, '⭳ Export CSV'),
    );
  }

  private initialBalance() {
    return this.scope.reduce((a, s) => a + s.balance, 0) || 10000;
  }

  render() {
    this.body.innerHTML = '';
    const all = this.allRows();
    const rows = this.rows();
    this.body.append(this.filterBar(all));
    if (!rows.length) {
      this.body.append(h('div', { class: 'empty-state' },
        h('h2', {}, all.length ? 'No trades match these filters' : 'No closed trades yet'),
        h('p', {}, all.length ? 'Clear a filter to see results.' : 'Open a session, replay the market and take some trades — every closed trade feeds these analytics.')));
      return;
    }
    const init = this.initialBalance();
    const st = computeStats(rows, init);
    const tzName = this.scope[0]?.timezone ?? 'UTC';
    const off = offsetFn(tzName);

    // --- hero KPIs
    this.body.append(h('section', { class: 'kpis' },
      tile('Net P&L', money(st.netPnl, true), cls(st.netPnl), `${pct(st.returnPct, 2, true)} on ${money(init)}`),
      tile('Win rate', pct(st.winRate), '', `${st.wins}W · ${st.losses}L · ${st.breakeven} BE`),
      tile('Profit factor', num(st.profitFactor), st.profitFactor >= 1 ? 'up' : 'dn', `Gross ${money(st.grossProfit)} / ${money(-st.grossLoss)}`),
      tile('Expectancy', st.expectancyR != null ? `${num(st.expectancyR, 2, true)}R` : money(st.expectancy, true), cls(st.expectancy), `${money(st.expectancy, true)} per trade`),
      tile('Max drawdown', pct(-st.maxDDPct, 2), 'dn', `${money(-st.maxDD)} · ${fmtDuration(st.maxDDDurationSec)} underwater`),
      tile('Total R', st.totalR != null ? `${num(st.totalR, 1, true)}R` : '—', cls(st.totalR ?? 0), `${st.trades} trades`),
    ));

    // --- detail stats grid
    const S = (k: string, v: string, c = '', title = '') => h('div', { class: 'stat', title }, h('span', {}, k), h('b', { class: c }, v));
    this.body.append(card('Key statistics', h('div', { class: 'stats-grid' },
      S('Avg win', money(st.avgWin), 'up'), S('Avg loss', money(st.avgLoss), 'dn'), S('Payoff ratio', num(st.payoff), '', 'Avg win / avg loss'),
      S('Largest win', money(st.largestWin), 'up'), S('Largest loss', money(st.largestLoss), 'dn'), S('Commission paid', money(-st.commission)),
      S('Avg win (R)', st.avgWinR != null ? num(st.avgWinR, 2, true) : '—', 'up'), S('Avg loss (R)', st.avgLossR != null ? num(st.avgLossR, 2, true) : '—', 'dn'),
      S('SQN', st.sqn != null ? num(st.sqn) : '—', '', 'System Quality Number (Van Tharp): >1.6 ok, >2.5 good, >5 superb'),
      S('Sharpe (ann.)', num(st.sharpe), '', 'Annualised by trade frequency on per-trade % returns'), S('Sortino (ann.)', num(st.sortino)),
      S('Recovery factor', num(st.recoveryFactor), '', 'Net profit / max drawdown'),
      S('Kelly %', pct(st.kellyPct), '', 'Theoretical optimal risk fraction — use a fraction of it'),
      S('Max win streak', `${st.maxWinStreak}`), S('Max loss streak', `${st.maxLossStreak}`),
      S('Current streak', st.currentStreak ? `${Math.abs(st.currentStreak)} ${st.currentStreak > 0 ? 'wins' : 'losses'}` : '—', cls(st.currentStreak)),
      S('Avg hold', fmtDuration(st.avgHoldSec)), S('Avg hold · winners', fmtDuration(st.avgHoldWinSec)), S('Avg hold · losers', fmtDuration(st.avgHoldLossSec)),
      S('Longs', `${st.longs} · ${pct(st.longWinRate)} WR`), S('Shorts', `${st.shorts} · ${pct(st.shortWinRate)} WR`),
      S('Avg MAE', st.avgMaeR != null ? `${num(st.avgMaeR)}R` : '—', '', 'How far trades went against you on average'),
      S('Avg MFE', st.avgMfeR != null ? `${num(st.avgMfeR)}R` : '—', '', 'How far trades went in your favour on average'),
      S('Edge ratio', st.edgeRatio != null ? num(st.edgeRatio) : '—', '', 'Avg MFE / avg MAE — above 1 means entries have an edge'),
      S('TP hit rate', pct(st.tpHitRate)), S('SL hit rate', pct(st.slHitRate)),
      S('Best day', money(st.bestDay, true), 'up'), S('Worst day', money(st.worstDay, true), 'dn'),
      S('Profitable days', pct(st.profitableDaysPct)), S('Trades / active day', num(st.avgTradesPerDay, 1)),
    )));

    // --- equity & drawdown
    const sorted = [...rows].sort((a, b) => a.exitTime - b.exitTime);
    const xs = [sorted[0].entryTime, ...sorted.map((t) => t.exitTime)].map((t) => t + off(t));
    const eq: number[] = [init];
    for (const t of sorted) eq.push(eq[eq.length - 1] + t.pnl);
    const dd: number[] = [];
    let pk = -Infinity;
    for (const v of eq) {
      pk = Math.max(pk, v);
      dd.push(pk ? ((v - pk) / pk) * 100 : 0);
    }
    const eqSeries = [{ name: 'Closed balance', color: 'var(--series-1)', xs, ys: eq, area: true }];
    const filtered = Object.values(this.filters).some(Boolean);
    if (this.scope.length === 1 && !filtered) {
      const e = this.scope[0].state.broker.equity;
      if (e.length > 2) {
        const step = Math.ceil(e.length / 1500);
        const es = e.filter((_, i) => i % step === 0 || i === e.length - 1);
        eqSeries.push({ name: 'Equity (incl. floating)', color: 'var(--series-2)', xs: es.map((p) => p.t + off(p.t)), ys: es.map((p) => p.equity), area: false });
      }
    }
    const span = xs[xs.length - 1] - xs[0];
    const dFmt = (t: number) => (span < 5 * 86400 ? fmtLocal(t).slice(5) : fmtLocal(t).slice(0, 10));
    this.body.append(
      card('Equity curve', lineChart({ series: eqSeries, height: 280, yFmt: (v) => money(v), xFmt: dFmt, baseline: init }), eqSeries.length > 1 ? legend(eqSeries) : null),
      card('Drawdown (underwater)', lineChart({ series: [{ name: 'Drawdown', color: 'var(--bad)', xs, ys: dd, area: true }], height: 160, yFmt: (v) => `${v.toFixed(1)}%`, xFmt: dFmt, baseline: 0, zeroArea: true })),
    );

    // --- breakdowns
    const hourOf = (t: Row) => new Date((t.entryTime + offsetFn(t.tz)(t.entryTime)) * 1000).getUTCHours();
    const dowOf = (t: Row) => DOW[(new Date((t.entryTime + offsetFn(t.tz)(t.entryTime)) * 1000).getUTCDay() + 6) % 7];
    const monthOf = (t: Row) => fmtLocal(t.exitTime + offsetFn(t.tz)(t.exitTime)).slice(0, 7);
    // psychology: result of previous trade, and trade number within the day
    const prevRes = new Map<Row, string>();
    const nthOfDay = new Map<Row, string>();
    let prev: Row | null = null;
    const dayCount = new Map<string, number>();
    for (const t of [...rows].sort((a, b) => a.entryTime - b.entryTime)) {
      prevRes.set(t, prev ? (prev.pnl > 0 ? 'After a win' : prev.pnl < 0 ? 'After a loss' : 'After BE') : 'First trade');
      const d = t.sessionId + fmtLocal(t.entryTime + offsetFn(t.tz)(t.entryTime)).slice(0, 10);
      const n = (dayCount.get(d) || 0) + 1;
      dayCount.set(d, n);
      nthOfDay.set(t, n >= 4 ? '4th+ trade' : `${['1st', '2nd', '3rd'][n - 1]} trade`);
      prev = t;
    }

    const metricSel = h('div', { class: 'segs' }, ...(['pnl', 'r', 'winrate', 'count'] as Metric[]).map((m) =>
      h('button', { class: `seg${this.metric === m ? ' on' : ''}`, onclick: () => { this.metric = m; this.render(); } }, { pnl: 'Net P&L', r: 'Avg R', winrate: 'Win rate', count: 'Trades' }[m])));
    this.body.append(h('div', { class: 'section-head' }, h('h2', {}, 'Breakdowns'), metricSel));
    const grid = h('div', { class: 'grid2' });
    const B = (title: string, groups: Group[]) => grid.append(card(title, this.groupChart(groups)));
    B('By day of week (entry)', groupBy(rows, dowOf, DOW));
    B(`By hour of day (entry, ${tzName})`, groupBy(rows, (t) => String(hourOf(t)).padStart(2, '0'), Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))));
    B('By market session (entry, UTC)', groupBy(rows, (t) => sessionOf(t.entryTime), SESSIONS));
    B('By symbol', groupBy(rows, (t) => t.symbol));
    B('Long vs short', groupBy(rows, (t) => (t.side === 'long' ? 'Long' : 'Short'), ['Long', 'Short']));
    B('By setup / tag', groupBy(rows, (t) => (t.tags.length ? t.tags : ['(untagged)'])));
    B('By exit reason', groupBy(rows, (t) => t.exitReason.toUpperCase(), ['TP', 'SL', 'BE', 'TRAIL', 'MANUAL', 'END']));
    B('By holding time', groupBy(rows, (t) => holdBucket(t.holdSec), HOLD_BUCKETS));
    B('By order type', groupBy(rows, (t) => t.orderType, ['market', 'limit', 'stop']));
    B('By month', groupBy(rows, monthOf));
    B('Psychology: result of previous trade', groupBy(rows, (t) => prevRes.get(t)!, ['First trade', 'After a win', 'After a loss', 'After BE']));
    B('Overtrading: Nth trade of the day', groupBy(rows, (t) => nthOfDay.get(t)!, ['1st trade', '2nd trade', '3rd trade', '4th+ trade']));
    if (rows.some((t) => t.rating)) B('By self-rating', groupBy(rows, (t) => (t.rating ? '★'.repeat(t.rating) : 'unrated')));
    this.body.append(grid);

    // --- distributions
    const hist = rHistogram(rows);
    const g2 = h('div', { class: 'grid2' });
    if (rows.some((t) => t.r != null)) {
      g2.append(card('R-multiple distribution', barChart({
        items: hist.map((b) => ({ label: `${b.lo}`, value: b.count, color: b.lo >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<b>${b.count}</b> trades between ${b.lo}R and ${b.hi}R` })),
        yFmt: (v) => String(Math.round(v)), height: 220,
      })));
      const mm = rows.filter((t) => t.maeR != null);
      g2.append(card('MAE vs MFE (in R) — are stops too tight, targets too close?', scatter({
        points: mm.map((t) => ({ x: t.maeR!, y: t.mfeR!, color: t.pnl >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<div class="tt-h">#${t.id} ${t.symbol} ${t.side}</div>MAE ${num(t.maeR, 2)}R · MFE ${num(t.mfeR, 2)}R<br>Result <b>${num(t.r, 2, true)}R</b> (${money(t.pnl, true)})` })),
        xFmt: (v) => `${v.toFixed(1)}R`, yFmt: (v) => `${v.toFixed(1)}R`, xLabel: 'Max adverse excursion (R)', yLabel: 'Max favourable excursion (R)', diagonal: true,
      }), legend([{ name: 'Winner', color: 'var(--good)' }, { name: 'Loser', color: 'var(--bad)' }])));
      g2.append(card('Left on the table: MFE vs realised R', scatter({
        points: mm.map((t) => ({ x: t.mfeR!, y: t.r ?? 0, color: t.pnl >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<div class="tt-h">#${t.id}</div>Peak ${num(t.mfeR, 2)}R → closed ${num(t.r, 2, true)}R` })),
        xFmt: (v) => `${v.toFixed(1)}R`, yFmt: (v) => `${v.toFixed(1)}R`, xLabel: 'Max favourable excursion (R)', yLabel: 'Realised R', diagonal: true,
      })));
    }
    g2.append(card('Holding time vs result', scatter({
      points: rows.map((t) => ({ x: t.holdSec / 3600, y: t.pnl, color: t.pnl >= 0 ? 'var(--good)' : 'var(--bad)', tip: `<div class="tt-h">#${t.id} ${t.symbol}</div>Held ${fmtDuration(t.holdSec)} · <b>${money(t.pnl, true)}</b>` })),
      xFmt: (v) => `${v.toFixed(0)}h`, yFmt: (v) => money(v), xLabel: 'Hours held', yLabel: 'P&L',
    })));
    this.body.append(h('div', { class: 'section-head' }, h('h2', {}, 'Distributions')), g2);

    // --- calendar & monthly table
    this.body.append(h('div', { class: 'section-head' }, h('h2', {}, 'Calendar')));
    this.body.append(card('Daily P&L', this.calendar(rows)));
    this.body.append(card('Monthly returns', this.monthlyTable(rows, init)));

    // --- Monte Carlo
    this.body.append(h('div', { class: 'section-head' }, h('h2', {}, 'Monte Carlo simulation')));
    this.body.append(this.monteCarloCard(rows, st.finalBalance));

    // --- trade log
    this.body.append(h('div', { class: 'section-head' }, h('h2', {}, `Trade log (${rows.length})`)));
    this.body.append(card('', this.tradeTable(rows)));
  }

  private filterBar(all: Row[]) {
    const f = this.filters;
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    const mk = (key: keyof typeof f, label: string, opts: string[]) => {
      const s = h('select', {}, h('option', { value: '' }, `All ${label}`), ...opts.map((o) => h('option', { value: o, selected: f[key] === o }, o)));
      s.onchange = () => {
        f[key] = s.value;
        this.render();
      };
      return s;
    };
    const date = (key: 'from' | 'to', title: string) => {
      const i = h('input', { type: 'date', value: f[key], title });
      i.onchange = () => {
        f[key] = i.value;
        this.render();
      };
      return i;
    };
    const clear = h('button', { class: 'ghost sm', onclick: () => { Object.keys(f).forEach((k) => (f[k as keyof typeof f] = '')); this.render(); } }, 'Clear');
    return h('div', { class: 'filters' },
      mk('symbol', 'symbols', uniq(all.map((t) => t.symbol))),
      mk('side', 'sides', ['long', 'short']),
      mk('tag', 'tags', uniq(all.flatMap((t) => t.tags))),
      mk('reason', 'exits', uniq(all.map((t) => t.exitReason))),
      date('from', 'From (exit date)'), date('to', 'To (exit date)'),
      Object.values(f).some(Boolean) ? clear : null,
    );
  }

  private groupChart(groups: Group[]) {
    const m = this.metric;
    const val = (g: Group) => (m === 'pnl' ? g.pnl : m === 'r' ? g.avgR ?? 0 : m === 'winrate' ? g.winRate * 100 : g.trades);
    const fmt = (v: number) => (m === 'pnl' ? money(v) : m === 'r' ? `${v.toFixed(2)}R` : m === 'winrate' ? `${v.toFixed(0)}%` : String(Math.round(v)));
    const neutral = m === 'count' || m === 'winrate';
    return barChart({
      items: groups.map((g) => ({
        label: g.key, value: val(g), color: neutral ? 'var(--series-1)' : undefined,
        tip: `<div>Trades <b>${g.trades}</b></div><div>Win rate <b>${pct(g.winRate)}</b></div><div>Net <b>${money(g.pnl, true)}</b></div><div>Avg R <b>${g.avgR != null ? num(g.avgR, 2, true) : '—'}</b></div><div>PF <b>${num(g.pf)}</b></div>`,
      })),
      yFmt: fmt, height: 210, showValues: true,
    });
  }

  private calendar(rows: Row[]) {
    const days = new Map<string, { pnl: number; n: number }>();
    for (const t of rows) {
      const d = fmtLocal(t.exitTime + offsetFn(t.tz)(t.exitTime)).slice(0, 10);
      const x = days.get(d) ?? { pnl: 0, n: 0 };
      x.pnl += t.pnl;
      x.n++;
      days.set(d, x);
    }
    const keys = [...days.keys()].sort();
    const maxAbs = Math.max(...[...days.values()].map((v) => Math.abs(v.pnl)), 1);
    const first = new Date(keys[0] + 'T00:00:00Z'), last = new Date(keys[keys.length - 1] + 'T00:00:00Z');
    const wrap = h('div', { class: 'cal-wrap' });
    for (let y = first.getUTCFullYear(), mo = first.getUTCMonth(); y < last.getUTCFullYear() || (y === last.getUTCFullYear() && mo <= last.getUTCMonth()); mo === 11 ? (y++, (mo = 0)) : mo++) {
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
          const a = 0.18 + 0.72 * Math.min(1, Math.abs(v.pnl) / maxAbs);
          cell.style.setProperty('--a', a.toFixed(2));
          cell.append(h('small', {}, compact(v.pnl)));
          cell.addEventListener('mousemove', (e) => showTip(e, `<div class="tt-h">${k}</div><b>${money(v.pnl, true)}</b> · ${v.n} trade${v.n > 1 ? 's' : ''}`));
          cell.addEventListener('mouseleave', hideTip);
        }
        grid.append(cell);
      }
      wrap.append(h('div', { class: 'cal-month' },
        h('div', { class: 'cal-title' }, h('b', {}, monthStart.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })), h('span', { class: cls(total) }, money(total, true))),
        grid));
    }
    return wrap;
  }

  private monthlyTable(rows: Row[], init: number) {
    const map = new Map<string, number>();
    for (const t of rows) {
      const k = fmtLocal(t.exitTime + offsetFn(t.tz)(t.exitTime)).slice(0, 7);
      map.set(k, (map.get(k) || 0) + t.pnl);
    }
    const years = [...new Set([...map.keys()].map((k) => k.slice(0, 4)))].sort();
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const t = h('table', { class: 'tbl monthly' }, h('thead', { html: `<tr><th>Year</th>${M.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr>` }));
    const tb = h('tbody');
    for (const y of years) {
      let tot = 0;
      const tr = h('tr', {}, h('td', {}, h('b', {}, y)));
      for (let m = 1; m <= 12; m++) {
        const v = map.get(`${y}-${String(m).padStart(2, '0')}`);
        if (v != null) tot += v;
        tr.append(h('td', { class: v == null ? 'muted' : cls(v), title: v != null ? money(v, true) : '' }, v == null ? '·' : pct(v / init, 1, true)));
      }
      tr.append(h('td', { class: cls(tot) }, h('b', {}, pct(tot / init, 1, true))));
      tb.append(tr);
    }
    t.append(tb);
    return h('div', { class: 'table-wrap' }, t);
  }

  private monteCarloCard(rows: Row[], startBal: number) {
    const out = h('div', {});
    const runs = h('input', { type: 'number', value: this.mc.runs, min: 100, max: 10000, step: 100, class: 'sm' });
    const steps = h('input', { type: 'number', value: this.mc.steps, min: 10, max: 2000, step: 10, class: 'sm' });
    const ruin = h('input', { type: 'number', value: this.mc.ruin, min: 5, max: 95, step: 5, class: 'sm' });
    const go = h('button', { class: 'primary sm' }, 'Run');
    const draw = () => {
      this.mc = { runs: +runs.value, steps: +steps.value, ruin: +ruin.value };
      const mc = monteCarlo(rows, startBal, this.mc.runs, this.mc.steps, this.mc.ruin / 100);
      out.innerHTML = '';
      if (!mc) {
        out.append(h('p', { class: 'muted' }, 'Need at least 5 trades to simulate.'));
        return;
      }
      const xs = mc.bands.p50.map((_, i) => i);
      out.append(
        h('div', { class: 'kpis small' },
          tile('Median outcome', money(mc.finalP50), cls(mc.finalP50 - startBal), `after ${mc.steps} more trades`),
          tile('5th–95th pct', `${compact(mc.finalP5)} – ${compact(mc.finalP95)}`, '', 'range of final balance'),
          tile('Chance of profit', pct(mc.profitProb), '', `${mc.runs} simulations`),
          tile('Median max DD', pct(-mc.ddP50), 'dn', `95th pct: ${pct(-mc.ddP95)}`),
          tile(`Risk of ${this.mc.ruin}% DD`, pct(mc.ruinProb), mc.ruinProb > 0.1 ? 'dn' : '', 'probability of hitting it'),
        ),
        lineChart({
          series: [{ name: 'Median', color: 'var(--series-1)', xs, ys: mc.bands.p50 }],
          band: [
            { xs, lo: mc.bands.p5, hi: mc.bands.p95, color: 'var(--series-1)', opacity: 0.12 },
            { xs, lo: mc.bands.p25, hi: mc.bands.p75, color: 'var(--series-1)', opacity: 0.22 },
          ],
          height: 260, yFmt: (v) => money(v), xFmt: (v) => `#${Math.round(v)}`, baseline: startBal,
        }),
        h('p', { class: 'muted small' }, 'Bands: 5–95th percentile (light) and 25–75th (dark). Trades are resampled with replacement as % of balance, so position sizing compounds.'),
      );
    };
    go.onclick = draw;
    draw();
    return card('Resampled future equity paths', h('div', { class: 'stack' },
      h('div', { class: 'filters' }, field('Simulations', runs), field('Trades ahead', steps), field('Ruin = drawdown of (%)', ruin), go), out));
  }

  private tradeTable(rows: Row[]) {
    const cols: { key: keyof Row; label: string; fmt: (t: Row) => string; cls?: (t: Row) => string }[] = [
      { key: 'id', label: '#', fmt: (t) => String(t.id) },
      ...(this.selectedId === 'all' ? [{ key: 'session' as keyof Row, label: 'Session', fmt: (t: Row) => t.session }] : []),
      { key: 'symbol', label: 'Symbol', fmt: (t) => t.symbol },
      { key: 'side', label: 'Side', fmt: (t) => t.side.toUpperCase(), cls: (t) => (t.side === 'long' ? 'up' : 'dn') },
      { key: 'entryTime', label: 'Entry', fmt: (t) => fmtLocal(t.entryTime + offsetFn(t.tz)(t.entryTime)) },
      { key: 'exitTime', label: 'Exit', fmt: (t) => fmtLocal(t.exitTime + offsetFn(t.tz)(t.exitTime)) },
      { key: 'lots', label: 'Lots', fmt: (t) => t.lots.toFixed(2) },
      { key: 'pips', label: 'Pips', fmt: (t) => num(t.pips, 1, true), cls: (t) => cls(t.pips) },
      { key: 'r', label: 'R', fmt: (t) => (t.r != null ? num(t.r, 2, true) : '—'), cls: (t) => cls(t.r ?? 0) },
      { key: 'pnl', label: 'P&L', fmt: (t) => money(t.pnl, true), cls: (t) => cls(t.pnl) },
      { key: 'maeR', label: 'MAE R', fmt: (t) => num(t.maeR, 2) },
      { key: 'mfeR', label: 'MFE R', fmt: (t) => num(t.mfeR, 2) },
      { key: 'holdSec', label: 'Held', fmt: (t) => fmtDuration(t.holdSec) },
      { key: 'exitReason', label: 'Exit', fmt: (t) => t.exitReason.toUpperCase() },
      { key: 'tags', label: 'Tags', fmt: (t) => t.tags.join(', ') },
      { key: 'note', label: 'Note', fmt: (t) => (t.note.length > 40 ? t.note.slice(0, 40) + '…' : t.note) },
    ];
    const sorted = [...rows].sort((a, b) => {
      const va = a[this.sort.key] as unknown, vb = b[this.sort.key] as unknown;
      const x = typeof va === 'number' || typeof vb === 'number' ? ((va as number) ?? -Infinity) - ((vb as number) ?? -Infinity) : String(va).localeCompare(String(vb));
      return x * this.sort.dir;
    });
    const thead = h('thead', {}, h('tr', {}, ...cols.map((c) => {
      const th = h('th', { class: 'sortable' }, c.label, this.sort.key === c.key ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '');
      th.onclick = () => {
        this.sort = { key: c.key, dir: this.sort.key === c.key ? ((-this.sort.dir) as 1 | -1) : -1 };
        this.render();
      };
      return th;
    })));
    const tb = h('tbody');
    for (const t of sorted.slice(0, 2000)) {
      const tr = h('tr', { class: 'clickable' }, ...cols.map((c) => h('td', { class: c.cls?.(t) ?? '' }, c.fmt(t))));
      tr.onclick = () => this.tradeModal(t);
      tb.append(tr);
    }
    return h('div', { class: 'table-wrap tall' }, h('table', { class: 'tbl' }, thead, tb));
  }

  private tradeModal(r: Row) {
    const s = this.sessions.find((x) => x.id === r.sessionId)!;
    const t = s.state.broker.trades.find((x) => x.id === r.id)!;
    const img = h('img', { class: 'shot', alt: 'Chart when the trade closed' });
    if (t.shot) void getShot(t.shot).then((u) => (u ? (img.src = u) : img.remove()));
    else img.remove();
    const tags = h('input', { value: t.tags.join(', ') });
    const note = h('textarea', { rows: 4 }, t.note);
    const rating = h('select', {}, ...[0, 1, 2, 3, 4, 5].map((x) => h('option', { value: x, selected: (t.rating ?? 0) === x }, x ? '★'.repeat(x) : 'No rating')));
    const save = h('button', { class: 'primary' }, 'Save journal');
    const off = offsetFn(s.timezone);
    const close = modal(`#${t.id} · ${t.symbol} ${t.side.toUpperCase()} · ${esc(s.name)}`, h('div', { class: 'stack' },
      h('div', { class: 'kv-grid' },
        kvb('P&L', money(t.pnl, true), cls(t.pnl)), kvb('R', t.r != null ? num(t.r, 2, true) : '—', cls(t.r ?? 0)), kvb('Pips', num(t.pips, 1, true), cls(t.pips)),
        kvb('Entry', `${t.entry} @ ${fmtLocal(t.entryTime + off(t.entryTime))}`), kvb('Exit', `${t.exit.toFixed(5).replace(/0+$/, '')} @ ${fmtLocal(t.exitTime + off(t.exitTime))}`),
        kvb('Held', fmtDuration(t.holdSec)), kvb('MAE', `${num(t.maePips, 1)} pips`), kvb('MFE', `${num(t.mfePips, 1)} pips`), kvb('Exit by', t.exitReason.toUpperCase()),
      ),
      img, field('Tags', tags), field('Notes', note), field('Rating', rating), save,
    ), { wide: true });
    save.onclick = async () => {
      t.tags = tags.value.split(',').map((x) => x.trim()).filter(Boolean);
      t.note = note.value;
      t.rating = +rating.value || undefined;
      await saveSession(s);
      close();
      this.render();
    };
  }

  private exportCsv() {
    const rows = this.rows();
    const head = ['session', 'id', 'symbol', 'side', 'lots', 'entry', 'exit', 'entry_time_utc', 'exit_time_utc', 'pips', 'r', 'pnl', 'gross', 'commission', 'mae_pips', 'mfe_pips', 'mae_r', 'mfe_r', 'hold_sec', 'exit_reason', 'order_type', 'tags', 'note', 'rating', 'balance_after'];
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((t) => [t.session, t.id, t.symbol, t.side, t.lots, t.entry, t.exit, new Date(t.entryTime * 1000).toISOString(), new Date(t.exitTime * 1000).toISOString(), t.pips.toFixed(1), t.r?.toFixed(3) ?? '', t.pnl.toFixed(2), t.gross.toFixed(2), t.commission.toFixed(2), t.maePips.toFixed(1), t.mfePips.toFixed(1), t.maeR?.toFixed(3) ?? '', t.mfeR?.toFixed(3) ?? '', t.holdSec, t.exitReason, t.orderType, t.tags.join('|'), t.note, t.rating ?? '', t.balanceAfter.toFixed(2)].map(q).join(','));
    download(`trades-${this.selectedId}.csv`, [head.join(','), ...lines].join('\n'));
  }
}

function tile(label: string, value: string, c: string, sub: string) {
  return h('div', { class: 'kpi' }, h('span', {}, label), h('b', { class: c }, value), h('small', {}, sub));
}
function card(title: string, ...children: (HTMLElement | null)[]) {
  return h('section', { class: 'card' }, title ? h('div', { class: 'card-title' }, h('span', {}, title)) : null, ...children);
}
function kvb(k: string, v: string, c = '') {
  return h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: c }, v));
}
function legend(items: { name: string; color: string }[]) {
  return h('div', { class: 'legend' }, ...items.map((i) => h('span', {}, h('i', { style: `background:${i.color}` }), i.name)));
}
function compact(v: number) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(0);
  return `${v < 0 ? '−' : ''}$${s}`;
}
