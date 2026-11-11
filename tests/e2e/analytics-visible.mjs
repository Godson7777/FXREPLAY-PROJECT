// Everything on the analytics page must actually be visible once the reader gets to it:
// every chart drawn and not clipped away, every card opaque, nothing left mid-entrance.
// Covers an imported trade list and a replay session, desktop and phone, with and
// without reduced motion.
//   npm run build && npm run preview &   then   node tests/e2e/analytics-visible.mjs
import { open, BASE, demoSession } from './lib.mjs';

let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { failed++; process.exitCode = 1; } };

/** A trade list in the FX Replay export layout: 160 trades over four months. */
export function sampleTradesCsv(n = 160) {
  let s = 'id,dateStart,dateEnd,pair,uPnL,rPnL,side,entryPrice,initialSL,maxTP,idealTP,amount,amountClosed,status,day,tags,avgClosePrice,avgRiskReward,maxRiskReward,exchangeRate,initialBalance,currentRealizedBalance\n';
  let bal = 100000, t = Date.UTC(2026, 4, 4, 8) / 1000, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const p = (x) => String(x).padStart(2, '0');
  const f = (u) => { const d = new Date(u * 1000); return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`; };
  for (let i = 0; i < n; i++) {
    const e = 4000 + rnd() * 400, sl = 6 + rnd() * 6, buy = rnd() < 0.5, win = rnd() < 0.4, r = win ? 1.5 + rnd() * 3 : -1, amt = Math.round(600 / sl);
    const x = buy ? e + r * sl : e - r * sl, pnl = +(r * sl * amt).toFixed(2);
    bal += pnl;
    const d = t + 3600 * (1 + rnd() * 3);
    s += `${i},${f(t)},${f(d)},XAUUSD,0,${pnl},${buy ? 'buy' : 'sell'},${e.toFixed(3)},${(buy ? e - sl : e + sl).toFixed(3)},,,${amt},${amt},closed,1,${rnd() < 0.5 ? 'breakout' : 'pullback'},${x.toFixed(3)},${r.toFixed(2)},${r.toFixed(2)},1,100000,${bal.toFixed(2)}\n`;
    t = d + 3600 * (4 + rnd() * 20);
  }
  return s;
}

export async function importSample(page) {
  await page.goto(BASE);
  await page.getByRole('button', { name: /Import trades/ }).first().click();
  await page.locator('.modal input[type=file]').setInputFiles({ name: 'sample-trades.csv', mimeType: 'text/csv', buffer: Buffer.from(sampleTradesCsv()) });
  await page.locator('.modal .callout').first().waitFor();
  await page.getByRole('button', { name: 'Import & analyse' }).click();
  await page.getByText('Does this method have').first().waitFor({ timeout: 30000 });
}

/** Read the page top to bottom like a person, then report anything that is not visible. */
export async function audit(page) {
  await page.waitForTimeout(1200);
  for (let pass = 0; pass < 2; pass++) {
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H + 900; y += 500) { await page.evaluate((yy) => scrollTo(0, yy), y); await page.waitForTimeout(pass ? 60 : 160); }
  }
  await page.waitForTimeout(2600); // longer than any entrance animation
  return page.evaluate(() => {
    const title = (el) => (el.closest('.card')?.querySelector('.card-title span')?.textContent ?? el.closest('section')?.querySelector('h2')?.textContent ?? el.className ?? '?').toString().trim().slice(0, 60);
    const hiddenBy = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none') return `display:none on ${n.tagName}.${n.className}`;
        if (cs.visibility === 'hidden') return `visibility:hidden on ${n.tagName}.${n.className}`;
        if (+cs.opacity < 0.99) return `opacity ${cs.opacity} on ${n.tagName}.${n.className}`;
        if (cs.clipPath && cs.clipPath !== 'none') return `clip-path ${cs.clipPath} on ${n.tagName}.${n.className}`;
      }
      return null;
    };
    const out = { charts: 0, cards: 0, problems: [], titles: [] };
    for (const v of document.querySelectorAll('.viz')) {
      out.charts++;
      const svg = v.querySelector('svg');
      const r = v.getBoundingClientRect();
      const why = hiddenBy(svg ?? v);
      if (!svg) out.problems.push(`chart "${title(v)}": nothing drawn`);
      else if (!svg.querySelector('path, rect, circle, polyline, line')) out.problems.push(`chart "${title(v)}": empty`);
      else if (r.width < 40 || r.height < 40) out.problems.push(`chart "${title(v)}": size ${Math.round(r.width)}×${Math.round(r.height)}`);
      else if (why) out.problems.push(`chart "${title(v)}": ${why}`);
      else if ([...svg.querySelectorAll('*')].some((e) => e.getAttributeNames().some((a) => /NaN|undefined|Infinity/.test(e.getAttribute(a) ?? '')))) out.problems.push(`chart "${title(v)}": NaN in the drawing`);
    }
    for (const c of document.querySelectorAll('.sec .card, .sec .kpi, .score-hero, .score-ring, canvas')) {
      out.cards++;
      const why = hiddenBy(c);
      const r = c.getBoundingClientRect();
      if (why) out.problems.push(`card "${title(c)}": ${why}`);
      else if (r.width === 0 || r.height === 0) out.problems.push(`card "${title(c)}": zero size`);
    }
    for (const e of document.querySelectorAll('.rv-in, .viz-draw')) out.problems.push(`"${title(e)}": still mid-entrance (${e.className})`);
    const text = document.querySelector('main')?.innerText ?? document.body.innerText;
    const bad = text.match(/\b(NaN|undefined|Infinity|\[object Object\])\b/g);
    if (bad) out.problems.push(`text shows ${[...new Set(bad)].join(', ')}`);
    out.titles = [...document.querySelectorAll('.card-title span')].map((s) => s.textContent.trim());
    out.sections = [...document.querySelectorAll('section[id^=sec-]')].map((s) => `${s.id.slice(4)} ${s.querySelectorAll('.viz').length}`).join(' · ');
    return out;
  });
}

const MUST_IMPORTED = ['Equity curve', 'Drawdown (underwater)', 'Simulated equity paths', 'Maximum drawdown across simulations', 'R-multiple distribution'];

async function scenario(label, opts, setup, must) {
  const { browser, page, errors } = await open(opts);
  if (opts.reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  const r = await audit(page);
  ok(r.charts >= must.length && !r.problems.length, `${label}: ${r.charts} charts and ${r.cards} cards all visible${r.problems.length ? ' — ' + r.problems.slice(0, 8).join(' | ') + (r.problems.length > 8 ? ` … (${r.problems.length} in total)` : '') : ''}`);
  const missing = must.filter((t) => !r.titles.some((x) => x.startsWith(t)));
  ok(!missing.length, `${label}: expected charts are on the page${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);
  ok(!errors.length, `${label}: no console errors${errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''}`);
  if (process.env.SHOT) {
    for (const [id, name] of [['sec-performance', 'performance'], ['sec-montecarlo', 'montecarlo']]) {
      await page.evaluate((i) => document.getElementById(i)?.scrollIntoView(), id);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${process.env.SHOT}/visible-${label.replace(/\W+/g, '-')}-${name}.png` });
    }
  }
  console.log(`   sections (charts): ${r.sections}`);
  await browser.close();
}

/** A replay session with a quick run of trades, then its analytics. */
async function replayThenAnalytics(page) {
  await demoSession(page);
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+S' : 'Shift+B');
    for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+C');
  }
  await page.waitForTimeout(600);
  await page.locator('.ws .topbar .primary').click();
  await page.getByText('Does this method have').first().waitFor({ timeout: 60000 });
}

const only = process.argv[2];
if (!only || only === 'imported') {
  await scenario('imported trades, desktop', { width: 1440, height: 900 }, importSample, MUST_IMPORTED);
  await scenario('imported trades, phone', { width: 390, height: 844, phone: true }, importSample, MUST_IMPORTED);
  await scenario('imported trades, reduced motion', { width: 1440, height: 900, reduced: true }, importSample, MUST_IMPORTED);
  await scenario('imported trades, light theme', { width: 1440, height: 900, scheme: 'light' }, importSample, MUST_IMPORTED);
}
if (!only || only === 'replay') {
  await scenario('replay session, desktop', { width: 1440, height: 900 }, replayThenAnalytics, ['Equity curve', 'Drawdown (underwater)', 'Simulated equity paths']);
  await scenario('replay session, phone', { width: 390, height: 844, phone: true }, async (page) => {
    // trade on desktop-size keys is not possible on touch: reuse the keyboard path, the page is the same
    await replayThenAnalytics(page);
  }, ['Equity curve', 'Drawdown (underwater)', 'Simulated equity paths']);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall visible');
