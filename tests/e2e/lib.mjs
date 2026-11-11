// Shared helpers for the browser audits. Run against `npm run preview` (BASE defaults to http://localhost:4173/).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
export const { chromium } = pw;
export const BASE = process.env.BASE ?? 'http://localhost:4173/';

export async function open({ width = 1440, height = 900, phone = false, scheme = 'dark' } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
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
  page.on('dialog', (d) => d.accept());
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
