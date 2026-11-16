// Every kind of session through the real screen: prop-firm challenges that pass and fail
// (daily loss, max loss, trailing, minimum days), a leveraged account taken to liquidation,
// a session with an end date, several symbols at once, strategies and the leaderboard.
//   npm run build && npm run preview &   then   node tests/e2e/session-types.mjs
import { open, BASE } from './lib.mjs';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, ctx, page, errors } = await open();
await ctx.addInitScript(() => { try { localStorage.setItem('overflowtrade.debug', '1'); } catch {} });
const toast = async () => (await page.locator('#toasts .toast').last().innerText().catch(() => '')).trim();
const put = async (loc, v) => loc.evaluate((e, x) => { e.value = x; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, String(v));
const byLabel = (re) => page.locator('.modal .field, .modal label').filter({ hasText: re }).locator('input, select').first();
const junk = () => page.evaluate(() => (document.body.innerText.match(/NaN|undefined|Infinity|\[object/g) ?? []).length);

await page.goto(BASE);
await page.getByRole('button', { name: 'Load demo data' }).click();
await page.getByRole('button', { name: /New session/ }).first().waitFor({ timeout: 60000 });

/** Create a session through the dialog. `rules` = [target, daily, total, minDays, trailing]. */
async function newSession({ name, rules = null, leverage = '', symbols = ['EURUSD'], endDays = 0 }) {
  await page.goto(BASE + '#/'); await page.getByRole('button', { name: /New session/ }).first().click(); await page.waitForTimeout(250);
  await page.locator('.modal input').first().fill(name);
  for (const cb of await page.locator('.modal .sym-list label').all()) {
    const want = symbols.some((s) => new RegExp(`\\b${s}\\b`).test(cb.innerText ? '' : ''));
    void want;
  }
  const labels = await page.locator('.modal .sym-list label').allInnerTexts();
  for (let i = 0; i < labels.length; i++) await page.locator('.modal .sym-list input').nth(i).setChecked(symbols.some((s) => labels[i].includes(s)));
  if (leverage) await byLabel(/^Leverage/).selectOption(String(leverage));
  if (endDays) {
    const startV = await page.locator('.modal input[type=datetime-local]').first().inputValue();
    const e = new Date(Date.parse(startV + 'Z') + endDays * 86400000).toISOString().slice(0, 16);
    await put(page.locator('.modal input[type=datetime-local]').nth(1), e);
  }
  if (rules) {
    await page.locator('.modal select').filter({ has: page.locator('option', { hasText: 'Custom rules' }) }).selectOption('custom');
    await put(byLabel(/Profit target/), rules[0]); await put(byLabel(/Max daily loss/), rules[1]); await put(byLabel(/Max total loss/), rules[2]); await put(byLabel(/Min trading days/), rules[3]);
    await page.locator('.modal label.check', { hasText: 'Trailing max loss' }).locator('input').setChecked(!!rules[4]);
    await page.locator('.modal input').first().fill(name);
  }
  await page.getByRole('button', { name: 'Create & start replay' }).click();
  await page.locator('.ws canvas').first().waitFor({ timeout: 30000 }); await page.waitForTimeout(1100);
  await put(page.locator('#tSl'), '0'); await page.locator('#sizeMode').selectOption('lots'); await put(page.locator('#tSize'), '1'); await page.locator('.ws .tab').first().click();
}
const st = () => page.evaluate(() => {
  const w = window.__ot, br = w.replay.broker, c = w.session.state.challenge;
  return { balance: br.s.balance, equity: br.equity(), nPos: br.s.positions.length, nOrd: br.s.orders.length, trades: br.s.trades.map((t) => ({ pnl: t.pnl, why: t.exitReason, lots: t.lots })), status: c?.status ?? null, reason: c?.reason ?? '', days: c?.tradingDays.length ?? 0, clock: w.replay.clock, locked: w.replay.locked, start: w.session.balance };
});
const focusChart = async () => { await page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await page.keyboard.press('Escape'); };
/** Open one lot, move the market by `pips` and close: a realised result of about pips × $10. */
async function result(pips) {
  await focusChart();
  await page.keyboard.press(pips > 0 ? 'Shift+B' : 'Shift+B'); await page.waitForTimeout(150);
  await page.evaluate((d) => { const w = window.__ot, br = w.replay.broker, p = br.s.positions[br.s.positions.length - 1]; br.setPrice(p.symbol, br.now(p.symbol), p.entry + d); }, pips * 0.0001);
  await page.keyboard.press('Shift+C'); await page.waitForTimeout(200);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(350); // the rules are checked on the next bar
}
const modalTitle = async () => (await page.locator('.modal h3, .modal .modal-title, .modal-head').first().innerText().catch(() => '')).trim();
const dismiss = async () => { for (let i = 0; i < 3 && (await page.locator('.modal-back').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); } };

// ---- 1) failing on the daily loss limit ---------------------------------------------------------
await newSession({ name: 'Daily limit', rules: [10, 5, 10, 0, false] });
let s = await st();
ok(s.status === 'active' && (await page.locator('.ws .side').innerText()).includes('Daily'), 'challenge session starts active and shows its limits in the side panel');
await result(-30);
s = await st();
ok(s.status === 'active', `a 3% loss on a 5% daily limit keeps the challenge alive (balance $${s.balance.toFixed(0)})`);
await result(-25);
s = await st();
ok(s.status === 'failed' && /Daily loss limit of 5%/.test(s.reason), `…a further 2.5% the same day fails it: "${s.reason}"`);
ok(/Challenge failed/.test(await modalTitle()) || (await page.locator('.modal').innerText()).includes('Daily loss limit'), 'a dialog says so');
await dismiss();
await focusChart(); await page.keyboard.press('Shift+B'); await page.waitForTimeout(250);
ok((await st()).nPos === 0 && /Challenge failed/.test(await toast()), `trading is locked afterwards: "${(await toast()).slice(0, 60)}"`);
await page.waitForTimeout(1300); await page.reload(); await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1000);
s = await st();
ok(s.status === 'failed' && !!s.locked, 'still failed and locked after a reload');
await page.locator('.ws .topbar .primary').click(); await page.getByText('Does this method have').first().waitFor({ timeout: 30000 }); await page.waitForTimeout(800);
const chall = await page.locator('#sec-performance .kpis.small').innerText();
ok(/Failed/.test(chall) && /Daily loss limit/.test(chall), 'Analytics shows the challenge as failed, with the reason');
await page.goto(BASE + '#/'); await page.locator('.scard').first().waitFor();
ok(await page.locator('.scard', { hasText: 'Daily limit' }).locator('.badge.failed').count() === 1, 'the session card carries a "Challenge failed" badge');

// ---- 2) the next day starts a new daily allowance; then the total limit ------------------------------
await newSession({ name: 'Total limit', rules: [10, 5, 10, 0, false] });
await result(-40);
await page.locator('.controls button', { hasText: '+1D' }).click(); await page.waitForTimeout(500);
await result(-40);
s = await st();
ok(s.status === 'active', `4% lost on each of two days stays inside the 5% daily limit (down ${(100 - s.balance / 100).toFixed(1)}%)`);
await page.locator('.controls button', { hasText: '+1D' }).click(); await page.waitForTimeout(500);
await result(-30);
s = await st();
ok(s.status === 'failed' && /Max loss of 10%/.test(s.reason), `the third day takes the account past −10%: "${s.reason}"`);
await dismiss();

// ---- 3) a trailing limit follows the high ---------------------------------------------------------------
await newSession({ name: 'Trailing', rules: [20, 0, 6, 0, true] });
await result(40);
await page.locator('.controls button', { hasText: '+1D' }).click(); await page.waitForTimeout(500);
await result(-70);
s = await st();
ok(s.status === 'failed' && /trailing/.test(s.reason) && s.balance > s.start * 0.94, `+4% then −7% fails a trailing 6% limit although the account is only ${(100 - s.balance / 100).toFixed(1)}% down: "${s.reason}"`);
await dismiss();

// ---- 4) passing: the target and the minimum number of trading days ------------------------------------------
await newSession({ name: 'Pass', rules: [3, 5, 10, 2, false] });
await result(35);
s = await st();
ok(s.status === 'active' && s.days === 1, `+3.5% on day one is over the 3% target but only ${s.days} of 2 trading days — not passed yet`);
await page.locator('.controls button', { hasText: '+1D' }).click(); await page.waitForTimeout(500);
await result(1);
s = await st();
ok(s.status === 'passed' && /Profit target of 3%/.test(s.reason), `a trade on a second day passes it: "${s.reason}"`);
ok((await page.locator('.modal').innerText().catch(() => '')).includes('Profit target'), 'a dialog says so');
await dismiss();
await focusChart(); await page.keyboard.press('Shift+B'); await page.waitForTimeout(250);
ok((await st()).nPos === 1, 'trading stays open after a pass');
await page.keyboard.press('Shift+C'); await page.waitForTimeout(300);
await page.goto(BASE + '#/'); await page.locator('.scard').first().waitFor();
ok(await page.locator('.scard', { hasText: /^Pass|Pass\b/ }).locator('.badge.passed').count() >= 1, 'the session card carries a "Challenge passed" badge');
ok((await junk()) === 0, 'no NaN / undefined on the Sessions page');

// ---- 5) a leveraged account, to liquidation -------------------------------------------------------------
await newSession({ name: 'Leverage 500', leverage: 500 });
ok(await page.locator('#tLev').count() === 1, 'a leveraged session has a leverage field in the ticket');
await put(page.locator('#tSize'), '1000'); await page.locator('.ws .tab').first().click();
await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(250);
ok((await st()).nPos === 0 && /Not enough margin/.test(await toast()), `an order beyond the margin is refused with the most that fits: "${(await toast()).slice(0, 90)}"`);
const most = +(/most you can open is ([\d.]+)/.exec(await toast())?.[1] ?? '0');
await put(page.locator('#tSize'), String(most)); await page.locator('.ws .tab').first().click();
await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(250);
s = await st();
const pos = await page.evaluate(() => { const p = window.__ot.replay.broker.s.positions[0]; return p ? { lots: p.lots, margin: p.margin, liq: p.liq, entry: p.entry } : null; });
ok(s.nPos === 1 && pos && pos.margin > 0 && pos.liq < pos.entry, `the largest size opens: ${pos?.lots} lots, margin $${pos?.margin?.toFixed(2)}, liquidation at ${pos?.liq?.toFixed(5)}`);
const head = (await page.locator('.ws .tbl thead').innerText()).toLowerCase();
ok(/liq/.test(head) && /margin/.test(head), 'the positions table shows margin and the liquidation price');
await focusChart();
let liq = null;
for (let i = 0; i < 400 && !liq; i++) { for (let k = 0; k < 15; k++) await page.keyboard.press('ArrowRight'); const x = await st(); if (!x.nPos) liq = x; }
await dismiss();
ok(!!liq && liq.trades.length === 1 && liq.trades[0].why === 'liq', `the position is liquidated when price gets there (exit "${liq?.trades[0]?.why}")`);
ok(!!liq && liq.balance >= -0.01 && Math.abs(liq.trades[0].pnl) <= pos.margin * 1.02 + 1, `the loss is the margin, never more: lost $${Math.abs(liq?.trades[0]?.pnl ?? 0).toFixed(2)} of $${pos?.margin?.toFixed(2)} (balance $${liq?.balance.toFixed(2)})`);
ok((await junk()) === 0, 'no NaN / undefined after a liquidation');

// ---- 6) a session with an end date ----------------------------------------------------------------------------
await newSession({ name: 'Two days', endDays: 2 });
const c0 = (await st()).clock;
await focusChart();
await page.locator('input.jump').fill('2099-01-01T00:00'); await page.locator('.controls button', { hasText: /^Go$/ }).click(); await page.waitForTimeout(1500);
s = await st();
const endTxt = (await page.locator('.modal, .nodata-card').allInnerTexts()).join(' ');
ok(s.clock - c0 <= 2 * 86400 + 3600 && s.clock - c0 > 86400 && /end date/i.test(endTxt), `the replay stops at the end date (${((s.clock - c0) / 86400).toFixed(2)} days in) and says so`);
await page.locator('.modal button, .nodata-card button', { hasText: /Keep reviewing|Dismiss/ }).first().click().catch(() => {});
await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space'); await page.waitForTimeout(500);
ok((await st()).clock === s.clock, 'it cannot be played past the end');
await dismiss();

// ---- 7) several symbols at once -----------------------------------------------------------------------------------
await newSession({ name: 'Three symbols', symbols: ['EURUSD', 'GBPUSD', 'XAUUSD'] });
await page.keyboard.press('Alt+3'); await page.waitForTimeout(700);
const paneSyms = await page.locator('select.pane-sym').evaluateAll((els) => els.map((e) => e.value));
ok(new Set(paneSyms).size === 3, `three charts show three symbols (${paneSyms.join(', ')})`);
await focusChart();
for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
const sync = await page.evaluate(() => { const w = window.__ot; return w.panes.map((p) => { const b = w.replay.data[p.cfg.symbol]; let i = 0; while (i < b.n && b.t[i] < w.replay.clock) i++; return { sym: p.cfg.symbol, last: w.replay.broker.bid(p.cfg.symbol), dataAt: b.c[Math.max(0, i - 1)] }; }); });
ok(sync.every((x) => Math.abs(x.last - x.dataAt) / x.dataAt < 0.01), `every symbol's price is the one at the replay clock (${sync.map((x) => `${x.sym} ${x.last}`).join(', ')})`);
await put(page.locator('#tSl'), '20'); await page.locator('#sizeMode').selectOption('risk%'); await put(page.locator('#tSize'), '1'); await page.locator('.ws .tab').first().click();
for (let i = 0; i < 3; i++) {
  await page.locator('.ws .pane').nth(i).locator('.pane-chart').click({ position: { x: 200, y: 120 } }); await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+B'); await page.waitForTimeout(200);
}
const opened = await page.evaluate(() => window.__ot.replay.broker.s.positions.map((p) => ({ sym: p.symbol, risk: window.__ot.replay.broker.value(p.symbol, p.entry - p.sl, p.lots, p.sl) })));
ok(new Set(opened.map((x) => x.sym)).size === 3 && opened.every((x) => Math.abs(x.risk - 100) < 30), `one trade on each symbol, each sized to about 1% ($100): ${opened.map((x) => `${x.sym} $${x.risk.toFixed(0)}`).join(', ')}`);
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
await page.keyboard.press('Shift+C'); await page.waitForTimeout(400);
s = await st();
ok(Math.abs(s.balance - s.start - s.trades.reduce((a, t) => a + t.pnl, 0)) < 0.01 && s.trades.length === 3, 'the books add up across three symbols');
await page.waitForTimeout(1200);

// ---- 8) strategies and the leaderboard ------------------------------------------------------------------------------
await page.locator('.ws .topbar .primary').click(); await page.getByText('Does this method have').first().waitFor({ timeout: 30000 }); await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Add to strategy' }).first().click(); await page.waitForTimeout(300);
// with no strategy yet, this opens the "New strategy" dialog directly
await page.locator('.modal button', { hasText: 'Create strategy' }).click(); await page.waitForTimeout(250);
ok(/name/i.test(await toast()), `a strategy needs a name: "${(await toast()).slice(0, 50)}"`);
await page.locator('.modal input[placeholder^="e.g. London"]').fill('Breakout test');
await page.locator('.modal input[placeholder^="Your name"]').fill('');
await page.locator('.modal button', { hasText: 'Create strategy' }).click(); await page.waitForTimeout(250);
ok(/author/i.test(await toast()), `…and an author: "${(await toast()).slice(0, 60)}"`);
await page.locator('.modal input[placeholder^="Your name"]').fill('Tester');
const boxes = page.locator('.modal input[type=checkbox]');
for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).setChecked(true);
await page.locator('.modal button', { hasText: 'Create strategy' }).click(); await page.waitForTimeout(900);
await page.goto(BASE + '#/strategies'); await page.waitForTimeout(1500);
ok((await page.locator('body').innerText()).includes('Breakout test') && (await junk()) === 0, 'the strategy is listed on the Strategies page');
await page.locator('button', { hasText: /^Open$/ }).first().click(); await page.getByText('Does this method have').first().waitFor({ timeout: 30000 }); await page.waitForTimeout(800);
const total = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('overflowtrade'); q.onsuccess = () => { const g = q.result.transaction('sessions').objectStore('sessions').getAll(); g.onsuccess = () => res(g.result.reduce((a, x) => a + x.state.broker.trades.length, 0)); }; }));
const shownN = await page.locator('.an-body .stat', { has: page.locator('span:text-is("Trades")') }).first().locator('b').innerText();
ok(shownN === String(total), `the strategy combines every session's trades (${shownN} of ${total})`);
ok((await page.locator('.score-box').last().innerText()).match(/Not published|more closed trade|synthetic/i) !== null, 'it explains why it is not ranked yet');
if (await page.getByRole('button', { name: 'Publish to leaderboard' }).count()) { await page.getByRole('button', { name: 'Publish to leaderboard' }).click(); await page.waitForTimeout(1200); }
ok(await page.getByRole('button', { name: 'Unpublish' }).count() === 1, 'the strategy is published');
await page.goto(BASE + '#/leaderboard'); await page.waitForTimeout(1800);
ok(/1 strategy is not ranked yet/.test(await page.locator('body').innerText()), 'the leaderboard says one strategy is not ranked yet');
await page.locator('button.link', { hasText: 'Show them' }).click(); await page.waitForTimeout(500);
const lb = await page.locator('body').innerText();
ok(lb.includes('Breakout test') && /synthetic|practice|not ranked|needs/i.test(lb) && (await junk()) === 0, 'the leaderboard lists it as published but unranked, with the reason (practice data is never ranked)');
await page.goto(BASE + '#/strategies'); await page.waitForTimeout(1000);
page.removeAllListeners('dialog'); page.on('dialog', (d) => void d.accept());
await page.locator('button.danger', { hasText: /Delete/ }).first().click(); await page.waitForTimeout(800);
const left = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('overflowtrade'); q.onsuccess = () => { const g = q.result.transaction('sessions').objectStore('sessions').getAll(); g.onsuccess = () => res(g.result.length); }; }));
ok(!(await page.locator('body').innerText()).includes('Breakout test') && left >= 7, `deleting the strategy keeps its sessions (${left} sessions still stored)`);
ok(!errors.length, `no console errors in the whole run${errors.length ? ' — ' + errors.slice(0, 4).join(' | ') : ''}`);
await browser.close();
