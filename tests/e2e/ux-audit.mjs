// Trading-experience audit: frame pacing, long tasks, input delay, layout shift and tap-target size.
//   npm run build && npm run preview &   then   node tests/e2e/ux-audit.mjs
import { open, measure, demoSession, throttle } from './lib.mjs';

const chartBox = async (page) => page.locator('.ws .pane canvas').first().boundingBox();

async function desktop() {
  console.log(`\n== Desktop 1440×900, replay, CPU ${process.env.CPU ?? 4}× slower ==`);
  const { browser, page, errors } = await open();
  await demoSession(page);
  await throttle(page);
  const speed = page.locator('select[title="Playback speed"]');
  for (const v of ['10', '100']) {
    await speed.selectOption(v);
    await measure(page, `play ${v} candles/s for 4 s`, async () => { await page.keyboard.press('Space'); await page.waitForTimeout(4000); await page.keyboard.press('Space'); });
  }
  await measure(page, 'step 30 candles (→ key)', async () => { for (let i = 0; i < 30; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(40); } });
  const b = await chartBox(page);
  await measure(page, 'drag the chart (pan)', async () => {
    await page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2); await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(b.x + b.width * 0.7 - i * 6, b.y + b.height / 2 + Math.sin(i / 5) * 20);
    await page.mouse.up();
  });
  await measure(page, 'zoom the chart (wheel)', async () => { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, i < 15 ? 120 : -120); await page.waitForTimeout(16); } });
  await measure(page, 'click BUY (market)', async () => { await page.locator('.ws button.buy').first().click(); });
  // a slow press (400 ms between down and up) while prices tick must still count as a click
  {
    await speed.selectOption('10');
    const n0 = await page.locator('.ws .tab', { hasText: 'Positions' }).innerText();
    await page.keyboard.press('Space');
    const bb = await page.locator('.ws .quote button.buy').boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.waitForTimeout(400); await page.mouse.up();
    await page.keyboard.press('Space'); await page.waitForTimeout(300);
    const n1 = await page.locator('.ws .tab', { hasText: 'Positions' }).innerText();
    console.log(`${n0 !== n1 ? 'PASS' : 'FAIL'} slow click on BUY during playback opens a position (${n0} → ${n1})`);
    if (n0 === n1) process.exitCode = 1;
  }
  await measure(page, 'type in the stop-loss field', async () => { await page.locator('#tSl').click(); await page.keyboard.type('35', { delay: 40 }); });
  await page.keyboard.press('Escape'); await page.mouse.click(b.x + 300, b.y + 200);
  await measure(page, 'play 10/s with a position open', async () => { await speed.selectOption('10'); await page.keyboard.press('Space'); await page.waitForTimeout(3000); await page.keyboard.press('Space'); });
  await measure(page, 'switch timeframe (1H chip)', async () => { await page.locator('.ws .chip', { hasText: /^1H$/ }).first().click(); });
  await measure(page, 'switch tab (History)', async () => { await page.locator('.ws .tab', { hasText: 'History' }).click(); });
  await measure(page, '4-chart layout', async () => { await page.locator('.ws button.seg').nth(3).click(); }, 800);
  await measure(page, 'play 10/s with 4 charts', async () => { await page.keyboard.press('Space'); await page.waitForTimeout(3000); await page.keyboard.press('Space'); });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
}

async function phone() {
  console.log(`\n== Phone 390×844 (touch), replay, CPU ${process.env.CPU ?? 4}× slower ==`);
  const { browser, page, errors } = await open({ width: 390, height: 844, phone: true });
  await demoSession(page);
  await throttle(page);
  const small = await page.evaluate(() => [...document.querySelectorAll('.ws button, .ws select, .ws input:not([type=checkbox]), .ws a')].filter((e) => e.offsetParent && e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('aria-label') || e.title || e.textContent || e.id || '').trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.h < 40 || x.w < 40));
  console.log(`tap targets under 40 px: ${small.length}` + (small.length ? '\n  ' + small.map((s) => `${s.n} ${s.w}×${s.h}`).join('\n  ') : ''));
  console.log('horizontal scroll:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await measure(page, 'play for 3 s', async () => { await page.locator('.tb-play').tap(); await page.waitForTimeout(3000); await page.locator('.tb-play').tap(); });
  await measure(page, 'open the order sheet', async () => { await page.locator('.trade-bar .tb-order').tap(); }, 700);
  const sheetOpen = await page.locator('.sheet[aria-hidden="false"]').count();
  if (sheetOpen) {
    const tiny = await page.evaluate(() => [...document.querySelectorAll('.sheet button, .sheet select, .sheet input:not([type=checkbox])')].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('aria-label') || e.title || e.textContent || e.id || '').trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.h < 40));
    console.log(`order sheet controls under 40 px tall: ${tiny.length}` + (tiny.length ? '\n  ' + tiny.map((s) => `${s.n} ${s.w}×${s.h}`).join('\n  ') : ''));
    await measure(page, 'place the order from the sheet', async () => { await page.locator('.sheet .place-btn').tap(); }, 700);
  }
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
}

const only = process.argv[2];
if (!only || only === 'desktop') await desktop();
if (!only || only === 'phone') await phone();
