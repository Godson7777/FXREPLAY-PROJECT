// A long, human-style backtest in replay mode, driven only by mouse and keyboard.
// Two strategies (continuation breakout, reversal), N trades each, with smoothness
// measured in blocks so a slowdown over a long session shows up.
//   npm run build && npm run preview &
//   node tests/e2e/human-backtest.mjs            (500 trades per strategy)
//   N=50 BLOCK=10 node tests/e2e/human-backtest.mjs
//   CPU=4 slows the CPU 4×; PHONE=1 uses a phone-size touch screen; REC=dir records a video.
import { chromium, BASE, throttle } from './lib.mjs';

const N = +(process.env.N ?? 500);
const BLOCK = +(process.env.BLOCK ?? 50);
const PHONE = !!process.env.PHONE;
const ONLY = process.env.ONLY; // 'breakout' | 'reversal'
const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (page, ms) => page.waitForTimeout(ms);

// ---- a hand on the mouse --------------------------------------------------------------
class Hand {
  constructor(page) { this.page = page; this.x = 700; this.y = 450; this.moves = 0; this.clicks = 0; }
  /** Curved, eased travel with a little wobble, like a wrist. */
  async moveTo(x, y) {
    const { page } = this;
    const dx = x - this.x, dy = y - this.y, dist = Math.hypot(dx, dy);
    const steps = Math.max(4, Math.min(22, Math.round(dist / 45)));
    const bend = rnd(-0.18, 0.18) * dist;
    const cx = this.x + dx / 2 - (dy / (dist || 1)) * bend, cy = this.y + dy / 2 + (dx / (dist || 1)) * bend;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t * t * (3 - 2 * t);
      const px = (1 - e) * (1 - e) * this.x + 2 * (1 - e) * e * cx + e * e * x + (i < steps ? rnd(-1.2, 1.2) : 0);
      const py = (1 - e) * (1 - e) * this.y + 2 * (1 - e) * e * cy + e * e * y + (i < steps ? rnd(-1.2, 1.2) : 0);
      await page.mouse.move(px, py);
      await sleep(page, rnd(5, 11));
    }
    this.x = x; this.y = y; this.moves++;
  }
  async target(sel) {
    const loc = typeof sel === 'string' ? this.page.locator(sel).first() : sel;
    const b = await loc.boundingBox();
    if (!b) throw new Error(`not on screen: ${sel}`);
    return { x: b.x + b.width * rnd(0.3, 0.7), y: b.y + b.height * rnd(0.35, 0.65) };
  }
  async click(sel, hold = rnd(45, 110)) {
    const p = await this.target(sel);
    if (PHONE) { await this.page.touchscreen.tap(p.x, p.y); this.clicks++; return; }
    await this.moveTo(p.x, p.y);
    await sleep(this.page, rnd(30, 90));
    await this.page.mouse.down();
    await sleep(this.page, hold);
    await this.page.mouse.up();
    this.clicks++;
  }
  async type(sel, text) {
    const loc = this.page.locator(sel).first();
    if (PHONE) await loc.tap(); else await this.click(loc);
    await this.page.keyboard.press('Control+A');
    await this.page.keyboard.type(String(text), { delay: rnd(25, 60) });
  }
}

// ---- reading the screen ---------------------------------------------------------------
const LEGEND = /(\d{4}-\d\d-\d\d \d\d:\d\d)\s+O\s*([\d.]+)\s*H\s*([\d.]+)\s*L\s*([\d.]+)\s*C\s*([\d.]+)/;
async function candle(page) {
  const m = LEGEND.exec(await page.locator('.pane-legend').first().innerText());
  return m ? { t: m[1], o: +m[2], h: +m[3], l: +m[4], c: +m[5] } : null;
}
const tabCount = async (page, name) => +(/\((\d+)\)/.exec(await page.locator('.ws .tab', { hasText: name }).first().innerText())?.[1] ?? 0);

// ---- the two strategies: return { side, slPips } or null -------------------------------
const PIP = 0.0001, LOOK = 20, TREND = 50;
function breakout(w) {
  if (w.length < TREND + 1) return null;
  const c = w[w.length - 1], prev = w.slice(-LOOK - 1, -1);
  const hi = Math.max(...prev.map((x) => x.h)), lo = Math.min(...prev.map((x) => x.l));
  const trend = c.c - w[w.length - 1 - TREND].c;
  if (c.c > hi && trend > 0) return { side: 'buy', slPips: (c.c - c.l) / PIP + 2 };
  if (c.c < lo && trend < 0) return { side: 'sell', slPips: (c.h - c.c) / PIP + 2 };
  return null;
}
function reversal(w) {
  if (w.length < LOOK + 1) return null;
  const c = w[w.length - 1], prev = w.slice(-LOOK - 1, -1);
  const hi = Math.max(...prev.map((x) => x.h)), lo = Math.min(...prev.map((x) => x.l));
  const range = c.h - c.l || PIP;
  // a push through the extreme that closes back inside, leaving a long wick
  if (c.h > hi && c.c < hi && (c.h - Math.max(c.o, c.c)) / range > 0.5) return { side: 'sell', slPips: (c.h - c.c) / PIP + 2 };
  if (c.l < lo && c.c > lo && (Math.min(c.o, c.c) - c.l) / range > 0.5) return { side: 'buy', slPips: (c.c - c.l) / PIP + 2 };
  return null;
}

// ---- measuring ------------------------------------------------------------------------
async function sample(page, cdp) {
  const r = await page.evaluate(() => {
    const m = window.__ux, f = [...m.frames].sort((a, b) => a - b), ev = m.events.map((e) => e.d).sort((a, b) => a - b);
    const total = f.reduce((a, b) => a + b, 0), q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
    const out = { fps: f.length ? Math.round((f.length / total) * 1000) : 0, slowPct: f.length ? +((f.filter((x) => x > 34).length / f.length) * 100).toFixed(1) : 0, worst: Math.round(f[f.length - 1] ?? 0),
      long: m.long.length, longMax: Math.max(0, ...m.long), inP95: Math.round(q(ev, 0.95)), inMax: Math.round(ev[ev.length - 1] ?? 0), cls: +m.cls.toFixed(3) };
    out.loaf = m.loaf; m.loaf = [];
    m.long = []; m.events = []; m.cls = 0; m.frames = [];
    return out;
  });
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (n) => metrics.find((x) => x.name === n)?.value ?? 0;
  return { ...r, heapMB: +(get('JSHeapUsedSize') / 1048576).toFixed(1), nodes: get('Nodes') };
}

async function open() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: 'dark', ...(PHONE ? { hasTouch: true, isMobile: true } : {}),
    ...(process.env.REC ? { recordVideo: { dir: process.env.REC, size: PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 } } } : {}),
  });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.addInitScript(() => {
    const m = (window.__ux = { long: [], events: [], cls: 0, frames: [] });
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => m.long.push(Math.round(e.duration)))).observe({ type: 'longtask' }); } catch {}
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => m.events.push({ n: e.name, d: Math.round(e.duration) }))).observe({ type: 'event', durationThreshold: 16 }); } catch {}
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) m.cls += e.value; })).observe({ type: 'layout-shift' }); } catch {}
    // which script made a frame long (Long Animation Frames API), for LOAF=1 runs
    m.loaf = [];
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (e.duration > 50) m.loaf.push({ d: Math.round(e.duration), b: Math.round(e.blockingDuration), s: (e.scripts || []).map((x) => [x.invoker || x.name, x.sourceFunctionName || '', Math.round(x.duration), Math.round(x.forcedStyleAndLayoutDuration || 0)]) }); })).observe({ type: 'long-animation-frame' }); } catch {}
    let last = 0;
    const tick = (t) => { if (last) m.frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    // a dot that follows the pointer, so a recording shows the hand
    addEventListener('DOMContentLoaded', () => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;z-index:99999;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(57,219,127,.55);border:1.5px solid #fff;pointer-events:none;left:-50px;top:-50px';
      document.documentElement.append(d);
      addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/CERT_|fonts|ERR_/.test(m.text()) && errors.push('console: ' + m.text()));
  page.on('dialog', (d) => d.accept());
  if (process.env.DEBUG) page.on('console', (m) => /PAUSE/.test(m.text()) && console.log('  ' + m.text().split('\n').slice(1, 5).join(' <- ').replace(/https?:\S+\//g, '').slice(0, 300)));
  return { browser, ctx, page, errors };
}

async function run(strategy, symbolIndex, rr) {
  const { browser, ctx, page, errors } = await open();
  const hand = new Hand(page);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const rule = strategy === 'breakout' ? breakout : reversal;
  console.log(`\n== ${strategy} · target ${N} trades · ${PHONE ? 'phone 390×844 touch' : 'desktop 1440×900'}${process.env.CPU ? ` · CPU ${process.env.CPU}× slower` : ''} ==`);

  // set up like a new user: demo data, a session on one symbol, 5-minute chart
  await page.goto(BASE);
  if (await page.getByRole('button', { name: 'Load demo data' }).count()) await hand.click(page.getByRole('button', { name: 'Load demo data' }));
  await page.getByRole('button', { name: /New session/ }).first().waitFor({ timeout: 90000 });
  await hand.click(page.getByRole('button', { name: /New session/ }).first());
  await page.locator('.modal .sym-list').waitFor();
  if (symbolIndex > 0) { await page.locator('.modal .sym-list input').nth(0).uncheck(); await page.locator('.modal .sym-list input').nth(symbolIndex).check(); }
  await page.locator('.modal input').first().fill(`${strategy} · human backtest`);
  await hand.click(page.getByRole('button', { name: 'Create & start replay' }));
  await page.waitForURL(/#\/replay\//);
  await page.locator('.ws canvas').first().waitFor();
  await sleep(page, 800);
  if (process.env.CPU) await throttle(page, +process.env.CPU);
  if (PHONE) { await hand.click('.trade-bar .tb-order'); await sleep(page, 500); }
  await hand.click(page.locator(PHONE ? '.sheet .chip' : '.ws .chip', { hasText: /^5m$/ }).first());
  await hand.type('#tSize', '0.5');
  await hand.type('#tTp', rr);
  if (PHONE) { await hand.click('.sheet-head button'); await sleep(page, 400); }
  else await page.locator('select[title="Playback speed"]').selectOption('20');
  await hand.click(page.locator('.ws .tab', { hasText: 'Positions' }).first());

  const w = [];
  const stats = { trades: 0, lost: 0, rejected: 0, manual: 0, steps: 0, clicksStep: 0 };
  const blocks = [];
  let lastT = '', done = false, blockStart = Date.now();
  await sample(page, cdp); // reset the counters

  const step = async () => {
    // mostly the → key; now and then the "next candle" button, as people do
    if (!PHONE && Math.random() < 0.08) { await hand.click('.ws .controls .ctl >> nth=0'); stats.clicksStep++; }
    else if (PHONE) await hand.click('.ws .controls .ctl >> nth=0');
    else { await page.keyboard.press('ArrowRight'); await sleep(page, rnd(18, 45)); }
    stats.steps++;
    for (let i = 0; i < 40; i++) {
      const c = await candle(page);
      if (c && c.t !== lastT) { lastT = c.t; w.push(c); if (w.length > 120) w.shift(); return true; }
      if (await page.locator('.modal-back').count()) return false;
      await sleep(page, 15);
    }
    return false;
  };

  while (stats.trades < N && !done) {
    if (!(await step())) { done = true; break; }
    const sig = rule(w);
    if (!sig || sig.slPips < 4 || sig.slPips > 60) continue;
    // a setup: set the stop, then press BUY or SELL
    const before = await tabCount(page, 'Positions');
    if (PHONE) { await hand.click('.trade-bar .tb-order'); await sleep(page, 450); }
    await hand.type('#tSl', sig.slPips.toFixed(1));
    await hand.click(PHONE ? `.sheet .quote button.${sig.side}` : `.ws .quote button.${sig.side}`);
    let opened = false;
    for (let i = 0; i < 40 && !opened; i++) { await sleep(page, 25); opened = (await tabCount(page, 'Positions')) > before; }
    if (!opened) {
      const toastText = await page.locator('#toasts .toast.err').last().innerText().catch(() => '');
      if (toastText) { stats.rejected++; if (stats.rejected <= 3) console.log('  rejected:', toastText); } else { stats.lost++; console.log('  LOST CLICK at trade', stats.trades + 1); }
      if (PHONE && (await page.locator('.sheet.open').count())) await hand.click('.sheet-head button');
      continue;
    }
    // let the market run until the stop or the target closes it
    const closed0 = await tabCount(page, 'History');
    await hand.click(PHONE ? '.trade-bar .tb-play' : '.ws .controls .play');
    let closed = false;
    for (let i = 0; i < 700 && !closed; i++) {
      await sleep(page, 60);
      closed = (await tabCount(page, 'History')) > closed0;
      if (!closed && i % 40 === 20 && !PHONE) await hand.moveTo(rnd(200, 900), rnd(680, 860)); // idle hand
      if (await page.locator('.modal-back').count()) { done = true; break; }
    }
    if (!closed && !done) {
      if (process.env.DEBUG) { await page.screenshot({ path: process.env.DEBUG + '/dbg-open.png' }); console.log('  dbg tabs:', (await page.locator('.ws .tabs').innerText()).replace(/\n/g, ' '), '| toasts:', await page.locator('#toasts').innerText().catch(() => '')); }
      // still open after a long run: pause and close it by hand
      await hand.click(PHONE ? '.trade-bar .tb-play' : '.ws .controls .play');
      await hand.click('.ws .tbl .mini.danger');
      stats.manual++;
    }
    await sleep(page, 150);
    if (await page.locator(PHONE ? '.trade-bar .tb-play' : '.ws .controls .play.on').count() && !PHONE) await hand.click('.ws .controls .play');
    stats.trades++;
    // what people do between trades
    if (!PHONE && stats.trades % 7 === 0) {
      const b = await page.locator('.ws .pane canvas').first().boundingBox();
      await hand.moveTo(b.x + b.width * 0.6, b.y + b.height * 0.5);
      await page.mouse.down();
      for (let i = 0; i < 14; i++) { await page.mouse.move(b.x + b.width * 0.6 - i * 14, b.y + b.height * 0.5 + Math.sin(i / 3) * 10); await sleep(page, 12); }
      await page.mouse.up();
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, i < 3 ? 100 : -100); await sleep(page, 30); }
      hand.x = b.x + b.width * 0.6 - 13 * 14; hand.y = b.y + b.height * 0.5;
      await hand.moveTo(rnd(300, 800), rnd(700, 850));
    }
    if (!PHONE && stats.trades % 11 === 0) { await hand.click(page.locator('.ws .tab', { hasText: 'History' }).first()); await sleep(page, rnd(300, 600)); await hand.click(page.locator('.ws .tab', { hasText: 'Positions' }).first()); }
    lastT = ''; // the legend moved on while playing: read the current candle again
    const c = await candle(page);
    if (c) { lastT = c.t; w.push(c); }

    if (stats.trades % BLOCK === 0) {
      const s = await sample(page, cdp);
      const secs = Math.round((Date.now() - blockStart) / 1000);
      blockStart = Date.now();
      blocks.push({ upTo: stats.trades, ...s, secs });
      if (process.env.LOAF && s.loaf.length) {
        const agg = new Map();
        for (const f of s.loaf) {
          if (!f.s.length) { const k = '(no script: rendering)'; const a = agg.get(k) ?? [0, 0, 0]; a[0]++; a[1] += f.d; agg.set(k, a); }
          for (const [inv, fn, d, lay] of f.s) { const k = `${inv} ${fn}`; const a = agg.get(k) ?? [0, 0, 0]; a[0]++; a[1] += d; a[2] += lay; agg.set(k, a); }
        }
        console.log(`  long frames ${s.loaf.length} (max ${Math.max(...s.loaf.map((f) => f.d))}ms): ` + [...agg].sort((a, b) => b[1][1] - a[1][1]).slice(0, 6).map(([k, v]) => `${k} ×${v[0]} ${v[1]}ms${v[2] ? ` (layout ${v[2]}ms)` : ''}`).join(' · '));
      }
      console.log(`trades ${String(stats.trades - BLOCK + 1).padStart(4)}–${String(stats.trades).padEnd(4)} | fps ${String(s.fps).padStart(3)} | slow frames ${String(s.slowPct).padStart(4)}% (worst ${String(s.worst).padStart(4)}ms) | long tasks ${String(s.long).padStart(3)} (max ${String(s.longMax).padStart(3)}ms) | input p95 ${String(s.inP95).padStart(3)}ms max ${String(s.inMax).padStart(3)}ms | heap ${String(s.heapMB).padStart(6)}MB | DOM ${String(s.nodes).padStart(6)} | ${secs}s`);
    }
  }

  // open the report the way a user would
  const t0 = Date.now();
  if (await page.locator('.modal-back').count()) await page.keyboard.press('Escape');
  if (PHONE) await page.locator('.ws .topbar .primary').scrollIntoViewIfNeeded();
  await hand.click(page.locator('.ws .topbar .primary'));
  await page.getByText('Does this method have').first().waitFor({ timeout: 120000 });
  const analyticsMs = Date.now() - t0;
  await sleep(page, 2500);
  const score = (await page.locator('.score-num').first().innerText()).replace(/\s+/g, '');
  const tier = (await page.locator('.score-tier').first().innerText()).replace(/\s+/g, ' ');
  await page.locator('.kpis').first().scrollIntoViewIfNeeded(); await sleep(page, 1800);
  const kpis = (await page.locator('.kpis').first().innerText().catch(() => '')).replace(/\n+/g, ' | ');
  if (process.env.SHOT) { await page.evaluate(() => scrollTo(0, 0)); await sleep(page, 400); await page.screenshot({ path: `${process.env.SHOT}/human-${strategy}${PHONE ? '-phone' : ''}.png`, fullPage: false }); }
  const first = blocks[0], last = blocks[blocks.length - 1];
  console.log(`-- ${strategy}: ${stats.trades} trades, ${stats.steps} candle steps, ${hand.clicks} clicks, ${hand.moves} cursor moves${done && stats.trades < N ? ' (stopped: end of data)' : ''}`);
  console.log(`   lost clicks ${stats.lost} · orders rejected ${stats.rejected} · closed by hand ${stats.manual} · analytics opened in ${analyticsMs} ms · score ${score} ${tier}`);
  console.log(`   ${kpis}`);
  if (first && last && first !== last) console.log(`   first block vs last: fps ${first.fps} → ${last.fps}, input p95 ${first.inP95} → ${last.inP95} ms, heap ${first.heapMB} → ${last.heapMB} MB, DOM ${first.nodes} → ${last.nodes}`);
  console.log('   errors:', errors.length ? errors.slice(0, 5) : 'none');
  if (stats.lost || errors.length) process.exitCode = 1;
  await ctx.close();
  await browser.close();
}

if (!ONLY || ONLY === 'breakout') await run('breakout', 0, '2');
if (!ONLY || ONLY === 'reversal') await run('reversal', 1, '1.5');
