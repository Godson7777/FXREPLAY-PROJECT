// Everything on the analytics page must actually be visible once the reader gets to it:
// every chart drawn and not clipped away, every card opaque, nothing left mid-entrance.
// Covers an imported trade list and a replay session, desktop and phone, with and
// without reduced motion.
//   npm run build && npm run preview &   then   node tests/e2e/analytics-visible.mjs
import { open, demoSession, importSample, quickTrades } from './lib.mjs';

let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { failed++; process.exitCode = 1; } };

/** Read the page top to bottom like a person, then report anything that is not visible. */
async function audit(page) {
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
  await quickTrades(page);
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
