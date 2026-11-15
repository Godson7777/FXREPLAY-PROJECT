// Nothing a trader does should lose their work: backup and restore, deleting and duplicating,
// two tabs on the same session, candle files in odd layouts, damaged settings.
//   npm run build && npm run preview &   then   node tests/e2e/data-safety.mjs
import { readFileSync } from 'node:fs';
import { open, demoSession, quickTrades, BASE } from './lib.mjs';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { browser, ctx, page, errors } = await open();
await ctx.addInitScript(() => { try { localStorage.setItem('overflowtrade.debug', '1'); } catch {} });

const idbAll = (pg, store, keys = false) => pg.evaluate(([st, k]) => new Promise((res, rej) => {
  const q = indexedDB.open('overflowtrade');
  q.onerror = () => rej(q.error);
  q.onsuccess = () => { const os = q.result.transaction(st).objectStore(st); const g = k ? os.getAllKeys() : os.getAll(); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); };
}), [store, keys]);
const sessions = async (pg = page) => (await idbAll(pg, 'sessions')).sort((a, b) => a.createdAt - b.createdAt);
const toast = async (pg = page) => (await pg.locator('#toasts .toast').last().innerText().catch(() => '')).trim();
const home = async (pg = page) => { await pg.goto(BASE + '#/'); await pg.locator('.scard, .empty-state').first().waitFor(); await pg.waitForTimeout(400); };
const restore = async (name, text) => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restore', exact: true }).click()]);
  await fc.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.waitForTimeout(900);
};
const settle = (pg = page) => pg.waitForTimeout(1500);

// ---- a session with trades, a drawing and a journal entry ----------------------------------
await demoSession(page);
await page.locator('#tSl').click(); await page.keyboard.press('Control+A'); await page.keyboard.type('8'); await page.locator('.ws .tab').first().click();
await quickTrades(page, 8);
const box = await page.locator('.ws .pane-chart').first().boundingBox();
await page.keyboard.press('Alt+H'); await page.mouse.click(box.x + 300, box.y + 200); await page.waitForTimeout(200);
await page.locator('.ws .tab', { hasText: 'History' }).click(); await page.waitForTimeout(200);
await page.locator('.ws .tbl button', { hasText: 'Journal' }).first().click(); await page.waitForTimeout(250);
await page.locator('.modal input').first().fill('setup-a, london');
await page.locator('.modal textarea').fill('Entered on the retest.');
await page.locator('.modal button', { hasText: /^Save$/ }).click();
await settle();
const before = (await sessions())[0];
const sym = before.symbols[0];
ok(before.state.broker.trades.length === 8 && before.state.drawings[sym]?.length === 1 && before.state.broker.trades.some((t) => t.note === 'Entered on the retest.'), `session ready: 8 trades, 1 drawing, a journal note (${before.name})`);
const shotsBefore = (await idbAll(page, 'shots', true)).sort();

// ---- backup → delete → restore --------------------------------------------------------------
await home();
await page.waitForTimeout(1500); // the Sessions page tags each trade with its market regime (derived data)
const snap = (await sessions())[0];
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Backup', exact: true }).click()]);
const backupText = readFileSync(await dl.path(), 'utf8');
const backup = JSON.parse(backupText);
ok(backup.sessions.length === 1 && backup.sessions[0].state.broker.trades.length === 8 && Object.keys(backup.shots).length === shotsBefore.length, `backup file: 1 session, 8 trades, ${Object.keys(backup.shots).length} screenshots`);
await page.locator('.scard .link.danger', { hasText: 'Delete' }).click(); await page.waitForTimeout(700);
ok((await sessions()).length === 0 && (await idbAll(page, 'shots', true)).length === 0, 'deleting the session removes it and its screenshots');
await restore('backup.json', backupText);
let after = (await sessions())[0];
const diff = (a, b, path = '', out = []) => { if (out.length > 6) return out; if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path + '.' + k, out); } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 40)} → ${JSON.stringify(b)?.slice(0, 40)}`); return out; };
const d0 = diff(snap, after);
ok(d0.length === 0, `restore brings the session back exactly as it was (trades, drawing, journal, clock, layout)${d0.length ? ' — ' + d0.join(' | ') : ''}`);
ok(JSON.stringify((await idbAll(page, 'shots', true)).sort()) === JSON.stringify(shotsBefore), 'the journal screenshots are back too');
await page.locator('.scard button', { hasText: 'Continue' }).click();
await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1200);
const live = await page.evaluate(() => { const w = window.__ot; return { trades: w.replay.broker.s.trades.length, balance: w.replay.broker.s.balance, clock: w.replay.clock, drawings: (w.session.state.drawings[w.active.cfg.symbol] ?? []).length }; });
ok(live.trades === 8 && live.balance === before.state.broker.balance && live.clock === before.state.clock && live.drawings === 1, 'the restored session opens where it was left');

// ---- an old backup must not silently wipe newer work ------------------------------------------
await page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await page.keyboard.press('Escape');
await quickTrades(page, 3); await settle();
await home();
ok((await sessions())[0].state.broker.trades.length === 11, 'three more trades taken after the backup (11 now)');
page.removeAllListeners('dialog');
let asked = '';
page.on('dialog', (d) => { asked = d.message(); void d.dismiss(); });
await restore('backup.json', backupText);
ok(/older than the copy on this device/.test(asked) && /8 trades in the backup, 11 on this device/.test(asked), 'restoring the old backup asks first, and says which copy has what');
ok((await sessions())[0].state.broker.trades.length === 11, `choosing Cancel keeps the newer session — "${(await toast()).slice(0, 70)}"`);
page.removeAllListeners('dialog');
page.on('dialog', (d) => void d.accept());
await restore('backup.json', backupText);
ok((await sessions())[0].state.broker.trades.length === 8, 'choosing OK goes back to the backup copy (8 trades)');

// ---- files that are not a good backup -----------------------------------------------------------
await restore('notes.json', 'this is not json at all');
ok(/JSON|Unexpected|not valid/i.test(await toast()) && (await sessions()).length === 1, `a file that is not JSON is refused: "${(await toast()).slice(0, 60)}"`);
await restore('other.json', JSON.stringify({ app: 'something-else', sessions: [] }));
ok(/Not an Overflow Trade backup/.test(await toast()), 'a JSON file from somewhere else is refused');
const damaged = { ...backup, sessions: [{ id: 'broken-1', name: 'Broken' }, { ...backup.sessions[0], id: 'copy-2', name: 'Good copy' }, null, { id: 'broken-3', name: 'No trades list', symbols: ['EURUSD'], balance: 1000, start: 1, state: { updatedAt: 1, clock: 1, broker: { balance: 1000 } } }] };
await restore('damaged.json', JSON.stringify(damaged));
const names = (await sessions()).map((s) => s.name).sort();
ok(names.includes('Good copy') && !names.includes('Broken') && !names.includes('No trades list'), `a backup with damaged entries restores the good ones only — "${(await toast()).slice(0, 80)}"`);
await home();
ok((await page.locator('.scard').count()) === 2 && !(await page.getByText('Something went wrong').count()), 'the Sessions page still opens after that');
await page.goto(BASE + '#/analytics/all'); await page.getByText('Does this method have').first().waitFor({ timeout: 30000 });
ok(!(await page.getByText('Something went wrong').count()), '…and so does Analytics');

// ---- duplicate ------------------------------------------------------------------------------
await home();
await page.locator('.scard', { hasText: 'Good copy' }).locator('.link', { hasText: 'Duplicate' }).click(); await page.waitForTimeout(700);
const all3 = await sessions();
const dup = all3.find((s) => /\(copy\)/.test(s.name));
ok(!!dup && dup.state.broker.trades.length === 0 && dup.balance === before.balance && dup.state.broker.balance === before.balance && all3.find((s) => s.name === 'Good copy').state.broker.trades.length === 8, 'Duplicate makes a fresh session with the same settings and leaves the original alone');

// ---- two tabs on one session ------------------------------------------------------------------
const sid = (await sessions()).find((s) => s.id === before.id).id;
await page.goto(BASE + `#/replay/${sid}`); await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1200);
const tabB = await ctx.newPage();
tabB.on('dialog', (d) => void d.accept());
await tabB.goto(BASE + `#/analytics/${sid}`); await tabB.getByText('Does this method have').first().waitFor({ timeout: 30000 });
await tabB.locator('#sec-trades tbody tr').first().click(); await tabB.waitForTimeout(300);
await tabB.locator('.modal input').first().fill('from-analytics');
await tabB.locator('.modal button', { hasText: 'Save journal' }).click(); await tabB.waitForTimeout(700);
const tagged = async () => (await sessions()).find((s) => s.id === sid).state.broker.trades.filter((t) => t.tags.includes('from-analytics')).length;
ok((await tagged()) === 1, 'tab B (Analytics) saves a journal tag');
// tab A still holds the session as it was before that tag; it now moves on and saves
await page.bringToFront();
await page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await page.keyboard.press('Escape');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await settle();
ok((await tagged()) === 1, 'tab A (replay) steps on and saves — the tag from Analytics is still there');
// tab A closes without having changed anything since: it must not write its old copy back
await tabB.locator('#sec-trades tbody tr').nth(1).click(); await tabB.waitForTimeout(300);
await tabB.locator('.modal input').first().fill('from-analytics');
await tabB.locator('.modal button', { hasText: 'Save journal' }).click(); await tabB.waitForTimeout(700);
await page.reload(); await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1000);
ok((await tagged()) === 2, 'reloading an idle replay tab does not undo journal work saved meanwhile');
await tabB.close();

// the same replay in two tabs: the tab that fell behind must not overwrite the other
const tabC = await ctx.newPage();
await tabC.goto(BASE + `#/replay/${sid}`); await tabC.locator('.ws canvas').first().waitFor(); await tabC.waitForTimeout(1200);
await tabC.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await tabC.keyboard.press('Escape');
await quickTrades(tabC, 2); await tabC.waitForTimeout(1500);
const nC = (await sessions()).find((s) => s.id === sid).state.broker.trades.length;
ok(nC === 10, `tab C takes two more trades (${nC} stored)`);
await page.bringToFront();
await page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await page.keyboard.press('Escape');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+B'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+C'); await settle();
const stored = (await sessions()).find((s) => s.id === sid);
ok(stored.state.broker.trades.length === 10, `tab A, still on the old state, trades too — the stored session keeps tab C's ${stored.state.broker.trades.length} trades`);
ok(await page.locator('.conflict-card').isVisible(), `tab A says why it stopped saving: "${(await page.locator('.conflict-card h3').innerText().catch(() => '')).slice(0, 60)}"`);
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await settle();
ok((await sessions()).find((s) => s.id === sid).state.broker.trades.length === 10, '…and keeps its hands off after that');
await page.locator('.conflict-card button', { hasText: 'Reload' }).click();
await page.locator('.ws canvas').first().waitFor(); await page.waitForTimeout(1200);
ok((await page.evaluate(() => window.__ot.replay.broker.s.trades.length)) === 10 && !(await page.locator('.conflict-card').count()), 'after the reload tab A has the newest state and saves again');
await page.locator('.ws .pane-chart').first().click({ position: { x: 300, y: 200 } }); await page.keyboard.press('Escape');
await tabC.close();
await page.keyboard.press('ArrowRight'); await settle();
ok(!(await page.locator('.conflict-card').count()), 'a single tab never sees the warning');
// a session deleted elsewhere
const tabD = await ctx.newPage();
tabD.on('dialog', (d) => void d.accept());
await home(tabD);
await tabD.locator('.scard', { hasText: before.name }).locator('.link.danger').click(); await tabD.waitForTimeout(700);
await tabD.close();
await page.keyboard.press('ArrowRight'); await settle();
ok(!(await sessions()).some((s) => s.id === sid) && /deleted/i.test(await page.locator('.conflict-card h3').innerText().catch(() => '')), 'a session deleted in another tab is not brought back by the open replay');

// ---- candle files through the Data page -------------------------------------------------------
const T = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const metas = async () => Object.fromEntries((await idbAll(page, 'meta')).map((m) => [m.id, m]));
const importCsv = async (files, { symbol = '', merge = true } = {}) => {
  await page.goto(BASE + '#/data'); await page.getByRole('button', { name: 'Import CSV' }).first().waitFor();
  await page.getByRole('button', { name: 'Import CSV' }).first().click();
  await page.locator('.modal input[type=file]').setInputFiles(files.map(([name, text]) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })));
  if (symbol) await page.locator('.modal input[placeholder^="e.g. EURUSD"]').fill(symbol);
  if (!merge) await page.locator('.modal input[type=checkbox]').uncheck();
  await page.locator('.modal button', { hasText: /^Import$/ }).click();
  await page.waitForTimeout(900);
  const open = await page.locator('.modal').count();
  const t = await toast();
  if (open) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  return { open: !!open, toast: t };
};
const minute = (n, t0, fmt) => Array.from({ length: n }, (_, i) => fmt(t0 + i * 60, 1.1 + i * 0.0001)).join('\n');
const iso7 = (t) => new Date((t + 7 * 3600) * 1000).toISOString().slice(0, 19) + '+07:00';
let r = await importCsv([['TVJKT.csv', 'time,open,high,low,close\n' + minute(30, T(2024, 1, 2), (t, p) => `${iso7(t)},${p},${p + 0.0002},${p - 0.0002},${p + 0.0001}`)]]);
let m = await metas();
ok(!r.open && m.TVJKT?.count === 30 && m.TVJKT.from === T(2024, 1, 2), `a TradingView export in Jakarta time lands on the right UTC minute (from ${new Date((m.TVJKT?.from ?? 0) * 1000).toISOString()})`);
const dmy = (t) => { const d = new Date(t * 1000), p = (x) => String(x).padStart(2, '0'); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()};${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
r = await importCsv([['euro.csv', 'Date;Time;Open;High;Low;Close;Volume\n' + minute(30, T(2024, 1, 2), (t, p) => `${dmy(t)};${String(p.toFixed(5)).replace('.', ',')};${String((p + 0.0002).toFixed(5)).replace('.', ',')};${String((p - 0.0002).toFixed(5)).replace('.', ',')};${String((p + 0.0001).toFixed(5)).replace('.', ',')};5`)]], { symbol: 'EUROFMT' });
m = await metas();
ok(!r.open && m.EUROFMT?.count === 30 && m.EUROFMT.from === T(2024, 1, 2), 'a semicolon file with decimal commas imports (30 bars)');
const mt = (t) => { const d = new Date(t * 1000), p = (x) => String(x).padStart(2, '0'); return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())},${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const part = (t0) => minute(20, t0, (t, p) => `${mt(t)},${p},${p + 0.0002},${p - 0.0002},${p + 0.0001},3`);
r = await importCsv([['PARTS_1.csv', part(T(2024, 1, 2))], ['PARTS_2.csv', part(T(2024, 1, 3))]], { merge: false });
m = await metas();
ok(!r.open && m.PARTS?.count === 40, `two files for one symbol with "Merge" off still give the whole history (${m.PARTS?.count} bars)`);
r = await importCsv([['EMPTYFILE.csv', '']]);
ok(r.open && /empty/i.test(r.toast) && !(await metas()).EMPTYFILE, `an empty file is refused and the dialog stays open: "${r.toast.slice(0, 60)}"`);
r = await importCsv([['WORDS.csv', 'name,email\nann,ann@example.com\nbob,bob@example.com']]);
ok(r.open && !(await metas()).WORDS, `a file that is not candles is refused: "${r.toast.slice(0, 70)}"`);
r = await importCsv([['!!!.csv', part(T(2024, 1, 2))]]);
ok(r.open && /symbol/i.test(r.toast) && !(await metas())[''], `a file name that gives no symbol asks for one: "${r.toast.slice(0, 60)}"`);
r = await importCsv([['GOODONE.csv', part(T(2024, 1, 2))], ['BADONE.csv', 'nonsense']]);
m = await metas();
ok(r.open && m.GOODONE?.count === 20 && /BADONE/.test(r.toast), `one bad file in a batch names itself; the good one is kept: "${r.toast.slice(0, 70)}"`);

// ---- instrument settings that would break the maths ---------------------------------------------
await page.goto(BASE + '#/data'); await page.locator('.data-tbl tbody tr').first().waitFor();
const rowOf = (s) => page.locator('.data-tbl tbody tr', { has: page.locator(`b:text-is("${s}")`) });
const pipBefore = (await metas()).PARTS.spec.pipSize;
for (const bad of ['0', '-1', '']) {
  const inp = rowOf('PARTS').locator('input').first();
  await inp.fill(bad); await inp.dispatchEvent('change'); await page.waitForTimeout(350);
  ok((await metas()).PARTS.spec.pipSize === pipBefore && /above zero/.test(await toast()), `a pip size of "${bad}" is refused and the old value kept`);
}
const dgIn = rowOf('PARTS').locator('input').nth(2);
await dgIn.fill('2.5'); await dgIn.dispatchEvent('change'); await page.waitForTimeout(350);
ok(Number.isInteger((await metas()).PARTS.spec.digits), 'digits must be a whole number');

// ---- a session whose market data is gone --------------------------------------------------------
const left = (await sessions()).find((s) => !s.imported && s.state.broker.trades.length > 0) ?? (await sessions())[0];
const dataSym = left.symbols[0];
await rowOf(dataSym).locator('button.danger').click(); await page.waitForTimeout(700);
await page.goto(BASE + `#/replay/${left.id}`); await page.waitForTimeout(1500);
const msg = await page.locator('.empty-state').innerText().catch(() => '');
ok(/Missing data for/.test(msg), `opening a session whose data was deleted explains it: "${msg.replace(/\s+/g, ' ').slice(0, 80)}"`);
await home();
ok((await page.locator('.scard').count()) >= 1 && (await sessions()).some((s) => s.id === left.id), 'the session and its trades are still there');
await page.goto(BASE + `#/analytics/${left.id}`); await page.waitForTimeout(2500);
ok(!(await page.getByText('Something went wrong').count()) && (await page.locator('#sec-performance .kpi').count()) > 0, 'its Analytics still opens without the market data');

// ---- damaged browser settings -----------------------------------------------------------------
await page.evaluate(() => { for (const k of ['overflowtrade.prefs', 'overflowtrade.theme', 'overflowtrade.cloud', 'overflowtrade.author', 'overflowtrade.twelvedata.key']) localStorage.setItem(k, '{"broken":'); });
const errs0 = errors.length;
for (const hash of ['#/', '#/data', '#/strategies', '#/leaderboard', '#/analytics/all', '#/methodology']) { await page.goto(BASE + hash); await page.waitForTimeout(900); }
ok(errors.length === errs0 && !(await page.getByText('Something went wrong').count()), `every page opens with damaged saved settings${errors.length > errs0 ? ' — ' + errors.slice(errs0, errs0 + 3).join(' | ') : ''}`);
await page.evaluate(() => { localStorage.setItem('overflowtrade.prefs', JSON.stringify({ speed: 'fast', unit: 7, bottomH: -500, sideW: 'wide', toolsOpen: 'yes', autoShot: null })); });
await page.evaluate(() => localStorage.removeItem('overflowtrade.theme'));
await page.goto(BASE + '#/'); await page.waitForTimeout(600);
ok(errors.length === errs0, `no console errors${errors.length > errs0 ? ' — ' + errors.slice(errs0, errs0 + 3).join(' | ') : ''}`);
ok(!errors.length, `no console errors in the whole run${errors.length ? ' — ' + errors.slice(0, 4).join(' | ') : ''}`);
await browser.close();
