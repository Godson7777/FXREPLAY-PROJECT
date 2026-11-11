// The chart keeps a window of candles behind the replay cursor. This checks, with a small
// window (400 / 600 / 2,000 instead of 8,000 / 12,000 / 60,000) so it runs in seconds:
//  - while following the replay, old candles are dropped and the view keeps following;
//  - while looking at older candles, they are not dropped from under the view;
//  - scrolling to the left edge loads older candles, and the view stays on the same ones;
//  - the hard limit holds.
//   npm run build && npm run preview &   then   node tests/e2e/chart-window.mjs
import { open, demoSession } from './lib.mjs';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, ctx, page, errors } = await open();
await ctx.addInitScript(() => { try { localStorage.setItem('overflowtrade.debug', '1'); localStorage.setItem('overflowtrade.debug.window', '400,600,2000'); } catch {} });
await demoSession(page);
await page.locator('.ws .chip', { hasText: /^1m$/ }).first().click();
await page.waitForTimeout(500);

const state = () => page.evaluate(() => {
  const p = window.__ot.panes[0], ts = p.chart.timeScale(), vr = ts.getVisibleLogicalRange(), tr = ts.getVisibleRange();
  return { start: p.start, k: p.k, len: p.k - p.start + 1, from: vr ? Math.round(vr.from) : null, to: vr ? Math.round(vr.to) : null, right: +ts.scrollPosition().toFixed(1), tFrom: tr?.from ?? null, lastVisible: vr ? vr.to >= p.k - p.start : null };
});
const play = async (ms, speed = '100') => {
  await page.locator('select[title="Playback speed"]').selectOption(speed);
  await page.keyboard.press('Space'); await page.waitForTimeout(ms); await page.keyboard.press('Space'); await page.waitForTimeout(300);
};
const box = await page.locator('.ws .pane canvas').first().boundingBox();
const drag = async (dx, steps = 20) => {
  const y = box.y + box.height / 2, x0 = box.x + box.width / 2;
  await page.mouse.move(x0, y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + (dx * i) / steps, y);
  await page.mouse.up(); await page.waitForTimeout(250);
  await page.mouse.move(box.x + 300, box.y + box.height + 60);
};

/** Back to the latest candle, as after dragging the chart all the way to the right. */
const toRealTime = async () => {
  await page.evaluate(() => window.__ot.panes[0].toLatest());
  await page.waitForTimeout(300);
};

// 1) following the replay
const s0 = await state();
ok(s0.len <= 400 && s0.lastVisible, `starts with a window of ${s0.len} candles, the latest one in view (right offset ${s0.right})`);
await play(14000);
const s1 = await state();
ok(s1.k - s0.k > 700, `played ${s1.k - s0.k} candles`);
ok(s1.start > s0.start && s1.len <= 600, `old candles were dropped: window is ${s1.len} candles (never above 600)`);
ok(s1.lastVisible && Math.abs(s1.right - s0.right) < 1.5, `the view still follows the latest candle (right offset ${s0.right} → ${s1.right})`);
for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
const s1b = await state();
ok(s1b.lastVisible && Math.abs(s1b.right - s0.right) < 1.5, `stepping by hand keeps following too (right offset ${s1b.right})`);

// 2) looking at older candles while the replay runs
await drag(700);
const s2 = await state();
ok(!s2.lastVisible, `scrolled back: the view now ends ${Math.round(-s2.right)} candles before the latest`);
await play(9000);
const s3 = await state();
ok(s3.tFrom === s2.tFrom, `exactly the same candles stay in view while ${s3.k - s2.k} more are replayed (left edge moved by ${(s3.tFrom - s2.tFrom) / 60} candles)`);
ok(s3.len > 600 && s3.from >= 0, `the candles in view were kept: window grew to ${s3.len}`);
ok(s3.len <= 2000 + 200, `…but the hard limit holds (${s3.len} ≤ 2,000)`);

// 3) back to the latest candle: the window is cut again
await toRealTime();
await play(8000);
const s4 = await state();
ok(s4.len <= 600 && s4.lastVisible, `after returning to the latest candle the window is ${s4.len} again and follows`);

// 4) the left edge loads older candles and keeps the view
let s5 = s4;
for (let i = 0; i < 12 && s5.start >= s4.start; i++) { await drag(900); s5 = await state(); }
await page.waitForTimeout(400);
ok(s5.start < s4.start && s5.from >= 0, `scrolling to the left edge loaded older candles (window start ${s4.start} → ${s5.start}), no empty space`);
const before = await state();
await drag(900); await drag(900);
const after = await state();
ok(after.start <= before.start && after.tFrom != null && after.tFrom < before.tFrom, `keeps going back in time (${new Date(before.tFrom * 1000).toISOString().slice(0, 16)} → ${new Date(after.tFrom * 1000).toISOString().slice(0, 16)})`);
ok(after.len <= 2000 + 200, `the hard limit holds while scrolling back (${after.len} candles)`);

// 5) a jump forward resets the window and follows
await page.locator('.ws .controls button', { hasText: '+1D' }).click();
await page.waitForTimeout(500);
const s6 = await state();
ok(s6.from >= -2 && s6.len <= 2200, `a +1D skip while scrolled back leaves no empty chart (view starts at candle ${s6.from} of ${s6.len})`);
await toRealTime();
await page.locator('.ws .controls button', { hasText: '+1D' }).click();
await page.waitForTimeout(500);
const s7 = await state();
ok(s7.len <= 400 && s7.lastVisible, `a +1D skip while following: window ${s7.len}, latest candle in view`);

// 6) timeframe changes still work with the window
for (const tf of ['5m', '1H', '1m']) {
  await page.locator('.ws .chip', { hasText: new RegExp(`^${tf}$`) }).first().click();
  await page.waitForTimeout(400);
  const s = await state();
  ok(s.len >= 1 && s.len <= 400 && s.lastVisible, `${tf}: window ${s.len}, latest candle in view`);
}
ok(!errors.length, `no console errors${errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
