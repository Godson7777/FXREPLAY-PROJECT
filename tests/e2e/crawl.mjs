// Crawler: every page and every dialog, looking for what a person would call broken:
// console errors, text like NaN, sideways scrolling, values cut off or not fitting their
// field, invisible or empty content, dialogs that do not close, small tap targets.
//   npm run build && npm run preview &   then   node tests/e2e/crawl.mjs [desktop|light|phone]
import { open, BASE, demoSession, importSample, quickTrades, scrollThrough, inspectInPage } from './lib.mjs';

const findings = new Map(); // "profile · place" → [problems]
/** Record findings and print the new ones at once, so a long run shows its results as it goes. */
const note = (where, list) => {
  if (!list.length) return;
  const have = findings.get(where) ?? [];
  const fresh = [...new Set(list)].filter((x) => !have.includes(x));
  if (!fresh.length) return;
  findings.set(where, [...have, ...fresh]);
  console.log(`\n■ ${where}`);
  for (const p of fresh) console.log(`    - ${p}`);
};
const settle = (page, ms = 500) => page.waitForTimeout(ms);

// ---- set the stage once: demo data, a replay session with trades, an imported list, a strategy
const setup = await open();
await demoSession(setup.page);
await quickTrades(setup.page, 24);
const replayId = setup.page.url().split('/').pop();
await importSample(setup.page);
const importId = setup.page.url().split('/').pop();
await setup.page.goto(BASE + '#/strategies');
await setup.page.getByRole('button', { name: /New strategy|Create a strategy/ }).first().click();
await setup.page.locator('.modal input').first().fill('London breakout');
await setup.page.locator('.modal input').nth(1).fill('Crawler');
await setup.page.locator('.modal .sym-list input[type=checkbox]').first().check();
await setup.page.getByRole('button', { name: 'Create strategy' }).click();
await setup.page.waitForURL(/#\/strategy\//);
const strategyId = setup.page.url().split('/').pop();
await settle(setup.page, 1500);
const state = await setup.ctx.storageState({ indexedDB: true });
note('setup', setup.errors);
await setup.browser.close();
console.log(`stage set: replay ${replayId}, imported ${importId}, strategy ${strategyId}`);

const SKIP = /delete|remove|restore|backup|export|download|load demo|sign |publish|reset|clear|duplicate|continue|open$|analytics|leaderboard|methodology|strategies|go to|see the|^\+ strategy$|refresh|update|^save|create &|start live|import &/i;

async function closeModal(page, where) {
  if (!(await page.locator('.modal-back').count())) return;
  await page.keyboard.press('Escape');
  await settle(page, 250);
  if (await page.locator('.modal-back').count()) {
    note(where, ['dialog does not close with Escape']);
    await page.locator('.modal-back .modal button', { hasText: '✕' }).first().click().catch(() => {});
    await settle(page, 250);
    if (await page.locator('.modal-back').count()) await page.evaluate(() => document.querySelectorAll('.modal-back').forEach((m) => m.remove()));
  }
}

/** Click every safe button on the page once and inspect any dialog it opens. */
async function dialogs(page, where, touch) {
  const labels = await page.evaluate(() => [...document.querySelectorAll('main button, .page-head button')].filter((b) => b.offsetParent && !b.disabled).map((b) => (b.textContent || '').trim()).filter(Boolean));
  for (const label of [...new Set(labels)]) {
    if (SKIP.test(label) || label.length > 40) continue;
    const hash = await page.evaluate(() => location.hash);
    const btn = page.locator('main button, .page-head button').filter({ hasText: label }).first();
    if (!(await btn.count()) || !(await btn.isVisible().catch(() => false))) continue;
    await btn.click({ timeout: 3000 }).catch(() => {});
    await settle(page, 450);
    if (await page.locator('.modal-back').count()) {
      const title = (await page.locator('.modal h3, .modal h2').first().innerText().catch(() => label)).trim();
      note(`${where} → dialog "${title}"`, await page.evaluate(inspectInPage, { root: '.modal', touch }));
      await closeModal(page, `${where} → dialog "${title}"`);
    }
    if ((await page.evaluate(() => location.hash)) !== hash) { await page.goto(BASE + hash); await settle(page, 700); }
  }
}

async function analyticsExtras(page, where, touch) {
  const check = async (what) => note(`${where} · ${what}`, await page.evaluate(inspectInPage, { touch }));
  // every "How to read" panel
  for (const b of await page.locator('.how-btn').all()) await b.click().catch(() => {});
  await settle(page, 500);
  await check('all "How to read" panels open');
  for (const b of await page.locator('.how-btn[aria-expanded=true]').all()) await b.click().catch(() => {});
  // score pillars
  for (const b of await page.locator('.pillar > button').all()) await b.click().catch(() => {});
  await settle(page, 300);
  await check('score pillars expanded');
  // breakdown metric
  for (const m of ['Expectancy (R)', 'Win rate', 'Trades', 'Net P&L']) {
    const b = page.locator('#sec-breakdowns button', { hasText: m }).first();
    if (await b.count()) { await b.click(); await settle(page, 350); await check(`breakdowns by ${m}`); }
  }
  // a filter, then clear it
  const side = page.locator('select').filter({ has: page.locator('option', { hasText: 'Long' }) }).first();
  if (await side.count()) {
    await side.selectOption({ label: 'Long' }); await settle(page, 1500); await check('filtered to longs');
    await side.selectOption({ index: 0 }); await settle(page, 600);
  }
  // Monte Carlo: other method, run
  const method = page.locator('#sec-montecarlo select').first();
  if (await method.count()) {
    await method.selectOption({ index: 1 });
    await page.locator('#sec-montecarlo button', { hasText: /run simulation/i }).click();
    await settle(page, 2500); await check('Monte Carlo, shuffle method');
    for (const r of await page.locator('#sec-montecarlo .seg, #sec-montecarlo button.chip').all()) { await r.click().catch(() => {}); await settle(page, 200); }
    const sim = page.locator('#sec-montecarlo button', { hasText: /simulate challenge/i });
    if (await sim.count()) { await sim.click(); await settle(page, 2500); await check('prop-firm simulator run'); }
  }
  // trade log: sort and open a trade
  const th = page.locator('#sec-trades th.sortable').nth(3);
  if (await th.count()) { await th.click(); await settle(page, 300); await th.click(); await settle(page, 300); await check('trade log sorted'); }
  const row = page.locator('#sec-trades tbody tr').first();
  if (await row.count()) {
    await row.click(); await settle(page, 500);
    if (await page.locator('.modal-back').count()) { note(`${where} → trade dialog`, await page.evaluate(inspectInPage, { root: '.modal', touch })); await closeModal(page, `${where} → trade dialog`); }
  }
}

async function workspaceExtras(page, where, touch) {
  const check = async (what) => note(`${where} · ${what}`, await page.evaluate(inspectInPage, { touch }));
  for (const label of ['Indicators', 'Settings', 'Shortcuts']) {
    const b = page.locator('.ws .topbar button', { hasText: label }).first();
    if (!(await b.count()) || !(await b.isVisible().catch(() => false))) continue;
    await b.click(); await settle(page, 400);
    note(`${where} → dialog "${label}"`, await page.evaluate(inspectInPage, { root: '.modal', touch }));
    await closeModal(page, `${where} → dialog "${label}"`);
  }
  for (const b of await page.locator('.ws .rail-btn').all()) {
    const name = (await b.getAttribute('title') ?? await b.innerText()).slice(0, 24);
    await b.click().catch(() => {}); await settle(page, 400);
    await check(`panel "${name}"`);
    if (await page.locator('.sheet.open').count()) { await page.locator('.sheet-head button').click().catch(() => {}); await settle(page, 400); }
  }
  for (const t of ['Orders', 'History', 'Positions']) {
    const b = page.locator('.ws .tab', { hasText: t }).first();
    if (await b.count() && await b.isVisible().catch(() => false)) { await b.click(); await settle(page, 300); await check(`tab ${t}`); }
  }
  if (!touch) {
    for (const n of [2, 3, 4, 1]) { await page.locator('.ws button.seg').nth(n - 1).click(); await settle(page, 700); await check(`${n}-chart layout`); }
    await page.keyboard.press('7'); await settle(page, 300);
    if (await page.locator('.modal-back').count()) { note(`${where} → timeframe prompt`, await page.evaluate(inspectInPage, { root: '.modal', touch })); await closeModal(page, `${where} → timeframe prompt`); }
  }
}

async function profile(name, o) {
  const { browser, page, errors } = await open({ ...o, state });
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => d.dismiss());
  const touch = !!o.phone;
  const routes = [
    ['Sessions', '#/'], ['Data', '#/data'], ['Strategies', '#/strategies'], ['Leaderboard', '#/leaderboard'], ['Methodology', '#/methodology'],
    ['Analytics (all sessions)', '#/analytics/all'], ['Analytics (replay session)', `#/analytics/${replayId}`], ['Analytics (imported)', `#/analytics/${importId}`],
    ['Analytics (strategy)', `#/strategy/${strategyId}`], ['Replay workspace', `#/replay/${replayId}`],
  ];
  for (const [label, hash] of routes) {
    if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(label)) continue;
    const where = `${name} · ${label}`;
    const before = errors.length;
    await page.goto(BASE + hash);
    await settle(page, 900);
    const isWs = hash.startsWith('#/replay');
    if (isWs) await page.locator('.ws canvas').first().waitFor({ timeout: 30000 });
    else if (/analytics|strategy/.test(hash)) await page.locator('section[id^=sec-], .empty-state').first().waitFor({ timeout: 60000 }).catch(() => {});
    if (!isWs) await scrollThrough(page, 1400); else await settle(page, 1200);
    note(where, await page.evaluate(inspectInPage, { touch }));
    if (isWs) await workspaceExtras(page, where, touch);
    else if (/analytics|strategy/.test(hash)) await analyticsExtras(page, where, touch);
    if (!isWs) { await page.evaluate(() => scrollTo(0, 0)); await dialogs(page, where, touch); }
    note(where, errors.slice(before).map((e) => 'error: ' + e));
    process.stdout.write('.');
  }
  await browser.close();
}

const only = process.argv[2];
if (!only || only === 'desktop') await profile('desktop', { width: 1440, height: 900 });
if (!only || only === 'light') await profile('light 1280', { width: 1280, height: 800, scheme: 'light' });
if (!only || only === 'phone') await profile('phone', { width: 390, height: 844, phone: true });

let total = 0;
for (const list of findings.values()) total += list.length;
console.log(total ? `\n\n${total} finding(s) in ${findings.size} place(s)` : '\n\nnothing found');
if (total) process.exitCode = 1;
