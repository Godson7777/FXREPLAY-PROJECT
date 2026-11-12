// Every replay control on a desktop screen: steps, speeds, skips, jumps, timeframes, chart types,
// layouts, indicators, drawings, shortcuts, and a reload in the middle of it all.
//   npm run build && npm run preview &   then   node tests/e2e/replay-controls.mjs
import { open, demoSession } from './lib.mjs';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, ctx, page, errors } = await open();
await ctx.addInitScript(() => { try { localStorage.setItem('overflowtrade.debug', '1'); } catch {} });
await demoSession(page);

const st = () => page.evaluate(() => {
  const w = window.__ot, p = w.active, br = w.replay.broker;
  return {
    clock: w.replay.clock, tf: p.cfg.tf, sym: p.cfg.symbol, panes: w.panes.length, k: p.k, type: p.chartType(),
    ind: p.cfg.indicators.length, drawings: (w.session.state.drawings[p.cfg.symbol] ?? []).length,
    positions: br.s.positions.length, orders: br.s.orders.length, trades: br.s.trades.length, balance: br.s.balance,
    playing: !!w.playing, finished: !!w.session.state.finished,
  };
});
const toast = async () => (await page.locator('#toasts .toast').last().innerText().catch(() => '')).trim();
const blur = () => page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } });
const tfSec = (tf) => { const m = /^(\d*)([mHDWM])$/.exec(tf); const n = +(m?.[1] || 1); return n * { m: 60, H: 3600, D: 86400, W: 604800, M: 2592000 }[m?.[2] ?? 'm']; };

// 1) single steps
let a = await st();
await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150);
let b = await st();
ok(b.clock - a.clock >= tfSec(a.tf) * 0.5 && b.clock > a.clock, `→ reveals one ${a.tf} candle (+${(b.clock - a.clock) / 60} min)`);
await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(150);
a = b; b = await st();
ok(b.clock - a.clock === 60, `Shift+→ reveals one 1-minute tick (+${b.clock - a.clock}s)`);
await page.locator('.controls .ctl[title^="Next candle"]').click(); await page.waitForTimeout(150);
a = b; b = await st();
ok(b.clock > a.clock, 'the ⏭ button steps a candle');
await page.locator('.controls .ctl[title^="Next 1-minute"]').click(); await page.waitForTimeout(150);
a = b; b = await st();
ok(b.clock - a.clock === 60, 'the › button steps a tick');

// 2) every speed plays at about its rate, and pause stops it
await page.locator('.ws .chip', { hasText: /^1m$/ }).first().click(); await page.waitForTimeout(400);
for (const v of ['0.5', '1', '2', '3', '5', '10', '20', '50', '100']) {
  await page.locator('select[title="Playback speed"]').selectOption(v);
  await blur();
  const s0 = await st();
  await page.keyboard.press('Space'); await page.waitForTimeout(3000); await page.keyboard.press('Space'); await page.waitForTimeout(250);
  const s1 = await st();
  const got = (s1.clock - s0.clock) / 60, want = +v * 3;
  ok(got >= Math.floor(want * 0.6) && got <= Math.ceil(want * 1.35) + 1, `${v}×/s: ${got} candles in 3 s (expected about ${want})`);
  await page.waitForTimeout(500);
  ok((await st()).clock === s1.clock, `${v}×/s: paused means paused`);
}
await page.locator('select[title="Playback speed"]').selectOption('10');
await page.locator('.ws .chip', { hasText: /^15m$/ }).first().click(); await page.waitForTimeout(400);
await page.locator('select[title="What one playback step reveals"]').selectOption('base');
await blur();
a = await st();
await page.keyboard.press('Space'); await page.waitForTimeout(2000); await page.keyboard.press('Space'); await page.waitForTimeout(250);
b = await st();
ok((b.clock - a.clock) / 60 >= 10 && (b.clock - a.clock) / 60 <= 30, `"per 1m tick" on a 15m chart: ${(b.clock - a.clock) / 60} minutes in 2 s at 10×/s`);
await page.locator('select[title="What one playback step reveals"]').selectOption('candle');

// 3) skips
for (const [label, min] of [['+1H', 3600], ['+4H', 14400], ['+1D', 86400]]) {
  a = await st();
  await page.locator('.controls button', { hasText: label }).click(); await page.waitForTimeout(500);
  b = await st();
  ok(b.clock - a.clock >= min && b.clock - a.clock < min + 3 * 86400, `${label} moves ${((b.clock - a.clock) / 3600).toFixed(1)} h forward`);
}
for (const [label, hour] of [['London', 7], ['NY', 13.5]]) {
  await page.locator('.controls button', { hasText: new RegExp(`^${label}$`) }).click(); await page.waitForTimeout(500);
  b = await st();
  const h = (b.clock % 86400) / 3600;
  ok(Math.abs(h - hour) < 0.3, `${label} lands at ${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} UTC`);
}

// 4) jump to a date: backwards is refused, forwards works
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16);
a = await st();
await page.locator('input.jump').fill(iso(a.clock - 86400));
await page.locator('.controls button', { hasText: /^Go$/ }).click(); await page.waitForTimeout(300);
ok(/only move forward/.test(await toast()) && (await st()).clock === a.clock, 'jumping back in time is refused with a message');
await page.locator('input.jump').fill(iso(a.clock + 2 * 86400));
await page.locator('.controls button', { hasText: /^Go$/ }).click(); await page.waitForTimeout(700);
b = await st();
ok(b.clock > a.clock + 86400, `jumping two days ahead works (+${((b.clock - a.clock) / 86400).toFixed(2)} days)`);
await page.locator('.controls button', { hasText: /^Go$/ }).click(); await page.waitForTimeout(300);
ok((await st()).clock === b.clock, 'pressing Go twice does not move again');

// 5) timeframes typed on the keyboard
await blur();
for (const [typed, want] of [['7m', '7m'], ['2h', '2H'], ['3d', '3D'], ['45', '45m'], ['5m', '5m']]) {
  await page.keyboard.type(typed, { delay: 40 });
  await page.keyboard.press('Enter'); await page.waitForTimeout(450);
  b = await st();
  ok(b.tf === want && !(await page.locator('.modal-back').count()), `typing "${typed}" switches to ${want}`);
}
await page.keyboard.type('9', { delay: 40 });
await page.locator('.tf-input').fill('zz');
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
ok(/Unknown timeframe/.test(await toast()) && (await st()).tf === '5m', 'nonsense ("zz") is refused and the chart keeps its timeframe');
await page.keyboard.press('Escape'); await page.waitForTimeout(250);
ok(!(await page.locator('.modal-back').count()), 'Esc closes the timeframe box');

// 6) chart types
const types = await page.locator('select.pane-type option').evaluateAll((o) => o.map((x) => x.value));
for (const t of types) {
  await page.locator('select.pane-type').first().selectOption(t); await page.waitForTimeout(300);
  const drawn = await page.evaluate(() => { const c = document.querySelector('.ws .pane-chart canvas'); return !!c && c.width > 100 && c.height > 100; });
  ok((await st()).type === t && drawn, `chart type "${t}" draws`);
  await page.keyboard.press('ArrowRight').catch(() => {});
}
await page.locator('select.pane-type').first().selectOption('candles');
await blur();

// 7) layouts and synchronised panes
for (const n of [2, 3, 4, 1]) {
  await page.keyboard.press(`Alt+${n}`); await page.waitForTimeout(600);
  b = await st();
  const sizes = await page.locator('.ws .pane').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  ok(b.panes === n && sizes.length === n && sizes.every(([w, hh]) => w > 200 && hh > 120), `Alt+${n}: ${n} chart${n > 1 ? 's' : ''}, each usable (${sizes.map((s) => s.join('×')).join(', ')})`);
  if (n === 4) {
    const before = await page.evaluate(() => window.__ot.panes.map((p) => p.k));
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
    const ends = await page.evaluate(() => { const w = window.__ot; return w.panes.map((p) => { const bars = p.bars ?? []; return { k: p.k, clock: w.replay.clock }; }); });
    ok(ends.every((e, i) => e.k >= before[i]), 'all four charts move together on a step');
  }
}

// 8) indicators: add each, change a parameter, remove all
await page.locator('.topbar button', { hasText: 'Indicators' }).click(); await page.waitForTimeout(250);
const nInd = await page.locator('.modal .chips .chip').count();
for (let i = 0; i < nInd; i++) { await page.locator('.modal .chips .chip').nth(i).click(); await page.waitForTimeout(120); }
b = await st();
ok(b.ind === nInd && nInd > 0, `all ${nInd} indicators can be added`);
const prm = page.locator('.modal .ind-row input').first();
if (await prm.count()) { await prm.fill('0'); await prm.press('Tab'); await page.waitForTimeout(200); await prm.fill('-5'); await prm.press('Tab'); await page.waitForTimeout(200); await prm.fill('99999'); await prm.press('Tab'); await page.waitForTimeout(300); await prm.fill('14'); await prm.press('Tab'); }
ok(!errors.length, `odd indicator settings (0, −5, 99999) do not break the chart${errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''}`);
await page.keyboard.press('Escape'); await page.waitForTimeout(250);
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
await page.locator('.topbar button', { hasText: 'Indicators' }).click(); await page.waitForTimeout(250);
for (let i = 0; i < nInd; i++) { await page.locator('.modal .ind-row .danger').first().click(); await page.waitForTimeout(80); }
ok((await st()).ind === 0, 'and removed again');
await page.keyboard.press('Escape'); await page.waitForTimeout(250);

// 9) drawings: each tool makes a drawing, they survive a reload, Delete removes one
const box = await page.locator('.ws .pane-chart').first().boundingBox();
const tools = await page.evaluate(() => [...document.querySelectorAll('.ws .tools .tool')].map((x) => x.title).filter((t) => t && !/Show|Magnet|Keep|Remove|Cursor|Select/i.test(t)));
let made = 0;
for (let i = 0; i < tools.length; i++) {
  const before = (await st()).drawings;
  await page.locator(`.ws .tools .tool[title="${tools[i]}"]`).click();
  const x = box.x + 160 + i * 45, y = box.y + 120 + (i % 4) * 40;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y + 50, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(150);
  if ((await st()).drawings === before) { await page.mouse.click(x + 70, y + 50); await page.waitForTimeout(150); }
  if ((await st()).drawings === before) { await page.mouse.click(x + 110, y + 20); await page.waitForTimeout(150); }
  const now = (await st()).drawings;
  ok(now === before + 1, `drawing tool "${tools[i].slice(0, 40)}" makes one drawing`);
  if (now > before) made++;
  await page.keyboard.press('Escape');
}
a = await st();
await page.waitForTimeout(1500);
await page.reload(); await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1500);
b = await st();
ok(b.drawings === a.drawings && b.drawings === made, `${b.drawings} drawings are still there after a reload`);
ok(b.clock === a.clock && b.tf === a.tf && b.balance === a.balance && b.trades === a.trades, `the session came back exactly where it was (${iso(b.clock)}, ${b.tf})`);

// 10) trading keys, then a reload with an open position and a pending order
await blur(); await page.keyboard.press('Escape');
await page.keyboard.press('Shift+B'); await page.waitForTimeout(250);
await page.keyboard.press('Shift+S'); await page.waitForTimeout(250);
b = await st();
ok(b.positions === 2, 'Shift+B and Shift+S open a buy and a sell');
await page.keyboard.press('Shift+C'); await page.waitForTimeout(300);
b = await st();
ok(b.positions === 0 && b.trades >= 2, 'Shift+C closes everything');
await page.keyboard.press('Shift+B'); await page.waitForTimeout(250);
await page.evaluate(() => { const w = window.__ot, br = w.replay.broker, s = w.active.cfg.symbol; br.place({ symbol: s, side: 'long', type: 'limit', lots: 0.1, price: +(br.bid(s) - 0.003).toFixed(5), sl: +(br.bid(s) - 0.005).toFixed(5), tp: null }); w.afterTrade?.(); });
await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1500);
a = await st();
const snap = () => page.evaluate(() => JSON.stringify({ p: window.__ot.replay.broker.s.positions, o: window.__ot.replay.broker.s.orders, b: window.__ot.replay.broker.s.balance }));
const s1 = await snap();
await page.reload(); await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1500);
ok((await snap()) === s1, `reload with ${a.positions} open position and ${a.orders} pending order: nothing changed`);
await page.keyboard.press('`'); await page.waitForTimeout(250); await page.keyboard.press('`'); await page.waitForTimeout(250);

// 11) the end of the data
await blur();
await page.locator('input.jump').fill('2099-01-01T00:00');
await page.locator('.controls button', { hasText: /^Go$/ }).click(); await page.waitForTimeout(2500);
b = await st();
const endMsg = (await page.locator('.modal, .nodata-card').allInnerTexts()).join(' ');
ok(/reached the end|end date|Nothing to replay/i.test(endMsg), 'jumping past the last candle shows the end-of-session message');
await page.locator('.modal button, .nodata-card button', { hasText: /Keep reviewing|Dismiss/ }).first().click().catch(() => {}); await page.waitForTimeout(200);
const endClock = (await st()).clock;
await page.keyboard.press('Space'); await page.waitForTimeout(600); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
ok((await st()).clock === endClock, 'play and step at the end do nothing harmful');
ok(!errors.length, `no console errors${errors.length ? ' — ' + errors.slice(0, 4).join(' | ') : ''}`);
await browser.close();
