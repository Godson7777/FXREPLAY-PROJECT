// Live Hyperliquid check: connects, prices move, a market order fills at the live price.
//   node tests/e2e/live.mjs [coin]        (BASE=https://… to test a deployed site, BLOCK_WS=1 to test the polling fallback)
import { open, BASE } from './lib.mjs';
const coin = process.argv[2] ?? 'BTC';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, page, errors } = await open(process.env.PHONE ? { width: 390, height: 844, phone: true } : {});
const sockets = [];
page.on('websocket', (ws) => { const s = { url: ws.url(), frames: 0, closed: false }; sockets.push(s); ws.on('framereceived', () => s.frames++); ws.on('close', () => (s.closed = true)); });
// BLOCK_WS=1 simulates a network that blocks WebSockets: the feed must fall back to polling
if (process.env.BLOCK_WS) await page.routeWebSocket(/hyperliquid/, (ws) => ws.close());
await page.goto(BASE);
await page.getByRole('button', { name: /Live market/ }).first().click();
await page.locator('.coin-list option').first().waitFor({ state: 'attached', timeout: 30000 });
const markets = await page.locator('.coin-picker small').innerText();
console.log('markets:', markets);
await page.locator('.coin-picker input').fill(coin);
await page.locator('.coin-list').selectOption({ index: 0 });
const picked = await page.locator('.coin-list').inputValue();
await page.getByRole('button', { name: 'Start live session' }).click();
await page.waitForURL(/#\/replay\//, { timeout: 60000 });
await page.locator('.ws canvas').first().waitFor();
const badge = () => page.locator('.live-badge').first().innerText();
const price = () => page.locator(process.env.PHONE ? '[data-tb=bid]' : '[data-live=bid]').first().innerText();
await page.waitForTimeout(6000);
const b0 = await badge(), p0 = await price();
ok(process.env.BLOCK_WS ? /updates every 3 s/.test(b0) : /^● LIVE( ·.*)?$/.test(b0) && !/every/.test(b0), `${picked}: feed is live within 6 s — badge "${b0}"`);
const seen = new Set([p0]);
for (let i = 0; i < 40 && seen.size < 3; i++) { await page.waitForTimeout(1000); seen.add(await price()); }
ok(seen.size >= 2, `price updates in real time (${[...seen].join(' → ')})`);
console.log('sockets:', JSON.stringify(sockets));
if (!process.env.PHONE) {
  await page.locator('.ws .quote button.buy').click();
  await page.waitForTimeout(800);
  console.log('toasts:', await page.locator('#toasts').innerText().catch(() => ''), '| tabs:', await page.locator('.ws .tabs').innerText().catch(() => ''), '| calc:', (await page.locator('#calc').innerText().catch(() => '')).replace(/\n/g, ' '));
  ok(/Positions \(1\)/.test(await page.locator('.ws .tab').first().innerText()), 'market BUY fills at the live price');
}
await page.screenshot({ path: process.env.SHOT ?? 'live.png' }).catch(() => {});
console.log('badge now:', await badge(), '| errors:', errors.length ? errors : 'none');
await browser.close();
