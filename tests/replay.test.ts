import { describe, expect, it } from 'vitest';
import { Replay, newSession } from '../src/engine/replay';
import { barsFromRows } from '../src/core/types';

const spec = { symbol: 'EURUSD', pipSize: 0.0001, contractSize: 100000, digits: 5 };
// Friday 20:00–20:59 then nothing until Monday 00:00 (a weekend gap)
const FRI = Date.UTC(2024, 0, 5, 20) / 1000, MON = Date.UTC(2024, 0, 8) / 1000;
const rows = [...Array.from({ length: 60 }, (_, i) => [FRI + i * 60, 1.1, 1.1, 1.1, 1.1, 1]), ...Array.from({ length: 60 }, (_, i) => [MON + i * 60, 1.2, 1.2, 1.2, 1.2, 1])];
const mk = () => {
  const s = newSession({ id: 'x', name: 'x', description: '', symbols: ['EURUSD'], start: FRI + 3600, end: null, balance: 1e4, commissionPerLot: 0, spreadPips: {}, slFirst: true, timezone: 'UTC', riskPct: 1, createdAt: 0, specs: { EURUSD: spec } });
  return new Replay(s, { EURUSD: barsFromRows(rows.map((r) => [...r])) });
};

describe('replay jumps', () => {
  it('a jump that lands inside a gap moves to the next bar', () => {
    const r = mk();
    expect(r.clock).toBe(FRI + 3600);
    r.jumpTo(r.clock + 86400); // Saturday — no bars
    expect(r.clock).toBe(MON + 1);
  });
  it('a normal jump processes every bar up to the target', () => {
    const r = mk();
    r.jumpTo(MON + 30 * 60);
    expect(r.clock).toBe(MON + 30 * 60 + 1);
  });
  it('adds a symbol in sync with the clock', () => {
    const r = mk();
    r.jumpTo(MON + 10 * 60);
    r.addSymbol('GBPUSD', barsFromRows(rows.map((x) => [...x])), { ...spec, symbol: 'GBPUSD' });
    expect(r.session.symbols).toContain('GBPUSD');
    expect(r.data.GBPUSD.t[r.cursor.GBPUSD]).toBeLessThanOrEqual(r.clock - 1);
    expect(r.broker.bid('GBPUSD')).toBe(1.2);
  });
});
