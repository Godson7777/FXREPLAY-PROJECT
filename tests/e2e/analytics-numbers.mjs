// Are the numbers on the analytics page right? The trades are read back from the browser's
// own storage, the figures are worked out again here with plain loops, and the two are compared
// with what the page shows — for an imported trade list and for a replay session, with every
// filter, both scopes, the Monte Carlo controls, the prop-firm simulator and the trade log.
//   npm run build && npm run preview &   then   node tests/e2e/analytics-numbers.mjs
import { readFileSync } from 'node:fs';
import { open, demoSession, importSample, quickTrades, sampleTradesCsv } from './lib.mjs';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, page, errors } = await open();

// ---- formatting, the way the page writes numbers -------------------------------------------
const M = '−';
const money = (x, signed = false) => `${x < 0 ? M : signed && x > 0 ? '+' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x, d = 1, signed = false) => `${x < 0 ? M : signed && x > 0 ? '+' : ''}${Math.abs(x * 100).toFixed(d)}%`;
const num = (x, d = 2, signed = false) => (!isFinite(x) ? (x > 0 ? '∞' : '—') : `${x < 0 ? M : signed && x > 0 ? '+' : ''}${Math.abs(x).toFixed(d)}`);
const parseMoney = (s) => +String(s).replace(M, '-').replace(/[^\d.\-]/g, '');

// ---- what the page shows ------------------------------------------------------------------
const shown = () => page.evaluate(() => {
  const k = {}, s = {};
  document.querySelectorAll('#sec-performance .kpis:not(.small) .kpi').forEach((e) => (k[e.querySelector('span').textContent] = { v: e.querySelector('b').dataset.v, sub: e.querySelector('small').textContent }));
  document.querySelectorAll('.an-body .stat').forEach((e) => { const l = e.querySelector('span').textContent; if (!(l in s)) s[l] = e.querySelector('b').textContent; });
  return {
    k, s, title: document.querySelector('#sec-trades h2')?.textContent ?? '', rows: document.querySelectorAll('#sec-trades tbody tr').length,
    cal: [...document.querySelectorAll('.cal-title span')].map((x) => x.textContent), empty: !!document.querySelector('.an-body .empty-state'),
    bad: (document.querySelector('.an-body')?.innerText.match(/NaN|undefined|Infinity|\[object/g) ?? []).length,
  };
});
/** The stored session with these trades, straight from IndexedDB. */
const stored = (name) => page.evaluate((nm) => new Promise((res, rej) => {
  const q = indexedDB.open('overflowtrade');
  q.onerror = () => rej(q.error);
  q.onsuccess = () => { const g = q.result.transaction('sessions').objectStore('sessions').getAll(); g.onsuccess = () => res(g.result.filter((s) => (nm === '*' ? true : nm === 'imported' ? !!s.imported : !s.imported)).map((s) => ({ id: s.id, name: s.name, balance: s.balance, tz: s.timezone, trades: s.state.broker.trades }))); };
}), name);
/** Offset of a named zone at a moment, in seconds (the page's sessions carry a zone name). */
const offsetAt = (tz, utc) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(utc * 1000)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) / 1000 - Math.floor(utc / 60) * 60;
};
const localDay = (tz, utc) => new Date((utc + offsetAt(tz, utc)) * 1000).toISOString().slice(0, 10);

/** Plain recount. `keep` chooses a subset; each trade keeps its share of the account at the time. */
function recount(sess, keep = () => true) {
  const T = [...sess.trades].sort((a, b) => a.exitTime - b.exitTime || a.id - b.id);
  let before = sess.balance;
  const rows = T.map((t) => { const r = { t, pct: t.pnl / before, cPct: (t.commission ?? 0) / before }; before += t.pnl; return r; }).filter((r) => keep(r.t));
  let e = sess.balance, peak = e, ddAbs = 0, dd = 0, gp = 0, gl = 0, w = 0, l = 0, sumR = 0, nR = 0, ws = 0, ls = 0, mws = 0, mls = 0, lw = 0, lg = 0, ln = 0, sn = 0, lwin = 0, swin = 0, comm = 0;
  for (const { t, pct: p, cPct } of rows) {
    const pnl = e * p;
    comm += e * cPct; // costs scale with the account, like the results
    e += pnl;
    if (pnl > 0) (w++, (gp += pnl), ws++, (ls = 0), (lw = Math.max(lw, pnl)));
    else if (pnl < 0) (l++, (gl -= pnl), ls++, (ws = 0), (lg = Math.min(lg, pnl)));
    else (ws = 0), (ls = 0);
    mws = Math.max(mws, ws); mls = Math.max(mls, ls);
    if (e >= peak) peak = e;
    else { ddAbs = Math.max(ddAbs, peak - e); dd = Math.max(dd, (peak - e) / peak); }
    if (t.r != null && isFinite(t.r)) (sumR += t.r), nR++;
    if (t.side === 'long') (ln++, pnl > 0 && lwin++); else (sn++, pnl > 0 && swin++);
  }
  const n = rows.length, net = e - sess.balance;
  return { n, net, w, l, be: n - w - l, gp, gl, pf: gl ? gp / gl : gp ? Infinity : 0, dd, ddAbs, sumR, nR, mws, mls, lw, lg, ln, sn, lwin, swin, avgWin: w ? gp / w : 0, avgLoss: l ? -gl / l : 0, ret: net / sess.balance, initial: sess.balance, comm };
}
/** Compare the page with a recount. */
async function compare(label, x) {
  const s = await shown();
  const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;
  if (!x.n) return ok(s.empty, `${label}: no trades match, and the page says so`);
  ok(s.bad === 0, `${label}: no NaN / undefined / Infinity anywhere on the page`);
  ok(s.s['Trades'] === String(x.n) && s.title.includes(`(${x.n})`) && s.rows === Math.min(x.n, 2000), `${label}: ${x.n} trades in the statistics, the heading and the trade log (${s.s['Trades']} / ${s.title.replace(/\s+/g, ' ')} / ${s.rows} rows)`);
  ok(near(parseMoney(s.k['Net result'].v), x.net), `${label}: net result ${s.k['Net result'].v} = recount ${money(x.net, true)}`);
  ok(s.k['Net result'].sub.startsWith(pct(x.ret, 2, true)), `${label}: return "${s.k['Net result'].sub}" starts with ${pct(x.ret, 2, true)}`);
  ok(s.k['Win rate'].v === pct(x.w / x.n) && s.k['Win rate'].sub === `${x.w}W · ${x.l}L · ${x.be} BE`, `${label}: win rate ${s.k['Win rate'].v} (${s.k['Win rate'].sub})`);
  ok(s.k['Profit factor'].v === num(x.pf), `${label}: profit factor ${s.k['Profit factor'].v} = ${num(x.pf)}`);
  ok(s.k['Expectancy'].sub === `${money(x.net / x.n, true)} per trade`, `${label}: ${s.k['Expectancy'].sub}`);
  ok(s.k['Max drawdown'].v === pct(-x.dd, 2) && near(parseMoney(s.k['Max drawdown'].sub.split(' · ')[0]), -x.ddAbs), `${label}: max drawdown ${s.k['Max drawdown'].v} (${s.k['Max drawdown'].sub.split(' · ')[0]})`);
  ok(near(parseMoney(s.s['Avg win']), x.avgWin) && near(parseMoney(s.s['Avg loss']), x.avgLoss), `${label}: average win ${s.s['Avg win']} and loss ${s.s['Avg loss']}`);
  ok(near(parseMoney(s.s['Largest win']), x.lw) && near(parseMoney(s.s['Largest loss']), x.lg), `${label}: largest win ${s.s['Largest win']} and loss ${s.s['Largest loss']}`);
  ok(s.s['Max win streak'] === String(x.mws) && s.s['Max loss streak'] === String(x.mls), `${label}: streaks ${s.s['Max win streak']} wins / ${s.s['Max loss streak']} losses`);
  ok(s.s['Longs'] === `${x.ln} · ${pct(x.ln ? x.lwin / x.ln : 0, 0)} win` && s.s['Shorts'] === `${x.sn} · ${pct(x.sn ? x.swin / x.sn : 0, 0)} win`, `${label}: longs "${s.s['Longs']}", shorts "${s.s['Shorts']}"`);
  if (x.nR) ok(s.s['Total R'] === num(x.sumR, 1, true), `${label}: total R ${s.s['Total R']} = ${num(x.sumR, 1, true)}`);
  ok(near(parseMoney(s.s['Commission paid']), -x.comm, 0.02), `${label}: commission paid ${s.s['Commission paid']}`);
  const calSum = s.cal.reduce((a, c) => a + parseMoney(c), 0);
  ok(near(calSum, x.net, 0.006 * s.cal.length + 0.01), `${label}: the calendar's month totals add up to the net result (${money(calSum, true)})`);
  return s;
}
const field = (label) => page.locator('.an-toolbar label.field', { has: page.locator(`span:text-is("${label}")`) }).locator('select, input');
const setFilter = async (label, value) => { const f = field(label); if ((await f.evaluate((e) => e.tagName)) === 'SELECT') await f.selectOption(value); else { await f.fill(value); await f.dispatchEvent('change'); } await page.waitForTimeout(350); };
const clearFilters = async () => { const b = page.locator('.an-toolbar button', { hasText: 'Clear filters' }); if (await b.isVisible()) { await b.click(); await page.waitForTimeout(500); } };

const cell = (row, col) => page.locator('#sec-trades tbody tr').nth(row).locator('td').nth(col).innerText();
const colOf = async (label) => { const i = (await page.locator('#sec-trades thead th').allTextContents()).findIndex((t) => t.replace(/[ ▲▼]/g, '').toLowerCase() === label.replace(/ /g, '').toLowerCase()); if (i < 0) throw new Error(`no column "${label}" in the trade log`); return i; };

// =========================== 1) a replay session ==========================================
await demoSession(page);
await page.locator('#tSl').click(); await page.keyboard.press('Control+A'); await page.keyboard.type('8'); await page.locator('.ws .tab').first().click();
await quickTrades(page, 30);
// let some trades run to their stop or target as well
for (let i = 0; i < 12; i++) { await page.keyboard.press(i % 2 ? 'Shift+S' : 'Shift+B'); for (let k = 0; k < 40; k++) await page.keyboard.press('ArrowRight'); }
await page.keyboard.press('Shift+C'); await page.waitForTimeout(800);
await page.locator('.ws .topbar .primary').click();
await page.getByText('Does this method have').first().waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
const rep = (await stored('replay'))[0];
ok(rep.trades.length >= 30, `replay session holds ${rep.trades.length} closed trades (timezone ${rep.tz})`);
await compare('replay', recount(rep));
await setFilter('Side', 'long'); await compare('replay · longs only', recount(rep, (x) => x.side === 'long'));
await setFilter('Side', 'short'); await compare('replay · shorts only', recount(rep, (x) => x.side === 'short'));
await clearFilters();
for (const why of [...new Set(rep.trades.map((x) => x.exitReason))]) { await setFilter('Exit', why); await compare(`replay · exit "${why}"`, recount(rep, (x) => x.exitReason === why)); }
await clearFilters();
const days = [...new Set(rep.trades.map((x) => localDay(rep.tz, x.exitTime)))].sort();
if (days.length > 1) {
  await setFilter('From (exit)', days[1]);
  await compare(`replay · from ${days[1]} (${rep.tz})`, recount(rep, (x) => localDay(rep.tz, x.exitTime) >= days[1]));
  await clearFilters();
  await setFilter('To (exit)', days[0]);
  await compare(`replay · up to ${days[0]} (${rep.tz})`, recount(rep, (x) => localDay(rep.tz, x.exitTime) <= days[0]));
  await clearFilters();
}
// the log shows each exit on the same calendar day the calendar and the filter use
const exitCol = await colOf('Exit');
const firstExit = await cell(0, exitCol);
ok(days.includes(firstExit.slice(0, 10)), `the trade log shows exit times in ${rep.tz} (${firstExit})`);

// =========================== 2) an imported trade list ====================================
await importSample(page, sampleTradesCsv(160));
await page.waitForTimeout(1500);
let imp = (await stored('imported'))[0];
ok(imp.trades.length === 160, `imported session holds 160 trades (timezone ${imp.tz})`);
// the file's own realised P&L must be what was stored
const csvPnl = sampleTradesCsv(160).trim().split('\n').slice(1).map((l) => +l.split(',')[5]);
ok(Math.abs(csvPnl.reduce((a, b) => a + b, 0) - imp.trades.reduce((a, t) => a + t.pnl, 0)) < 0.01, 'the stored P&L equals the P&L column of the file');
await compare('imported', recount(imp));

// filters — each one against a recount of the same subset
await setFilter('Side', 'long'); await compare('imported · longs only', recount(imp, (t) => t.side === 'long'));
await setFilter('Side', 'short'); await compare('imported · shorts only', recount(imp, (t) => t.side === 'short'));
const L = recount(imp, (t) => t.side === 'long'), S = recount(imp, (t) => t.side === 'short');
ok(L.n + S.n === 160, `longs (${L.n}) + shorts (${S.n}) = all 160 trades`);
await clearFilters();
const tag = imp.trades.find((t) => t.tags?.length)?.tags[0];
if (tag) { await setFilter('Setup tag', tag); await compare(`imported · tag "${tag}"`, recount(imp, (t) => t.tags.includes(tag))); await clearFilters(); }
const reason = imp.trades[0].exitReason;
await setFilter('Exit', reason); await compare(`imported · exit "${reason}"`, recount(imp, (t) => t.exitReason === reason)); await clearFilters();
// dates: the log shows exit times in the chart timezone, so the filter must cut on those days
const byExit = [...imp.trades].sort((a, b) => a.exitTime - b.exitTime);
const mid = localDay(imp.tz, byExit[60].exitTime), late = localDay(imp.tz, byExit[120].exitTime);
await setFilter('From (exit)', mid);
await compare(`imported · from ${mid}`, recount(imp, (t) => localDay(imp.tz, t.exitTime) >= mid));
await setFilter('To (exit)', late);
await compare(`imported · ${mid} to ${late}`, recount(imp, (t) => { const d = localDay(imp.tz, t.exitTime); return d >= mid && d <= late; }));
await setFilter('Side', 'long');
await compare(`imported · ${mid} to ${late}, longs`, recount(imp, (t) => { const d = localDay(imp.tz, t.exitTime); return d >= mid && d <= late && t.side === 'long'; }));
await setFilter('From (exit)', '2099-01-01');
await compare('imported · a date range with no trades', { n: 0 });
await clearFilters();
await compare('imported · filters cleared', recount(imp));

// ---- trade log: sorting, the journal, export ---------------------------------------------
const pnlCol = await colOf('P&L');
await page.locator('#sec-trades thead th', { hasText: 'P&L' }).click(); await page.waitForTimeout(400);
ok(Math.abs(parseMoney(await cell(0, pnlCol)) - Math.max(...imp.trades.map((t) => t.pnl))) < 0.01, `sorting by P&L puts the best trade first (${await cell(0, pnlCol)})`);
await page.locator('#sec-trades thead th', { hasText: 'P&L' }).click(); await page.waitForTimeout(400);
ok(Math.abs(parseMoney(await cell(0, pnlCol)) - Math.min(...imp.trades.map((t) => t.pnl))) < 0.01, `…and again the worst first (${await cell(0, pnlCol)})`);
for (const c of ['#', 'Symbol', 'Side', 'Entry', 'Exit', 'Lots', 'Pips', 'R', '% equity', 'MAE R', 'MFE R', 'Held', 'Exit by', 'Regime', 'Tags', 'Note']) {
  await page.locator('#sec-trades thead th').nth(await colOf(c)).click(); await page.waitForTimeout(120);
}
ok((await shown()).rows === 160 && !errors.length, 'every column can be sorted without losing a row');
await page.locator('#sec-trades tbody tr').first().click(); await page.waitForTimeout(300);
await page.locator('.modal input').first().fill('zz-check, second tag');
await page.locator('.modal textarea').fill('A note with "quotes", a comma,\nand a second line');
await page.locator('.modal button', { hasText: 'Save journal' }).click(); await page.waitForTimeout(700);
ok(await field('Setup tag').locator('option', { hasText: 'zz-check' }).count() === 1, 'a new journal tag appears in the Setup tag filter');
await setFilter('Setup tag', 'zz-check');
imp = (await stored('imported'))[0];
await compare('imported · the tag just added', recount(imp, (t) => t.tags.includes('zz-check')));
await clearFilters();
const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('button', { hasText: 'Export CSV' }).first().click()]);
const csv = readFileSync(await dl.path(), 'utf8');
// a quoted field may hold commas and line breaks: split on record boundaries only
const recs = []; { let cur = '', q = false; for (const ch of csv) { if (ch === '"') q = !q; if (ch === '\n' && !q) { recs.push(cur); cur = ''; } else cur += ch; } if (cur) recs.push(cur); }
const cols = recs[0].split(',');
const parseRec = (r) => { const out = []; let cur = '', q = false; for (let i = 0; i < r.length; i++) { const ch = r[i]; if (ch === '"') { if (q && r[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const rowsCsv = recs.slice(1).map(parseRec);
ok(rowsCsv.length === 160 && rowsCsv.every((r) => r.length === cols.length), `export: 160 rows, every row has ${cols.length} columns`);
ok(Math.abs(rowsCsv.reduce((a, r) => a + +r[cols.indexOf('pnl')], 0) - imp.trades.reduce((a, t) => a + t.pnl, 0)) < 0.01, 'export: the pnl column adds up to the net result');
ok(rowsCsv.some((r) => r[cols.indexOf('note')] === 'A note with "quotes", a comma,\nand a second line'), 'export: a note with quotes, a comma and a line break survives intact');

// ---- Monte Carlo and the prop-firm simulator -----------------------------------------------
const mcField = (label) => page.locator('#sec-montecarlo label.field', { has: page.locator(`span:text-is("${label}")`) }).locator('select, input');
const mcTiles = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#sec-montecarlo .kpis:not(.small) .kpi')].map((e) => [e.querySelector('span').textContent, e.querySelector('b').dataset.v])));
const mcBad = () => page.evaluate(() => (document.querySelector('#sec-montecarlo').innerText.match(/NaN|undefined|Infinity|\[object/g) ?? []).length);
const pctNum = (s) => +String(s).replace(M, '-').replace(/[^\d.\-]/g, '');
await page.locator('#sec-montecarlo').scrollIntoViewIfNeeded();
const all = recount(imp);
for (const [runs, horizon, skip, extra] of [['1000', '100', '0', '0'], ['100', '10', '50', '5'], ['5000', '2000', '0', '0'], ['', '', '', ''], ['-5', '0', '-1', '-1'], ['abc', '1e9', '999', '1e9'], ['250.7', '33.3', '12.5', '0.25']]) {
  await mcField('Method').selectOption('bootstrap');
  await mcField('Simulations').fill(runs).catch(() => mcField('Simulations').evaluate((e, v) => (e.value = v), runs));
  await mcField('Trades per path').fill(horizon).catch(() => mcField('Trades per path').evaluate((e, v) => (e.value = v), horizon));
  await mcField('Skip trades (%)').fill(skip).catch(() => mcField('Skip trades (%)').evaluate((e, v) => (e.value = v), skip));
  await mcField('Extra cost (units)').fill(extra).catch(() => mcField('Extra cost (units)').evaluate((e, v) => (e.value = v), extra));
  await page.locator('#sec-montecarlo button', { hasText: 'Run simulation' }).click(); await page.waitForTimeout(700);
  const t = await mcTiles();
  const p5 = pctNum(t['Bad case (5th pct)']), p50 = pctNum(t['Median result']), p95 = pctNum(t['Good case (95th pct)']), cp = pctNum(t['Chance of profit']);
  ok((await mcBad()) === 0 && p5 <= p50 && p50 <= p95 && cp >= 0 && cp <= 100 && p5 >= -100, `Monte Carlo with runs "${runs}", trades "${horizon}", skip "${skip}", cost "${extra}": bad ${t['Bad case (5th pct)']} ≤ median ${t['Median result']} ≤ good ${t['Good case (95th pct)']}, chance ${t['Chance of profit']}`);
}
await mcField('Skip trades (%)').fill('0'); await mcField('Extra cost (units)').fill('0');
await mcField('Method').selectOption('shuffle');
await page.locator('#sec-montecarlo button', { hasText: 'Run simulation' }).click(); await page.waitForTimeout(900);
let t = await mcTiles();
ok(t['Median result'] === pct(all.ret, 1, true) && t['Bad case (5th pct)'] === t['Median result'] && t['Good case (95th pct)'] === t['Median result'], `shuffle mode ends every path at the actual result (${t['Median result']} = ${pct(all.ret, 1, true)})`);
ok(pctNum(t['Chance of profit']) === (all.net > 0 ? 100 : 0), `…so the chance of profit is ${t['Chance of profit']}`);
await mcField('Method').selectOption('bootstrap');
await page.locator('#sec-montecarlo button', { hasText: 'Run simulation' }).click(); await page.waitForTimeout(600);

const propTiles = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#sec-montecarlo .kpis.small .kpi')].map((e) => [e.querySelector('span').textContent, e.querySelector('b').dataset.v])));
const nPresets = await mcField('Rules').locator('option').count();
for (let i = 0; i < nPresets; i++) {
  await mcField('Rules').selectOption({ index: i });
  await page.locator('#sec-montecarlo button', { hasText: 'Simulate challenge' }).click(); await page.waitForTimeout(500);
  const p = await propTiles();
  const sum = pctNum(p['Pass']) + pctNum(p['Fail: daily loss']) + pctNum(p['Fail: max loss']) + pctNum(p['Unfinished']);
  ok(Math.abs(sum - 100) <= 2 && (await mcBad()) === 0, `prop-firm rules #${i + 1}: pass ${p['Pass']} + daily ${p['Fail: daily loss']} + max loss ${p['Fail: max loss']} + unfinished ${p['Unfinished']} = ${sum}%`);
}
for (const [target, daily, total, minDays, risk, days] of [['', '', '', '', '', ''], ['0', '0', '0', '0', '0', '0'], ['-3', '-3', '-3', '-3', '-3', '-3'], ['1e9', '1e9', '1e9', '1e9', '1e9', '1e9'], ['abc', 'x', 'y', 'z', 'q', 'w'], ['1', '50', '50', '60', '5', '5']]) {
  const set = async (label, v) => mcField(label).fill(v).catch(() => mcField(label).evaluate((e, x) => (e.value = x), v));
  await set('Profit target %', target); await set('Max daily loss %', daily); await set('Max total loss %', total); await set('Min trading days', minDays); await set('Risk per trade %', risk); await set('Time limit (days)', days);
  await page.locator('#sec-montecarlo button', { hasText: 'Simulate challenge' }).click(); await page.waitForTimeout(500);
  const p = await propTiles();
  const sum = pctNum(p['Pass']) + pctNum(p['Fail: daily loss']) + pctNum(p['Fail: max loss']) + pctNum(p['Unfinished']);
  ok(Math.abs(sum - 100) <= 2 && (await mcBad()) === 0, `prop-firm with fields "${target}/${daily}/${total}/${minDays}/${risk}/${days}": outcomes add up to ${sum}%`);
}

// =========================== 3) all sessions combined =====================================
await page.goto(page.url().replace(/#.*/, '#/analytics/all'));
await page.getByText('Does this method have').first().waitFor({ timeout: 60000 });
await page.waitForTimeout(1200);
const both = await shown();
ok(both.s['Trades'] === String(rep.trades.length + imp.trades.length) && both.bad === 0, `all sessions combined: ${both.s['Trades']} trades = ${imp.trades.length} imported + ${rep.trades.length} replayed`);
const sessCol = await colOf('Session');
const names = new Set(await page.locator('#sec-trades tbody tr').evaluateAll((rows, c) => rows.map((r) => r.children[c].textContent), sessCol));
ok(names.size === 2, `the combined trade log names the session of each trade (${[...names].join(', ')})`);
const symbols = await field('Symbol').locator('option').allInnerTexts();
for (const sym of symbols.filter((x) => x !== 'All')) {
  await setFilter('Symbol', sym);
  const s = await shown();
  const want = [...imp.trades, ...rep.trades].filter((x) => x.symbol === sym).length;
  ok(s.s['Trades'] === String(want), `combined · symbol ${sym}: ${s.s['Trades']} trades`);
}
await clearFilters();
ok(!errors.length, `no console errors${errors.length ? ' — ' + errors.slice(0, 4).join(' | ') : ''}`);
await browser.close();
