// Shared helpers for the browser audits. Run against `npm run preview` (BASE defaults to http://localhost:4173/).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
export const { chromium } = pw;
export const BASE = process.env.BASE ?? 'http://localhost:4173/';

export async function open({ width = 1440, height = 900, phone = false, scheme = 'dark', state = undefined } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, ...(phone ? { hasTouch: true, isMobile: true } : {}), ...(state ? { storageState: state } : {}) });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.addInitScript(() => {
    const m = (window.__ux = { long: [], events: [], cls: 0, frames: [] });
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => m.long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true }); } catch {}
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => m.events.push({ n: e.name, d: Math.round(e.duration) }))).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) m.cls += e.value; })).observe({ type: 'layout-shift', buffered: true }); } catch {}
    let last = 0;
    const tick = (t) => { if (last) m.frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/CERT_|fonts|ERR_/.test(m.text()) && errors.push('console: ' + m.text()));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() || 'x' : undefined));
  return { browser, ctx, page, errors };
}

/** Reset the counters, run `fn`, and return what happened during it. */
export async function measure(page, label, fn, settle = 300) {
  await page.evaluate(() => { const m = window.__ux; m.long = []; m.events = []; m.cls = 0; m.frames = []; });
  await fn();
  await page.waitForTimeout(settle);
  const r = await page.evaluate(() => {
    const m = window.__ux, f = [...m.frames].sort((a, b) => a - b);
    const q = (p) => (f.length ? f[Math.min(f.length - 1, Math.floor(f.length * p))] : 0);
    const total = f.reduce((a, b) => a + b, 0);
    return { fps: f.length ? Math.round((f.length / total) * 1000) : 0, p95: Math.round(q(0.95)), worst: Math.round(f[f.length - 1] ?? 0), slow: f.filter((x) => x > 34).length,
      long: m.long.length, longMax: Math.max(0, ...m.long), inp: Math.max(0, ...m.events.map((e) => e.d)), cls: +m.cls.toFixed(3) };
  });
  console.log(`${label.padEnd(34)} fps ${String(r.fps).padStart(3)} | frame p95 ${String(r.p95).padStart(3)}ms worst ${String(r.worst).padStart(4)}ms (${r.slow} slow) | long tasks ${r.long} (max ${r.longMax}ms) | input ${r.inp}ms | CLS ${r.cls}`);
  return r;
}

/** Demo data + a replay session, ending in the workspace. */
export async function demoSession(page) {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await page.getByRole('button', { name: /New session/ }).first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: /New session/ }).first().click();
  await page.getByRole('button', { name: 'Create & start replay' }).click();
  await page.waitForURL(/#\/replay\//);
  await page.locator('.ws canvas').first().waitFor();
  await page.waitForTimeout(1200);
}

/** Slow the CPU down (default 4×) so the numbers resemble a mid-range phone or an old laptop. */
export async function throttle(page, rate = +(process.env.CPU ?? 4)) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

// ---- shared fixtures -------------------------------------------------------------------

/** A trade list in the FX Replay export layout: `n` XAUUSD trades over about four months. */
export function sampleTradesCsv(n = 160) {
  let s = 'id,dateStart,dateEnd,pair,uPnL,rPnL,side,entryPrice,initialSL,maxTP,idealTP,amount,amountClosed,status,day,tags,avgClosePrice,avgRiskReward,maxRiskReward,exchangeRate,initialBalance,currentRealizedBalance\n';
  let bal = 100000, t = Date.UTC(2026, 4, 4, 8) / 1000, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const p = (x) => String(x).padStart(2, '0');
  const f = (u) => { const d = new Date(u * 1000); return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`; };
  for (let i = 0; i < n; i++) {
    const e = 4000 + rnd() * 400, sl = 6 + rnd() * 6, buy = rnd() < 0.5, win = rnd() < 0.4, r = win ? 1.5 + rnd() * 3 : -1, amt = Math.round(600 / sl);
    const x = buy ? e + r * sl : e - r * sl, pnl = +(r * sl * amt).toFixed(2);
    bal += pnl;
    const d = t + 3600 * (1 + rnd() * 3);
    const maxR = win ? r + rnd() * 0.8 : rnd() * 0.9; // best open profit reached, in R
    s += `${i},${f(t)},${f(d)},XAUUSD,0,${pnl},${buy ? 'buy' : 'sell'},${e.toFixed(3)},${(buy ? e - sl : e + sl).toFixed(3)},,,${amt},${amt},closed,1,${rnd() < 0.5 ? 'breakout' : 'pullback'},${x.toFixed(3)},${r.toFixed(2)},${maxR.toFixed(2)},1,100000,${bal.toFixed(2)}\n`;
    t = d + 3600 * (4 + rnd() * 20);
  }
  return s;
}

/** Import the sample trade list through the UI and land on its analytics page. */
export async function importSample(page, csv = sampleTradesCsv()) {
  await page.goto(BASE);
  await page.getByRole('button', { name: /Import trades/ }).first().click();
  await page.locator('.modal input[type=file]').setInputFiles({ name: 'sample-trades.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('.modal .callout').first().waitFor();
  await page.getByRole('button', { name: 'Import & analyse' }).click();
  await page.getByText('Does this method have').first().waitFor({ timeout: 30000 });
}

/** A run of quick trades in the open replay (keyboard shortcuts), so there is something to analyse. */
export async function quickTrades(page, n = 24) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+S' : 'Shift+B');
    for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+C');
  }
  await page.waitForTimeout(600);
}

/** Read the page top to bottom like a person, twice, and let every entrance finish. */
export async function scrollThrough(page, settle = 2600) {
  for (let pass = 0; pass < 2; pass++) {
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H + 900; y += 600) { await page.evaluate((yy) => scrollTo(0, yy), y); await page.waitForTimeout(pass ? 40 : 110); }
  }
  await page.waitForTimeout(settle);
}

/**
 * Runs inside the page: everything a person would call broken without knowing the code.
 * Returns a list of findings (strings). `o.root` limits it to one element (a modal),
 * `o.touch` adds tap-target sizes.
 */
export function inspectInPage(o = {}) {
  const P = [];
  const root = o.root ? document.querySelector(o.root) : document.body;
  if (!root) return [`inspect: ${o.root} not found`];
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  };
  const name = (el) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.id || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const where = (el.closest('.card')?.querySelector('.card-title span')?.textContent || el.closest('section')?.id || el.closest('.modal') ? 'modal' : '') || '';
    const card = el.closest('.card')?.querySelector('.card-title span')?.textContent?.trim();
    return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}> "${t}"${card ? ` in "${card.slice(0, 30)}"` : where ? ` in ${where}` : ''}`;
  };
  const hiddenBy = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (+cs.opacity < 0.99) return `opacity ${cs.opacity}`;
      if (cs.clipPath && cs.clipPath !== 'none') return `clip-path ${cs.clipPath}`;
    }
    return null;
  };

  // 1) text that should never reach the screen
  const bad = (root.innerText || '').match(/(?<![\w.$])(NaN|undefined|Infinity|\[object Object\])(?![\w])/g);
  if (bad) P.push(`text shows ${[...new Set(bad)].join(', ')}`);

  // 2) the page must not scroll sideways
  if (!o.root && document.documentElement.scrollWidth > window.innerWidth + 1) P.push(`page scrolls sideways (${document.documentElement.scrollWidth} px wide in a ${window.innerWidth} px window)`);

  const cv = document.createElement('canvas').getContext('2d');
  const all = root.querySelectorAll('*');
  for (const el of all) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'OPTION' || el.closest('svg')) continue;
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);

    // 3) text cut off with an ellipsis
    if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1 && tag !== 'INPUT' && tag !== 'SELECT') {
      P.push(`cut off: "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)}" ${name(el)}`);
    }

    // 4) a value that does not fit its field
    if ((tag === 'INPUT' || tag === 'SELECT') && !el.hasAttribute('size')) {
      const type = el.type;
      if (!['checkbox', 'radio', 'file', 'range', 'color', 'hidden', 'date', 'datetime-local', 'time', 'select-multiple'].includes(type)) {
        const txt = tag === 'SELECT' ? (el.selectedOptions[0]?.textContent ?? '') : el.value;
        if (txt) {
          cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const ls = parseFloat(cs.letterSpacing) || 0;
          const tt = cs.textTransform === 'uppercase' ? txt.toUpperCase() : txt;
          const need = cv.measureText(tt).width + ls * tt.length;
          const room = el.clientWidth - parseFloat(cs.paddingLeft) - (tag === 'SELECT' ? Math.max(parseFloat(cs.paddingRight), 20) : parseFloat(cs.paddingRight));
          if (need > room + 1.5) P.push(`value does not fit: "${txt.slice(0, 40)}" needs ${Math.round(need)} px, field has ${Math.round(room)} px ${name(el)}`);
        }
      }
    }

    // 5) button / chip / tab text spilling out of its box
    if ((tag === 'BUTTON' || el.matches('.badge, .chip, .tab, .seg, .pill')) && cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 2) P.push(`label clipped: ${name(el)}`);

    // 6) tap targets on touch screens
    if (o.touch && (tag === 'BUTTON' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'hidden', 'file'].includes(el.type)) || (tag === 'A' && cs.display !== 'inline'))) {
      const r = el.getBoundingClientRect();
      if (r.height < 36 || r.width < 36) P.push(`small tap target ${Math.round(r.width)}×${Math.round(r.height)}: ${name(el)}`);
    }
  }

  // 7) content that is on the page but cannot be seen
  for (const el of root.querySelectorAll('.card, .kpi, .viz, .scard, .stat, .score-hero')) {
    if (!shown(el)) continue;
    const why = hiddenBy(el);
    if (why) P.push(`not visible (${why}): ${name(el)}`);
  }
  for (const v of root.querySelectorAll('.viz')) {
    if (!shown(v)) continue;
    const svg = v.querySelector('svg');
    if (!svg || !svg.querySelector('path, rect, circle, polyline, line')) P.push(`chart is empty: ${name(v)}`);
    else if ([...svg.querySelectorAll('*')].some((e) => e.getAttributeNames().some((a) => /NaN|undefined|Infinity/.test(e.getAttribute(a) ?? '')))) P.push(`chart has NaN in its drawing: ${name(v)}`);
  }
  for (const c of root.querySelectorAll('.card')) {
    if (!shown(c)) continue;
    if (!(c.innerText || '').trim() && !c.querySelector('svg, canvas, input, select, img')) P.push(`empty card: ${name(c)}`);
  }
  for (const e of root.querySelectorAll('.rv-in, .viz-draw')) P.push(`still mid-entrance: ${name(e)}`);
  for (const img of root.querySelectorAll('img')) if (shown(img) && img.complete && !img.naturalWidth) P.push(`broken image: ${name(img)}`);
  return [...new Set(P)];
}
