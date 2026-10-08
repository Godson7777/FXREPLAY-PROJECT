import { describe, expect, it } from 'vitest';
import { buildRecords } from '../src/analytics/records';
import { buildReport, type Report } from '../src/analytics/report';
import { allWeatherCheck } from '../src/analytics/score';
import { badges, eligibility, RANK_MIN_DAYS, RANK_MIN_TRADES } from '../src/analytics/service';
import { sanitizeStrategy, strategySessions, type Strategy } from '../src/data/strategies';
import { newSession, type Session } from '../src/engine/replay';
import type { Trade } from '../src/engine/broker';
import type { DatasetMeta } from '../src/core/types';
import { offsetFn } from '../src/core/tz';
import { rng } from '../src/data/synthetic';
import type { Trend, Vol } from '../src/analytics/regime';

const DAY = 86400;
const T0 = Date.UTC(2024, 0, 1) / 1000;
const spec = { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 };

function session(rs: number[], opts: { id?: string; trend?: (i: number) => Trend; perDay?: number } = {}): Session {
  const s = newSession({
    id: opts.id ?? 's1', name: 'Test', description: '', symbols: ['EURUSD'], start: T0, end: null, balance: 10000,
    commissionPerLot: 0, spreadPips: { '*': 0 }, slFirst: true, timezone: 'UTC', riskPct: 1, createdAt: 0, specs: { EURUSD: spec },
  });
  let bal = s.balance, day = 0;
  const perDay = opts.perDay ?? 1;
  rs.forEach((r, i) => {
    if (i % perDay === 0) {
      day++;
      while ([0, 6].includes(new Date((T0 + day * DAY) * 1000).getUTCDay())) day++;
    }
    const entryTime = T0 + day * DAY + 8 * 3600 + (i % perDay) * 3600;
    const risk = bal * 0.01, pnl = r * risk;
    bal += pnl;
    const t: Trade = {
      id: i + 1, symbol: 'EURUSD', side: i % 2 ? 'short' : 'long', lots: 1, entry: 1.1, exit: 1.1, entryTime, exitTime: entryTime + 1800,
      gross: pnl, commission: 0, pnl, pips: r * 10, risk, r, maePips: 5, mfePips: 10, maeR: 0.5, mfeR: Math.max(0, r) + 0.2,
      holdSec: 1800, exitReason: r > 0 ? 'tp' : 'sl', orderType: 'market', tags: [], note: '', balanceAfter: bal,
      regime: { trend: opts.trend?.(i) ?? (['up', 'down', 'range'] as Trend[])[i % 3], vol: (['low', 'normal', 'high'] as Vol[])[Math.floor(i / 3) % 3], adx: 25, atrPct: 0.001 },
    };
    s.state.broker.trades.push(t);
  });
  s.state.broker.balance = bal;
  return s;
}
const meta = (source: DatasetMeta['source'] = 'csv') => new Map<string, DatasetMeta>([['EURUSD', { id: 'EURUSD', symbol: 'EURUSD', source, resolution: 60, from: 0, to: 0, count: 0, spec, createdAt: 0 }]]);
const edge = (n: number, seed = 3, win = 0.5, w = 2) => { const r = rng(seed); return Array.from({ length: n }, () => (r() < win ? w : -1)); };
const report = (s: Session, source: DatasetMeta['source'] = 'csv') => buildReport(buildRecords([s], meta(source)), { initial: 10000, off: offsetFn('UTC') })!;
const strat = (o: Partial<Strategy> = {}): Strategy => ({ id: 'st', name: 'S', author: 'A', timeframe: '', description: '', sessionIds: ['s1'], published: true, createdAt: 1, updatedAt: 1, ...o });

describe('leaderboard eligibility', () => {
  it('ranks a published, long, real-data strategy', () => {
    const r = report(session(edge(300)));
    const e = eligibility(strat(), r);
    expect(e.ranked).toBe(true);
    expect(e.reasons).toEqual([]);
    expect(e.trades).toBe(300);
    expect(e.days).toBeGreaterThan(RANK_MIN_DAYS);
  });
  it('explains every missing requirement', () => {
    const r = report(session(edge(30)), 'synthetic');
    const e = eligibility(strat({ published: false }), r);
    expect(e.ranked).toBe(false);
    const all = e.reasons.join(' ');
    expect(all).toMatch(/Not published/);
    expect(all).toMatch(new RegExp(`${RANK_MIN_TRADES - 30} more closed trades`));
    expect(all).toMatch(/more days of tested history/);
    expect(all).toMatch(/synthetic practice data/);
  });
  it('flags market data that is not on this device', () => {
    const s = session(edge(120));
    const r = buildReport(buildRecords([s], new Map()), { initial: 10000, off: offsetFn('UTC') })!;
    expect(r.synthetic).toBe('unknown');
    expect(eligibility(strat(), r).reasons.join(' ')).toMatch(/EURUSD is not on this device/);
  });
  it('awards badges from the report', () => {
    const ids = badges(report(session(edge(300)))).map((b) => b.id);
    expect(ids).toContain('n100');
    expect(ids).toContain('year');
    expect(ids).toContain('sig');
    expect(badges(report(session(edge(30)))).map((b) => b.id)).not.toContain('n100');
  });
});

describe('all-weather label', () => {
  it('needs ranging and trending profits', () => {
    const trendOnly = report(session(edge(300), { trend: (i) => (i % 2 ? 'up' : 'down') }));
    const chk = allWeatherCheck(trendOnly as Omit<Report, 'score'>);
    expect(chk.ok).toBe(false);
    expect(chk.missing.join(' ')).toMatch(/ranging markets/);
    expect(trendOnly.score.allWeather).toBe(false);
    expect(trendOnly.score.tier).not.toBe('allweather');
  });
  it('a strong regime-independent edge is all-weather', () => {
    const r = report(session(edge(300)));
    expect(allWeatherCheck(r as Omit<Report, 'score'>).missing).toEqual([]);
    expect(r.score.allWeather).toBe(true);
  });
});

describe('score wording', () => {
  it('only says "capped" when a gate lowered the score', () => {
    const short = report(session(edge(40)));
    expect(short.score.raw!).toBeGreaterThan(69);
    expect(short.score.verdict).toMatch(/Capped at 69 because: tested for less than 3 months/);
    // a fixed losing pattern (one +2R win, three −1R losses: −0.25R per trade)
    const losing = report(session(Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 2 : -1))));
    expect(losing.significance.mean).toBeLessThan(0);
    expect(losing.score.raw!).toBeLessThanOrEqual(34);
    expect(losing.score.verdict).not.toMatch(/Capped/);
    expect(losing.score.verdict).toMatch(/Flagged: [^.]*no positive expectancy/);
  });
});

describe('strategy store helpers', () => {
  it('sanitizes untrusted backup entries', () => {
    expect(sanitizeStrategy(null)).toBeNull();
    expect(sanitizeStrategy({ name: 'x' })).toBeNull();
    const s = sanitizeStrategy({ id: 'a', name: 'n'.repeat(200), sessionIds: ['s1', 's1', 3, 's2'], published: 'yes', createdAt: 'x' })!;
    expect(s.name.length).toBe(80);
    expect(s.sessionIds).toEqual(['s1', 's2']);
    expect(s.published).toBe(false);
    expect(s.createdAt).toBe(0);
  });
  it('drops sessions that no longer exist and orders by start', () => {
    const a = session([1], { id: 'a' }), b = session([1], { id: 'b' });
    b.start = a.start - DAY;
    const list = strategySessions(strat({ sessionIds: ['a', 'gone', 'b'] }), [a, b]);
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
  });
});
