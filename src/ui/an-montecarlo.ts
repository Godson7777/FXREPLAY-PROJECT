import type { Report } from '../analytics/report';
import { DEFAULT_PATH_OPTS, propFirmSim, riskSizing, simulatePaths, type PathSimOptions } from '../analytics/montecarlo';
import { PRESETS } from '../engine/rules';
import { lineChart, barChart } from './charts';
import { h, money, toast } from './dom';
import { infoCard } from './layout';
import { kpi, pctTxt, stackBar } from './an-widgets';

/** Monte Carlo settings live at module level so re-renders (filters, sync) keep them. */
const mc: Pick<PathSimOptions, 'mode' | 'runs' | 'horizon' | 'skip' | 'friction'> = { mode: 'bootstrap', runs: 1000, horizon: 100, skip: 0, friction: 0 };
const prop = { preset: '0', target: 10, daily: 5, total: 10, minDays: 4, trailing: false, risk: 1, days: 60 };
const RISKS = [0.0025, 0.005, 0.01, 0.015, 0.02, 0.03];

const riskTxt = (x: number) => `${+(x * 100).toFixed(2)}%`;
const clampNum = (v: string, lo: number, hi: number, d: number) => {
  const x = Number(v);
  return isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

export function monteCarloCards(r: Report): HTMLElement[] {
  if (r.n < 5) return [infoCard('Monte Carlo', 'mcPaths', h('p', { class: 'muted' }, `Monte Carlo needs at least 5 closed trades (${r.n} so far).`))];
  const rets = r.trades.map((t) => t.pct);
  const fric = r.trades.map((t) => t.frictionPct);
  const units = r.trades.map((t) => t.u);

  // ---- settings ----
  const mode = h('select', {}, h('option', { value: 'bootstrap', selected: mc.mode === 'bootstrap' }, 'Bootstrap (random draws)'), h('option', { value: 'shuffle', selected: mc.mode === 'shuffle' }, 'Shuffle (same trades, new order)'));
  const runs = h('input', { type: 'number', min: 100, max: 5000, step: 100, value: mc.runs });
  const horizon = h('input', { type: 'number', min: 10, max: 2000, step: 10, value: mc.horizon });
  const skip = h('input', { type: 'number', min: 0, max: 50, step: 5, value: Math.round(mc.skip * 100) });
  const extra = h('input', { type: 'number', min: 0, max: 5, step: 0.5, value: mc.friction });
  const runBtn = h('button', { class: 'primary', type: 'button' }, 'Run simulation');
  const syncHorizon = () => {
    horizon.disabled = mode.value === 'shuffle';
    if (mode.value === 'shuffle') horizon.value = String(r.n);
    else if (+horizon.value === r.n && mc.mode === 'shuffle') horizon.value = String(100);
  };
  mode.onchange = syncHorizon;
  const settings = h('div', { class: 'ctl-row' },
    h('label', { class: 'field wide' }, h('span', {}, 'Method'), mode),
    h('label', { class: 'field' }, h('span', {}, 'Simulations'), runs),
    h('label', { class: 'field' }, h('span', {}, 'Trades per path'), horizon),
    h('label', { class: 'field', title: 'Randomly skip this share of trades (missed signals, days off)' }, h('span', {}, 'Skip trades (%)'), skip),
    h('label', { class: 'field', title: 'Extra cost on every trade in units of 1 pip (or 0.01% of price if larger)' }, h('span', {}, 'Extra cost (units)'), extra),
    runBtn,
  );

  const tiles = h('div', { class: 'kpis' });
  const shuffleNote = h('p', { class: 'callout hidden', style: 'margin-top:1rem' }, 'Shuffle mode replays exactly your trades in a random order, so every path ends at the same result. What changes is the route: the drawdowns and losing streaks you could have faced.');
  const fan = h('div', {});
  const ddBox = h('div', {});
  const ruinBox = h('div', {});
  const pathsCard = infoCard('Simulated equity paths', 'mcPaths', settings, tiles, shuffleNote, fan,
    h('p', { class: 'card-note' }, 'Bands: 5th–95th percentile (light) and 25th–75th (dark); the line is the median path. Paths start from the report’s reference balance and compound by % of equity.'));
  const ddCard = infoCard('Maximum drawdown across simulations', 'mcDrawdown', ddBox);
  const ruinCard = infoCard('Probability of a drawdown', 'mcRuin', ruinBox);

  const draw = () => {
    mc.mode = mode.value === 'shuffle' ? 'shuffle' : 'bootstrap';
    const maxRuns = mc.mode === 'shuffle' ? Math.max(100, Math.floor(5e6 / (r.n + 1))) : 5000;
    mc.runs = Math.round(clampNum(runs.value, 100, Math.min(5000, maxRuns), 1000));
    if (mc.mode === 'bootstrap') mc.horizon = Math.round(clampNum(horizon.value, 10, 2000, 100));
    mc.skip = clampNum(skip.value, 0, 50, 0) / 100;
    mc.friction = clampNum(extra.value, 0, 5, 0);
    runs.value = String(mc.runs);
    if (mc.mode === 'bootstrap') horizon.value = String(mc.horizon);
    skip.value = String(Math.round(mc.skip * 100));
    extra.value = String(mc.friction);
    const res = simulatePaths(rets, fric, { ...DEFAULT_PATH_OPTS, ...mc, seed: 7 });
    tiles.innerHTML = '';
    fan.innerHTML = '';
    ddBox.innerHTML = '';
    ruinBox.innerHTML = '';
    if (!res) {
      fan.append(h('p', { class: 'muted' }, 'Not enough trades to simulate.'));
      return;
    }
    const H = res.horizon;
    const init = r.initial;
    shuffleNote.classList.toggle('hidden', mc.mode !== 'shuffle');
    tiles.append(
      kpi('Chance of profit', pctTxt(res.profitProb, 0), res.profitProb >= 0.5 ? 'up' : 'dn', `after ${H} trades · ${res.runs} runs`),
      kpi('Median result', pctTxt(res.final.p50 - 1, 1, true), res.final.p50 >= 1 ? 'up' : 'dn', money(init * res.final.p50)),
      kpi('Bad case (5th pct)', pctTxt(res.final.p5 - 1, 1, true), res.final.p5 >= 1 ? 'up' : 'dn', 'only 5% of paths end lower'),
      kpi('Good case (95th pct)', pctTxt(res.final.p95 - 1, 1, true), res.final.p95 >= 1 ? 'up' : 'dn', 'only 5% of paths end higher'),
      kpi('Median drawdown', pctTxt(-res.dd.p50), 'dn', `95th pct ${pctTxt(-res.dd.p95)} · 99th ${pctTxt(-res.dd.p99)}`),
      kpi('Losing streak', `${Math.round(res.lossStreak.p95)}`, '', `in a row at the 95th pct · median ${Math.round(res.lossStreak.p50)}`),
    );
    const xs = Array.from({ length: H + 1 }, (_, i) => i);
    const toBal = (a: Float64Array) => Array.from(a, (v) => v * init);
    fan.append(lineChart({
      series: [{ name: 'Median', color: 'var(--series-1)', xs, ys: toBal(res.bands.p50), width: 2.5 }],
      band: [
        { xs, lo: toBal(res.bands.p5), hi: toBal(res.bands.p95), color: 'var(--series-1)', opacity: 0.1 },
        { xs, lo: toBal(res.bands.p25), hi: toBal(res.bands.p75), color: 'var(--series-1)', opacity: 0.2 },
      ],
      height: 300, yFmt: (v) => money(v), xFmt: (v) => `#${Math.round(v)}`, baseline: init,
    }));
    ddBox.append(barChart({
      items: res.ddHist.map((b) => ({
        label: isFinite(b.hi) ? `${+(b.lo * 100).toFixed(1)}%` : `${+(b.lo * 100).toFixed(1)}%+`,
        value: (b.count / res.runs) * 100,
        color: b.lo >= 0.3 ? 'var(--bad)' : b.lo >= 0.2 ? 'var(--warn)' : 'var(--series-2)',
        tip: `<b>${((b.count / res.runs) * 100).toFixed(1)}%</b> of paths had a max drawdown of ${+(b.lo * 100).toFixed(1)}${isFinite(b.hi) ? `–${+(b.hi * 100).toFixed(1)}` : '+'}%`,
      })),
      yFmt: (v) => `${v.toFixed(0)}%`, height: 220,
    }), h('p', { class: 'card-note' }, `Median ${pctTxt(-res.dd.p50)} · 75th pct ${pctTxt(-res.dd.p75)} · 95th pct ${pctTxt(-res.dd.p95)} · worst ${pctTxt(-res.dd.max)} (actual test: ${pctTxt(-r.risk.maxDD)}).`));
    ruinBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Drawdown of at least'), h('th', { class: 'r' }, `Probability within ${H} trades`))),
      h('tbody', {}, ...res.ruin.map((x) => h('tr', {}, h('td', {}, pctTxt(x.level, 0)), h('td', { class: `r ${x.prob >= 0.2 ? 'dn' : x.prob <= 0.05 ? 'up' : ''}` }, pctTxt(x.prob, 1))))))),
      h('p', { class: 'card-note' }, `At the risk used in this test. Use the position-sizing table below to see other risk levels.`));
  };
  runBtn.onclick = () => {
    draw();
    toast(`Ran ${mc.runs} simulations`, 'ok');
  };
  syncHorizon();
  draw();

  // ---- position sizing ----
  const sizing = riskSizing(units, RISKS, 1000, Math.max(100, Math.min(500, r.n)), 11);
  const best = [...sizing].reverse().find((x) => x.p95DD <= 0.2 && x.probRuin < 0.01);
  const yours = r.robustness.medianRiskPct;
  const closest = yours != null ? RISKS.reduce((a, b) => (Math.abs(b - yours) < Math.abs(a - yours) ? b : a)) : null;
  const sizeHorizon = Math.max(100, Math.min(500, r.n));
  const sizingCard = infoCard(`Position sizing — ${sizeHorizon} trades ahead`, 'mcSizing',
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ...['Risk per trade', 'Median return', 'Bad case (5th)', 'Median max DD', 'Max DD (95th)', 'P(DD ≥ 20%)', 'P(DD ≥ 50%)', ''].map((t, i) => h('th', { class: i ? 'r' : '' }, t)))),
      h('tbody', {}, ...sizing.map((x) => h('tr', { class: x === best ? 'hl' : '' },
        h('td', {}, h('b', {}, riskTxt(x.risk))),
        h('td', { class: `r ${x.medianReturn >= 0 ? 'up' : 'dn'}` }, pctTxt(x.medianReturn, 1, true)),
        h('td', { class: `r ${x.p5Return >= 0 ? 'up' : 'dn'}` }, pctTxt(x.p5Return, 1, true)),
        h('td', { class: 'r' }, pctTxt(-x.medianDD)),
        h('td', { class: `r ${x.p95DD > 0.3 ? 'dn' : ''}` }, pctTxt(-x.p95DD)),
        h('td', { class: 'r' }, pctTxt(x.probDD20, 1)),
        h('td', { class: `r ${x.probRuin >= 0.01 ? 'dn' : ''}` }, pctTxt(x.probRuin, 1)),
        h('td', { class: 'r' }, [x === best ? 'Suggested' : '', x.risk === closest ? 'Your risk' : ''].filter(Boolean).join(' · ')),
      ))))),
    h('p', { class: 'card-note' }, best
      ? `Suggested: up to ${riskTxt(best.risk)} per trade — the largest size whose 95th-percentile drawdown stays within 20% with under 1% chance of a 50% drawdown.${r.unit === 'ALU' ? ' Without stop losses, "risk" here means the size of an average loss.' : ''}`
      : `Even 0.25% risk per trade gives a 95th-percentile drawdown above 20% — improve the edge before sizing up.${r.unit === 'ALU' ? ' Without stop losses, "risk" here means the size of an average loss.' : ''}`));

  // ---- prop-firm simulator ----
  const presetSel = h('select', {}, ...PRESETS.map((p, i) => h('option', { value: String(i), selected: prop.preset === String(i) }, p.name)), h('option', { value: 'custom', selected: prop.preset === 'custom' }, 'Custom rules'));
  const fTarget = h('input', { type: 'number', min: 1, max: 50, step: 0.5, value: prop.target });
  const fDaily = h('input', { type: 'number', min: 0, max: 50, step: 0.5, value: prop.daily });
  const fTotal = h('input', { type: 'number', min: 1, max: 50, step: 0.5, value: prop.total });
  const fMin = h('input', { type: 'number', min: 0, max: 60, step: 1, value: prop.minDays });
  const fTrail = h('input', { type: 'checkbox', checked: prop.trailing });
  const fRisk = h('input', { type: 'number', min: 0.1, max: 5, step: 0.25, value: prop.risk });
  const fDays = h('input', { type: 'number', min: 5, max: 250, step: 5, value: prop.days });
  const propBtn = h('button', { class: 'primary', type: 'button' }, 'Simulate challenge');
  const propOut = h('div', {});
  presetSel.onchange = () => {
    const p = PRESETS[+presetSel.value];
    if (presetSel.value !== 'custom' && p) {
      fTarget.value = String(p.profitTarget);
      fDaily.value = String(p.maxDailyLoss);
      fTotal.value = String(p.maxTotalLoss);
      fMin.value = String(p.minTradingDays);
      fTrail.checked = p.trailingDrawdown;
    }
  };
  for (const el of [fTarget, fDaily, fTotal, fMin]) el.addEventListener('input', () => (presetSel.value = 'custom'));
  fTrail.addEventListener('change', () => (presetSel.value = 'custom'));
  const runProp = () => {
    prop.preset = presetSel.value;
    prop.target = clampNum(fTarget.value, 1, 50, 10);
    prop.daily = clampNum(fDaily.value, 0, 50, 5);
    prop.total = clampNum(fTotal.value, 1, 50, 10);
    prop.minDays = Math.round(clampNum(fMin.value, 0, 60, 4));
    prop.trailing = fTrail.checked;
    prop.risk = clampNum(fRisk.value, 0.1, 5, 1);
    prop.days = Math.round(clampNum(fDays.value, 5, 250, 60));
    fTarget.value = String(prop.target);
    fDaily.value = String(prop.daily);
    fTotal.value = String(prop.total);
    fMin.value = String(prop.minDays);
    fRisk.value = String(prop.risk);
    fDays.value = String(prop.days);
    const res = propFirmSim(units.map((u) => u * (prop.risk / 100)), r.daily.count.length ? r.daily.count : [1], {
      profitTarget: prop.target / 100, maxDailyLoss: prop.daily / 100, maxTotalLoss: prop.total / 100, minTradingDays: prop.minDays, trailingDrawdown: prop.trailing,
    }, 2000, prop.days, 21);
    propOut.innerHTML = '';
    if (!res) {
      propOut.append(h('p', { class: 'muted' }, 'Not enough trades to simulate.'));
      return;
    }
    propOut.append(
      h('div', { class: 'kpis small' },
        kpi('Pass', pctTxt(res.pass, 0), res.pass >= 0.5 ? 'up' : 'dn', res.medianDays != null ? `median ${Math.round(res.medianDays)} days (${Math.round(res.p25Days ?? 0)}–${Math.round(res.p75Days ?? 0)})` : 'never reached the target'),
        kpi('Fail: daily loss', pctTxt(res.failDaily, 0), res.failDaily > 0.2 ? 'dn' : '', prop.daily ? `limit −${prop.daily}% in a day` : 'no daily limit'),
        kpi('Fail: max loss', pctTxt(res.failTotal, 0), res.failTotal > 0.2 ? 'dn' : '', `limit −${prop.total}%${prop.trailing ? ' (trailing)' : ''}`),
        kpi('Unfinished', pctTxt(res.unfinished, 0), '', `no result within ${prop.days} days`),
        kpi('Risk per trade', `${prop.risk}%`, '', `${res.runs.toLocaleString('en-US')} simulated challenges`),
      ),
      stackBar([
        { label: 'Pass', value: res.pass, color: 'var(--good)' },
        { label: 'Fail (daily)', value: res.failDaily, color: 'var(--warn)' },
        { label: 'Fail (max loss)', value: res.failTotal, color: 'var(--bad)' },
        { label: 'Unfinished', value: res.unfinished, color: 'var(--border-strong)' },
      ]),
    );
  };
  propBtn.onclick = runProp;
  const propCard = infoCard('Prop-firm challenge simulator', 'mcProp',
    h('div', { class: 'ctl-row' },
      h('label', { class: 'field wide' }, h('span', {}, 'Rules'), presetSel),
      h('label', { class: 'field' }, h('span', {}, 'Profit target %'), fTarget),
      h('label', { class: 'field' }, h('span', {}, 'Max daily loss %'), fDaily),
      h('label', { class: 'field' }, h('span', {}, 'Max total loss %'), fTotal),
      h('label', { class: 'field' }, h('span', {}, 'Min trading days'), fMin),
      h('label', { class: 'field' }, h('span', {}, 'Risk per trade %'), fRisk),
      h('label', { class: 'field' }, h('span', {}, 'Time limit (days)'), fDays),
      h('label', { class: 'check', style: 'height:2.5rem' }, fTrail, ' Trailing max loss'),
      propBtn,
    ),
    propOut);
  runProp();

  const g = h('div', { class: 'grid2' }, ddCard, ruinCard);
  return [pathsCard, g, sizingCard, propCard];
}
