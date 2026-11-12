// Trading through the real screen, with the money checked after every action.
//   npm run build && npm run preview &   then   node tests/e2e/trading-scenarios.mjs
import { open, demoSession } from './lib.mjs';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, ctx, page, errors } = await open();
await ctx.addInitScript(() => { try { localStorage.setItem('overflowtrade.debug', '1'); } catch {} });
await demoSession(page);

const st = () => page.evaluate(() => {
  const w = window.__ot, br = w.replay.broker, s = br.s;
  return {
    balance: s.balance, equity: br.equity(), start: w.session.balance,
    positions: s.positions.map((p) => ({ id: p.id, side: p.side, lots: p.lots, entry: p.entry, sl: p.sl, tp: p.tp, fl: br.floating(p), booked: p.realized - p.commission })),
    orders: s.orders.map((o) => ({ id: o.id, type: o.type, side: o.side, price: o.price, sl: o.sl, tp: o.tp })),
    trades: s.trades.map((t) => ({ id: t.id, pnl: t.pnl, r: t.r, why: t.exitReason, lots: t.lots })),
    bid: br.bid(w.active.cfg.symbol), ask: br.ask(w.active.cfg.symbol),
  };
});
/** The books must always add up. */
const books = async (label) => {
  const s = await st();
  const sum = s.trades.reduce((a, t) => a + t.pnl, 0), fl = s.positions.reduce((a, p) => a + p.fl, 0);
  // an open position has already booked its commission and any partial closes
  const open = s.positions.reduce((a, p) => a + p.booked, 0);
  ok(Math.abs(s.balance - (s.start + sum + open)) < 0.01, `${label}: balance ${s.balance.toFixed(2)} = start + closed P&L + booked on open positions`);
  ok(Math.abs(s.equity - (s.balance + fl)) < 0.01, `${label}: equity = balance + floating`);
  ok(s.positions.every((p) => p.lots > 0) && s.trades.every((t) => t.lots > 0), `${label}: no empty positions or trades`);
  return s;
};
const toast = async () => (await page.locator('#toasts .toast').last().innerText().catch(() => '')).trim();
const step = async (n = 1) => { for (let i = 0; i < n; i++) await page.keyboard.press('ArrowRight'); await page.waitForTimeout(120); };
const setField = async (sel, v) => { await page.locator(sel).click(); await page.keyboard.press('Control+A'); await page.keyboard.type(String(v)); await page.locator('.ws .tab').first().click(); };
const row = () => page.locator('.ws .tbl tbody tr').first();

// 1) the ticket shows what is typed, and a market buy opens with stop and target
await setField('#tSize', '0.25');
const fits = await page.evaluate(() => { const i = document.querySelector('#tSize'); const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(i); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; return c.measureText(i.value).width <= i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); });
ok(fits, 'the Size field shows "0.25" in full');
await setField('#tSl', '15');
await page.locator('.ws .quote button.buy').click();
await page.waitForTimeout(300);
let s = await books('market buy');
ok(s.positions.length === 1 && s.positions[0].sl < s.positions[0].entry && s.positions[0].tp > s.positions[0].entry, 'buy opened with a stop below and a target above');
const risk = await page.evaluate(() => { const w = window.__ot, p = w.replay.broker.s.positions[0]; return w.replay.broker.value(p.symbol, p.entry - p.sl, p.lots, p.sl); });
ok(Math.abs(risk - s.start * 0.0025) < s.start * 0.0025 * 0.2, `sized by risk: stop risks $${risk.toFixed(2)} for 0.25% of $${s.start}`);

// 2) levels on the wrong side are refused and explained
const slIn = row().locator('input.lvl').first();
const before = s.positions[0].sl;
await slIn.fill(String((s.bid + 0.002).toFixed(5))); await slIn.press('Tab'); await page.waitForTimeout(250);
ok(/Stop loss must be below/.test(await toast()), `stop above the price is refused: "${(await toast()).slice(0, 70)}"`);
s = await st();
ok(s.positions.length === 1 && s.positions[0].sl === before, 'the stop is unchanged and the trade is still open');
await step(1);
ok((await st()).positions.length === 1, '…and still open on the next bar');

// 3) breakeven on a losing trade is refused
await page.evaluate(() => { const w = window.__ot, br = w.replay.broker, p = br.s.positions[0]; br.setPrice(p.symbol, br.now(p.symbol), p.entry - 0.0004); w.renderAll?.(); });
await row().locator('button', { hasText: 'BE' }).click(); await page.waitForTimeout(250);
ok(/Not in profit yet/.test(await toast()), `BE while losing is refused: "${(await toast()).slice(0, 60)}"`);
ok((await st()).positions[0].sl === before, 'the stop is unchanged');

// 4) half close, reverse, close
await row().locator('button', { hasText: '½' }).click(); await page.waitForTimeout(250);
s = await books('half close');
ok(s.positions.length === 1 && s.positions[0].lots > 0, `half closed: ${s.positions[0].lots} lots left`);
await row().locator('button', { hasText: '⇄' }).click(); await page.waitForTimeout(300);
s = await books('reverse');
ok(s.positions.length === 1 && s.positions[0].side === 'short' && s.trades.length === 1, 'reverse: the long is closed and a short is open');
await row().locator('button.danger').click(); await page.waitForTimeout(300);
s = await books('close');
ok(s.positions.length === 0 && s.trades.length === 2, 'closed by hand: two trades in History');

// 5) pending orders: place, refuse a bad drag, fill, stop out
await page.locator('.ws .seg', { hasText: /^Limit$/ }).click(); await page.waitForTimeout(200);
s = await st();
await setField('#tPrice', (s.bid - 0.0008).toFixed(5));
await page.locator('.ws .seg.buy-seg').click().catch(() => {});
await page.locator('#placeBtn').click(); await page.waitForTimeout(300);
s = await st();
ok(s.orders.length === 1 && s.orders[0].type === 'limit', `buy limit placed at ${s.orders[0]?.price}`);
const bad = await page.evaluate(() => { const br = window.__ot.replay.broker, o = br.s.orders[0]; return br.modifyOrder(o.id, { price: br.ask(o.symbol) + 0.001 }); });
ok(/buy limit must stay below/.test(bad ?? ''), 'moving a buy limit above the price is refused');
await page.locator('.ws .tab', { hasText: 'Orders' }).click(); await page.waitForTimeout(200);
await page.locator('.ws .tbl button', { hasText: 'Cancel' }).click(); await page.waitForTimeout(250);
ok((await st()).orders.length === 0, 'order cancelled');
await page.locator('.ws .tab', { hasText: 'Positions' }).click();
await page.locator('.ws .seg', { hasText: /^Market$/ }).click();

// 6) twenty trades left to their stops and targets: the books add up at every close
await setField('#tSl', '6');
let closedBySlTp = 0;
for (let i = 0; i < 20; i++) {
  await page.locator(`.ws .quote button.${i % 2 ? 'sell' : 'buy'}`).click(); await page.waitForTimeout(120);
  for (let k = 0; k < 60 && (await st()).positions.length; k++) await step(3);
  if ((await st()).positions.length) { await page.keyboard.press('Shift+C'); await page.waitForTimeout(150); }
}
s = await books('after 20 automatic exits');
closedBySlTp = s.trades.filter((t) => t.why === 'sl' || t.why === 'tp').length;
ok(closedBySlTp >= 15, `${closedBySlTp} of the last 20 closed at their stop or target`);
const rs = s.trades.filter((t) => t.why === 'sl' && t.r != null).map((t) => t.r);
ok(rs.every((r) => r <= -0.9 && r >= -1.6), `stop-outs lose about 1R (${rs.length} trades, worst ${Math.min(...rs).toFixed(2)}R)`);
const tps = s.trades.filter((t) => t.why === 'tp' && t.r != null).map((t) => t.r);
ok(tps.every((r) => r > 1.5 && r < 2.3), `targets pay about 2R (${tps.length} trades)`);

// 7) the screen agrees with the engine, and so does Analytics
const hist = await page.locator('.ws .tab', { hasText: 'History' }).innerText();
ok(hist.includes(`(${s.trades.length})`), `History tab counts ${s.trades.length} trades`);
const acct = await page.locator('.card.acct').innerText();
const shown = +(/Balance\s*\$([\d,.]+)/.exec(acct)?.[1] ?? '0').replace(/,/g, '');
ok(Math.abs(shown - s.balance) < 0.01, `account card balance $${shown} matches`);
await page.locator('.ws .topbar .primary').click();
await page.getByText('Does this method have').first().waitFor({ timeout: 60000 });
await page.locator('.kpis').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(1800);
const net = (await page.locator('.kpi b').first().getAttribute('data-v')) ?? '';
const netNum = +net.replace(/[^\d.\-−]/g, '').replace('−', '-');
ok(Math.abs(Math.abs(netNum) - Math.abs(s.balance - s.start)) < 0.02, `Analytics net result ${net} matches the engine (${(s.balance - s.start).toFixed(2)})`);
ok(!errors.length, `no console errors${errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
