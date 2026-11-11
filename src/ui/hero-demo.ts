import { CandlestickSeries, ColorType, createChart, LineStyle, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';
import { generateSynthetic } from '../data/synthetic';
import { h, theme } from './dom';
import { countUpText, reduced, scoreRing } from './motion';

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number }

/** 15-minute candles from generated 1-minute data (the same generator as the demo datasets). */
function demoCandles(): Candle[] {
  const b = generateSynthetic({ start: Date.UTC(2025, 2, 3) / 1000, days: 5, price: 1.0942, seed: 11 });
  const out: Candle[] = [];
  for (let i = 0; i < b.n; i++) {
    const t = (Math.floor(b.t[i] / 900) * 900) as UTCTimestamp;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      if (b.h[i] > last.high) last.high = b.h[i];
      if (b.l[i] < last.low) last.low = b.l[i];
      last.close = b.c[i];
    } else out.push({ time: t, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] });
  }
  return out;
}

/**
 * The hero's self-playing replay: candles appear one by one, a simple momentum rule
 * opens trades with a stop and a 2R target, and the tally updates as they close.
 * It is an illustration of the product, labelled as a demo, and it stops when off-screen.
 */
export function heroDemo(): HTMLElement {
  const chartEl = h('div', { class: 'demo-chart' });
  const stat = { n: h('b', {}, '0'), wr: h('b', {}, '—'), r: h('b', {}, '0.0R') };
  const chip = h('span', { class: 'demo-chip' });
  const bar = h('i', {});
  const stage = h('div', { class: 'demo-stage' },
    h('div', { class: 'demo-head' }, h('span', { class: 'demo-sym' }, h('b', {}, 'EURUSD'), ' · 15m'), h('span', { class: 'demo-tag' }, 'Demo replay'), chip),
    chartEl,
    h('div', { class: 'demo-foot' },
      h('div', {}, h('span', {}, 'Trades'), stat.n), h('div', {}, h('span', {}, 'Win rate'), stat.wr), h('div', {}, h('span', {}, 'Result'), stat.r),
      h('div', { class: 'demo-progress' }, bar)),
  );
  const num = h('b', { class: 'demo-score-num' }, '82');
  const side = h('aside', { class: 'demo-score' },
    h('span', { class: 'eyebrow' }, 'Overflow Score · example'),
    scoreRing(82, num),
    h('div', { class: 'demo-grade' }, h('span', { class: 'grade' }, 'A'), h('em', {}, 'All-weather edge')),
    h('ul', {},
      ...([['Profitability', 86], ['Drawdown', 78], ['Consistency', 81], ['Market regimes', 84]] as const).map(([k, v], i) =>
        h('li', {}, h('span', {}, k), h('span', { class: 'bar' }, h('i', { style: `width:${v}%;--i:${i}` })), h('b', {}, String(v))))),
  );
  countUpText(num, 1400);
  const root = h('div', { class: 'demo', 'aria-label': 'Demo: a replay playing bar by bar next to an example Overflow Score' }, stage, side);

  // the chart needs a laid-out element, so start once it is in the page
  requestAnimationFrame(() => start(root, chartEl, stat, chip, bar));
  return root;
}

function start(root: HTMLElement, el: HTMLElement, stat: { n: HTMLElement; wr: HTMLElement; r: HTMLElement }, chip: HTMLElement, bar: HTMLElement) {
  if (!el.isConnected) return;
  const th = theme();
  const chart = createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: th.muted, fontSize: 10, fontFamily: "'Instrument Sans', ui-sans-serif, system-ui, sans-serif", attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: th.grid } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 9 },
    crosshair: { vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
    handleScroll: false, handleScale: false,
  });
  const series = chart.addSeries(CandlestickSeries, { upColor: th.up, downColor: th.down, wickUpColor: th.up, wickDownColor: th.down, borderVisible: false, priceLineVisible: true, lastValueVisible: true, priceFormat: { type: 'price', precision: 5, minMove: 0.00001 } });
  const all = demoCandles();
  const SEED = 110; // start after the quiet opening hours
  let i = 0, trades = 0, wins = 0, sumR = 0;
  let pos: { dir: 1 | -1; entry: number; sl: number; tp: number; lines: IPriceLine[] } | null = null;

  const clearPos = () => {
    pos?.lines.forEach((l) => series.removePriceLine(l));
    pos = null;
  };
  const tally = () => {
    stat.n.textContent = String(trades);
    stat.wr.textContent = trades ? `${Math.round((wins / trades) * 100)}%` : '—';
    stat.r.textContent = `${sumR > 0 ? '+' : sumR < 0 ? '−' : ''}${Math.abs(sumR).toFixed(1)}R`;
    stat.r.className = sumR > 0 ? 'up' : sumR < 0 ? 'dn' : '';
  };
  const say = (text: string, tone: 'up' | 'dn' | '') => {
    chip.textContent = text;
    chip.className = `demo-chip show ${tone}`;
  };
  const reset = () => {
    clearPos();
    i = SEED;
    trades = wins = 0;
    sumR = 0;
    series.setData(all.slice(0, SEED));
    chip.className = 'demo-chip';
    tally();
    chart.timeScale().scrollToRealTime();
  };
  const step = () => {
    if (i >= all.length) return reset();
    const c = all[i++];
    series.update(c);
    bar.style.width = `${((i - SEED) / (all.length - SEED)) * 100}%`;
    if (pos) {
      const p = pos;
      const hitSl = p.dir > 0 ? c.low <= p.sl : c.high >= p.sl;
      const hitTp = p.dir > 0 ? c.high >= p.tp : c.low <= p.tp;
      if (hitSl || hitTp) {
        const r = hitSl ? -1 : 2; // stop first when both are touched in one candle
        trades++;
        if (r > 0) wins++;
        sumR += r;
        say(r > 0 ? 'Target hit · +2.0R' : 'Stopped · −1.0R', r > 0 ? 'up' : 'dn');
        clearPos();
        tally();
      }
    } else if (i % 6 === 0 && i > 20) {
      let range = 0;
      for (let k = i - 14; k < i; k++) range += all[k].high - all[k].low;
      range /= 14;
      const dir: 1 | -1 = c.close >= all[i - 7].close ? 1 : -1;
      const entry = c.close, sl = entry - dir * range * 1.2, tp = entry + dir * range * 2.4;
      const line = (price: number, color: string, title: string, style = LineStyle.Dashed) => series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: false, title });
      pos = { dir, entry, sl, tp, lines: [line(entry, th.muted, dir > 0 ? 'BUY' : 'SELL', LineStyle.Solid), line(sl, th.down, 'SL'), line(tp, th.up, 'TP')] };
      say(dir > 0 ? 'Buy · risk 1R' : 'Sell · risk 1R', '');
    }
  };

  reset();
  if (reduced()) {
    // a finished picture instead of a film
    series.setData(all.slice(0, 190));
    chart.timeScale().fitContent();
    bar.style.width = '60%';
    return;
  }
  let visible = true;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((e) => (visible = e[e.length - 1].isIntersecting)) : null;
  io?.observe(root);
  const timer = window.setInterval(() => {
    if (!el.isConnected) {
      clearInterval(timer);
      io?.disconnect();
      chart.remove();
      return;
    }
    if (visible && !document.hidden) step();
  }, 190);
}
