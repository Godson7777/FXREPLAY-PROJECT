// Rough handling: values nobody should type, double clicks, key spam, resizing and theme
// switching while the replay runs, and going offline. Whatever is thrown at it, the app must
// either refuse with a message or carry on with sane numbers — never break a session.
//   npm run build && npm run preview &   then   node tests/e2e/rough-input.mjs
import { open, BASE } from './lib.mjs';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, ctx, page, errors } = await open();
await ctx.addInitScript(() => { try { localStorage.setItem('overflowtrade.debug', '1'); } catch {} });
const toast = async () => (await page.locator('#toasts .toast').last().innerText().catch(() => '')).trim();
const sessions = () => page.evaluate(() => new Promise((res) => { const q = indexedDB.open('overflowtrade'); q.onsuccess = () => { const g = q.result.transaction('sessions').objectStore('sessions').getAll(); g.onsuccess = () => res(g.result); }; }));
/** Put text into a field the way a paste would (number fields drop what is not a number, as in a browser). */
const put = async (loc, v) => { await loc.evaluate((e, x) => { e.value = x; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); };
const junkOnPage = () => page.evaluate(() => (document.body.innerText.match(/NaN|undefined|Infinity|\[object/g) ?? []).length);
const BAD = ['', '0', '-5', '1e12', 'abc', '1,5', '9'.repeat(30), '0.0000000001'];

await page.goto(BASE);
await page.getByRole('button', { name: 'Load demo data' }).click();
await page.getByRole('button', { name: /New session/ }).first().waitFor({ timeout: 60000 });

// ---- the new-session dialog -------------------------------------------------------------------
const field = (label) => page.locator('.modal label, .modal .field', { has: page.locator(`span:text-is("${label}")`) }).locator('input, select').first();
const byLabel = (re) => page.locator('.modal .field, .modal label').filter({ hasText: re }).locator('input').first();
const openNew = async () => { if (!(await page.locator('.modal').count())) { await page.getByRole('button', { name: /New session/ }).first().click(); await page.waitForTimeout(250); } };
const create = async () => { await page.getByRole('button', { name: 'Create & start replay' }).click(); await page.waitForTimeout(450); return { stays: (await page.locator('.modal').count()) > 0 && !/#\/replay\//.test(page.url()), toast: await toast() }; };
const n0 = (await sessions()).length;
for (const [what, re, values] of [
  ['Starting balance', /Starting balance/, ['', '0', '-5', '1e12', 'abc', '0.5']],
  ['Risk per trade', /Default risk per trade/, ['', '0', '-1', '500', 'abc']],
  ['Commission', /Commission/, ['', '-1', '1e9']],
  ['Spread', /Spread/, ['', '-0.5', '1e9']],
]) {
  for (const v of values) {
    await openNew();
    const f = byLabel(re), keep = await f.inputValue();
    await put(f, v);
    const r = await create();
    ok(r.stays && r.toast.length > 0 && (await sessions()).length === n0, `new session · ${what} "${v}" is refused: "${r.toast.slice(0, 60)}"`);
    if (r.stays) await put(f, keep); else { await page.goto(BASE); await page.waitForTimeout(500); }
  }
}
await openNew();
await page.locator('.modal select').filter({ has: page.locator('option', { hasText: 'Custom rules' }) }).selectOption('custom');
for (const [what, re, values] of [['Profit target', /Profit target/, ['', '0', '-5']], ['Max total loss', /Max total loss/, ['', '0', '-5', '500']], ['Max daily loss', /Max daily loss/, ['', '-1', '500']], ['Min trading days', /Min trading days/, ['', '-1', '2.5', '9999']]]) {
  for (const v of values) {
    const f = byLabel(re), keep = await f.inputValue();
    await put(f, v);
    const r = await create();
    ok(r.stays && r.toast.length > 0 && (await sessions()).length === n0, `new session · challenge ${what} "${v}" is refused: "${r.toast.slice(0, 60)}"`);
    await put(f, keep);
  }
}
await page.locator('.modal select').filter({ has: page.locator('option', { hasText: 'Custom rules' }) }).selectOption('');
// extremes that are allowed must still give a working session
await put(byLabel(/Starting balance/), '1'); await put(byLabel(/Default risk per trade/), '100'); await put(byLabel(/Commission/), '0'); await put(byLabel(/Spread/), '0');
await page.locator('.modal input').first().fill('  ' + 'A very long session name '.repeat(12));
let r = await create();
await page.locator('.ws canvas').first().waitFor({ timeout: 30000 }); await page.waitForTimeout(1200);
const st = () => page.evaluate(() => {
  const w = window.__ot, br = w.replay.broker, s = br.s;
  const fin = (x) => typeof x === 'number' && isFinite(x);
  return {
    balance: s.balance, equity: br.equity(), nPos: s.positions.length, nOrd: s.orders.length, nTrades: s.trades.length, start: w.session.balance,
    sane: fin(s.balance) && fin(br.equity()) && s.positions.every((p) => p.lots > 0 && fin(p.lots) && fin(p.entry) && (p.sl == null || fin(p.sl)) && (p.tp == null || fin(p.tp)) && fin(br.floating(p)))
      && s.orders.every((o) => o.lots > 0 && fin(o.price)) && s.trades.every((t) => fin(t.pnl) && t.lots > 0),
    maxLots: Math.max(0, ...s.positions.map((p) => p.lots), ...s.orders.map((o) => o.lots)),
    name: w.session.name,
  };
});
let s = await st();
ok(s.sane && s.start === 1 && s.name.length <= 80 && (await junkOnPage()) === 0, `a $1 account at 100% risk with a very long name opens cleanly (name kept to ${s.name.length} characters)`);
const head = await page.locator('.topbar').evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
ok(head, 'the long name does not push the top bar off the screen');
await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(250);
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
await page.keyboard.press('Shift+C'); await page.waitForTimeout(300);
s = await st();
ok(s.sane && (await junkOnPage()) === 0, `trading the $1 account gives finite numbers (balance $${s.balance.toFixed(2)})`);

// ---- a normal session for the rest ----------------------------------------------------------------
await page.goto(BASE); await page.getByRole('button', { name: /New session/ }).first().click();
await page.getByRole('button', { name: 'Create & start replay' }).click();
await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1200);
const blur = () => page.locator('.ws .tab').first().click();

// ---- the order ticket: every field, every size mode ------------------------------------------------
const closeAll = async () => { await page.evaluate(() => { const w = window.__ot; w.replay.broker.closeAll(); for (const o of [...w.replay.broker.s.orders]) w.replay.broker.cancelOrder(o.id); w.afterTrade(); }); await page.waitForTimeout(120); };
for (const mode of ['risk%', 'risk$', 'lots']) {
  await page.locator('#sizeMode').selectOption(mode); await page.waitForTimeout(150);
  for (const v of BAD.concat(['101', '1000000'])) {
    await put(page.locator('#tSize'), v); await blur();
    const before = await st();
    await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(160);
    const a = await st();
    const opened = a.nPos > before.nPos;
    ok(a.sane && (await junkOnPage()) === 0 && (!opened || a.maxLots <= 1e6), `ticket · ${mode} = "${v.slice(0, 14)}": ${opened ? `opened ${a.maxLots} lots` : `refused — "${(await toast()).slice(0, 50)}"`}`);
    await closeAll();
  }
  await put(page.locator('#tSize'), mode === 'lots' ? '0.1' : mode === 'risk%' ? '1' : '100'); await blur();
}
await page.locator('#sizeMode').selectOption('risk%'); await put(page.locator('#tSize'), '1'); await blur();
for (const id of ['tSl', 'tTp', 'tTrail', 'tBe']) {
  for (const v of BAD) {
    await put(page.locator('#' + id), v); await blur();
    await page.locator('.ws .quote button.sell').click(); await page.waitForTimeout(160);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    const a = await st();
    ok(a.sane && (await junkOnPage()) === 0, `ticket · ${id} = "${v.slice(0, 14)}": books stay sane (${a.nPos} open)`);
    await closeAll();
  }
  await put(page.locator('#' + id), id === 'tSl' ? '15' : id === 'tTp' ? '2' : ''); await blur();
}
await page.locator('.ws .seg', { hasText: /^Limit$/ }).click(); await page.waitForTimeout(200);
for (const v of BAD) {
  await put(page.locator('#tPrice'), v); await blur();
  await page.locator('#placeBtn').click(); await page.waitForTimeout(160);
  const a = await st();
  ok(a.sane && (await junkOnPage()) === 0, `ticket · limit price "${v.slice(0, 14)}": ${a.nOrd ? 'order placed' : `refused — "${(await toast()).slice(0, 50)}"`}`);
  await closeAll();
}
await page.locator('.ws .seg', { hasText: /^Market$/ }).click(); await page.waitForTimeout(200);
await page.locator('#tTags').fill('<img src=x onerror=alert(1)>, "quoted", ' + 'x'.repeat(300)); await blur();
await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(200);
await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+C'); await page.waitForTimeout(300);
await page.locator('.ws .tab', { hasText: 'History' }).click(); await page.waitForTimeout(250);
ok(!(await page.locator('.ws img[src="x"]').count()) && (await st()).sane, 'tags are shown as text, never run as page code');
await page.locator('.ws .tab', { hasText: 'Positions' }).click();
await page.locator('#tTags').fill(''); await blur();

// ---- levels typed into an open position ------------------------------------------------------------
await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(250);
for (const v of BAD) {
  for (const k of [0, 1]) {
    const inp = page.locator('.ws .tbl tbody tr').first().locator('input.lvl').nth(k);
    await put(inp, v); await page.waitForTimeout(150);
  }
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100);
  const a = await st();
  ok(a.sane && (await junkOnPage()) === 0, `position SL/TP typed as "${v.slice(0, 14)}": books stay sane (${a.nPos} open)`);
  if (!a.nPos) { await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(250); }
}
await closeAll();

// ---- session settings: values that would stop the session from opening -------------------------------
const openSettings = async () => { if (!(await page.locator('.modal').count())) { await page.locator('.topbar button', { hasText: 'Settings' }).click(); await page.waitForTimeout(250); } };
const specBefore = await page.evaluate(() => JSON.stringify(window.__ot.session.specs));
for (const [col, values] of [[1, ['0', '-1', '', 'abc']], [2, ['0', '-1', '']], [3, ['-1', '11', '2.5', '']], [0, ['-3', '']]]) {
  for (const v of values) {
    await openSettings();
    const f = page.locator('.modal .tbl tbody tr').first().locator('input').nth(col), keep = await f.inputValue();
    await put(f, v);
    await page.locator('.modal button', { hasText: 'Save settings' }).click(); await page.waitForTimeout(250);
    const stays = (await page.locator('.modal').count()) > 0;
    ok(stays && (await page.evaluate(() => JSON.stringify(window.__ot.session.specs))) === specBefore, `settings · ${['spread', 'pip size', 'contract size', 'digits'][col]} "${v}" is refused: "${(await toast()).slice(0, 60)}"`);
    if (stays) await put(f, keep);
  }
}
await openSettings();
await put(page.locator('.modal .field', { hasText: 'Commission' }).locator('input'), '-2');
await page.locator('.modal button', { hasText: 'Save settings' }).click(); await page.waitForTimeout(250);
ok((await page.locator('.modal').count()) > 0 && (await page.evaluate(() => window.__ot.session.commissionPerLot)) >= 0, 'settings · a negative commission is refused');
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
await page.reload(); await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1200);
ok((await st()).sane && (await junkOnPage()) === 0, 'the session still opens after all of that');

// ---- double clicks ------------------------------------------------------------------------------------
await put(page.locator('#tSl'), '0'); await blur();
for (let i = 0; i < 4; i++) { await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(140); }
ok((await st()).nPos === 4, 'four positions open');
await page.locator('.ws .tbl tbody tr').first().locator('button.danger').dblclick(); await page.waitForTimeout(700);
ok((await st()).nPos === 3, `a double click on ✕ closes one position, not the one that slides up under the cursor too (${(await st()).nPos} left)`);
await page.locator('.ws .tbl tbody tr').first().locator('button', { hasText: '⇄' }).dblclick(); await page.waitForTimeout(700);
s = await st();
const sides = await page.evaluate(() => window.__ot.replay.broker.s.positions.map((p) => p.side));
ok(s.nPos === 3 && sides.filter((x) => x === 'short').length === 1, `a double click on ⇄ reverses one position once (${sides.join(', ')})`);
await page.locator('.ws .tbl tbody tr').first().locator('button', { hasText: '½' }).dblclick(); await page.waitForTimeout(700);
ok((await st()).sane, 'a double click on ½ leaves sane books');
await closeAll();
await page.locator('.ws .seg', { hasText: /^Limit$/ }).click(); await page.waitForTimeout(200);
const bid = await page.evaluate(() => { const w = window.__ot; return w.replay.broker.bid(w.active.cfg.symbol); });
await put(page.locator('#tPrice'), (bid - 0.002).toFixed(5)); await blur();
for (let i = 0; i < 3; i++) { await page.locator('#placeBtn').click(); await page.waitForTimeout(500); }
await page.locator('.ws .tab', { hasText: 'Orders' }).click(); await page.waitForTimeout(200);
ok((await st()).nOrd === 3, 'three pending orders');
await page.locator('.ws .tbl button', { hasText: 'Cancel' }).first().dblclick(); await page.waitForTimeout(700);
ok((await st()).nOrd === 2, `a double click on Cancel removes one order (${(await st()).nOrd} left)`);
await closeAll();
await page.locator('.ws .tab', { hasText: 'Positions' }).click();
await page.locator('.ws .seg', { hasText: /^Market$/ }).click(); await page.waitForTimeout(200);
await put(page.locator('#tSl'), '15'); await blur();

// ---- key spam, resizing and theme switching while it plays ----------------------------------------------
const e0 = errors.length;
await page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await page.keyboard.press('Escape');
await page.locator('select[title="Playback speed"]').selectOption('20');
await page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await page.keyboard.press('Escape');
await page.keyboard.press('Space');
const keys = ['ArrowRight', 'Shift+ArrowRight', 'Shift+B', 'Shift+S', 'ArrowRight', 'Shift+C', 'Alt+2', 'Alt+4', 'Alt+1', '`', '`', 'Alt+T', 'Escape', 'Delete', 'Space', 'Space', '5', 'Enter', '1', '5', 'Enter', 'Escape'];
for (let i = 0; i < 160; i++) await page.keyboard.press(keys[i % keys.length]);
for (const [w, hh] of [[1024, 700], [1920, 1080], [800, 600], [1440, 900], [1280, 720], [1440, 900]]) { await page.setViewportSize({ width: w, height: hh }); await page.waitForTimeout(220); }
for (let i = 0; i < 4; i++) { await page.locator('.topbar .theme-toggle, .topbar button[title*="theme" i], .topbar button[aria-label*="theme" i]').first().click().catch(() => {}); await page.waitForTimeout(250); }
await page.waitForTimeout(600);
if (await page.evaluate(() => !!window.__ot.playing)) await page.keyboard.press('Space');
await page.keyboard.press('Escape'); await page.keyboard.press('Shift+C'); await page.waitForTimeout(500);
s = await st();
const fit = await page.evaluate(() => [...document.querySelectorAll('.ws .pane')].every((p) => { const c = p.querySelector('.pane-chart'), r = c.getBoundingClientRect(); const cv = c.querySelector('canvas').getBoundingClientRect(); return r.width > 200 && Math.abs(cv.width - r.width) < 80 && cv.height > 100; }));
ok(s.sane && errors.length === e0 && (await junkOnPage()) === 0, `160 mixed key presses, six window sizes and four theme switches during playback: no errors, books sane${errors.length > e0 ? ' — ' + errors.slice(e0, e0 + 3).join(' | ') : ''}`);
ok(fit, 'the chart fills its pane after the resizing');
const closedSum = await page.evaluate(() => { const b = window.__ot.replay.broker.s; return b.trades.reduce((a, t) => a + t.pnl, 0) + window.__ot.session.balance - b.balance; });
ok(Math.abs(closedSum) < 0.01, 'balance = starting balance + closed P&L after the spam');

// ---- offline ----------------------------------------------------------------------------------------------
await page.waitForTimeout(1200);
await ctx.setOffline(true);
const e1 = errors.length;
for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
await page.locator('.ws .quote button.buy').click(); await page.waitForTimeout(200); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+C');
await page.locator('.ws .topbar .primary').click();
await page.getByText('Does this method have').first().waitFor({ timeout: 30000 });
await page.locator('a.brand-mark, a[href="#/"]').first().click(); await page.locator('.scard').first().waitFor();
ok(errors.length === e1 && (await page.locator('.scard').count()) >= 2, `offline: replay, analytics and the session list keep working${errors.length > e1 ? ' — ' + errors.slice(e1, e1 + 3).join(' | ') : ''}`);
await ctx.setOffline(false);

// ---- generating practice data ----------------------------------------------------------------------------
await page.goto(BASE + '#/data'); await page.getByRole('button', { name: 'Generate synthetic' }).click(); await page.waitForTimeout(250);
const metaIds = () => page.evaluate(() => new Promise((res) => { const q = indexedDB.open('overflowtrade'); q.onsuccess = () => { const g = q.result.transaction('meta').objectStore('meta').getAllKeys(); g.onsuccess = () => res(g.result); }; }));
const ids0 = (await metaIds()).length;
for (const [label, v] of [['Days', '1000000000'], ['Days', '0'], ['Days', '-3'], ['Days', ''], ['Start price', '0'], ['Start price', '-1'], ['Annual volatility (%)', '0'], ['Annual volatility (%)', '100000'], ['Symbol', '   ']]) {
  const f = page.locator('.modal .field', { hasText: label }).locator('input'), keep = await f.inputValue();
  await put(f, v);
  const t0 = Date.now();
  await page.locator('.modal button', { hasText: 'Generate' }).click(); await page.waitForTimeout(400);
  ok((await page.locator('.modal').count()) > 0 && Date.now() - t0 < 3000 && (await metaIds()).length === ids0, `practice data · ${label} "${v.slice(0, 12)}" is refused at once: "${(await toast()).slice(0, 60)}"`);
  await put(f, keep);
}
const dateF = page.locator('.modal input[type=date]');
await put(dateF, ''); await page.locator('.modal button', { hasText: 'Generate' }).click(); await page.waitForTimeout(400);
ok((await page.locator('.modal').count()) > 0 && (await metaIds()).length === ids0, `practice data · an empty start date is refused: "${(await toast()).slice(0, 50)}"`);
await put(dateF, '2024-01-01');
await put(page.locator('.modal .field', { hasText: 'Days' }).locator('input'), '2');
await put(page.locator('.modal .field', { hasText: 'Symbol' }).locator('input'), 'roughtest');
await page.locator('.modal button', { hasText: 'Generate' }).click(); await page.waitForTimeout(1500);
ok((await metaIds()).includes('ROUGHTEST') && !(await page.locator('.modal').count()), 'valid practice data is still generated');
ok(!errors.length, `no console errors in the whole run${errors.length ? ' — ' + errors.slice(0, 4).join(' | ') : ''}`);
await browser.close();
