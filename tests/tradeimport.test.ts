import { describe, expect, it } from 'vitest';
import { importedSession, parseTime, parseTradeCsv } from '../src/data/tradeimport';
import { buildRecords } from '../src/analytics/records';
import { buildReport } from '../src/analytics/report';
import { offsetFn } from '../src/core/tz';
import { badges, eligibility } from '../src/analytics/service';

// rows in the FX Replay "backtesting analytics" export layout
const FXR = `id,dateStart,dateEnd,pair,uPnL,rPnL,side,entryPrice,initialSL,maxTP,idealTP,amount,amountClosed,status,day,tags,avgClosePrice,avgRiskReward,maxRiskReward,exchangeRate,initialBalance,currentRealizedBalance
289777540,2026/08/31 11:25:00,2026/08/31 13:52:00,XAUUSD,0,2901.6,sell,4459.863,4466.437,4421.684,4282.035,76,76,closed,1,,4421.684,5.81,5.81,1,100000,102901.6
289777575,2026/08/31 13:52:00,2026/09/01 00:21:00,XAUUSD,0,1404.96,buy,4421.885,4408.337,4459.857,4461.275,37,37,closed,1,,4459.857,2.8,2.8,1,100000,104306.56
289777872,2026/09/01 07:30:00,2026/09/01 08:06:00,XAUUSD,0,-501.28,buy,4421.885,4408.337,,4428.185,37,37,closed,2,,4408.337,-1,0,1,100000,106706.88
289777900,2026/09/01 08:09:00,2026/09/01 12:32:00,XAUUSD,0,1286.45,sell,4395.392,4408.342,4362.406,4282.035,39,39,closed,2,breakout,4362.406,2.55,2.55,1,100000,107993.33
289777901,2026/09/01 13:00:00,,XAUUSD,0,0,sell,4395.392,4408.342,,,39,0,open,2,,,0,0,1,100000,107993.33`;

describe('trade CSV import', () => {
  it('reads an FX Replay export', () => {
    const imp = parseTradeCsv(FXR);
    expect(imp.format).toBe('fxreplay');
    expect(imp.initialBalance).toBe(100000);
    expect(imp.symbols).toEqual(['XAUUSD']);
    expect(imp.trades.length).toBe(4);
    expect(imp.warnings.join(' ')).toMatch(/Row 6: skipped \(status "open"\)/);
    const [a, , c, d] = imp.trades;
    expect(a.side).toBe('short');
    expect(a.lots).toBeCloseTo(0.76); // 76 oz on a 100-oz contract
    expect(a.pnl).toBe(2901.6);
    expect(a.risk).toBeCloseTo((4466.437 - 4459.863) * 76, 4);
    expect(a.r).toBeCloseTo(5.81, 1);
    expect(a.exitReason).toBe('tp');
    expect(a.entryTime).toBe(Date.UTC(2026, 7, 31, 11, 25) / 1000);
    expect(c.r).toBeCloseTo(-1, 1);
    expect(c.exitReason).toBe('sl');
    expect(d.tags).toEqual(['breakout']);
    expect(a.maeR).toBeNull();
  });

  it('applies the timestamp offset', () => {
    const imp = parseTradeCsv(FXR, { utcOffsetHours: 7 });
    expect(imp.trades[0].entryTime).toBe(Date.UTC(2026, 7, 31, 4, 25) / 1000);
    expect(parseTime('2026-08-31T11:25:00Z', 7)).toBe(Date.UTC(2026, 7, 31, 11, 25) / 1000);
    expect(parseTime('31.08.2026 11:25', 0)).toBe(Date.UTC(2026, 7, 31, 11, 25) / 1000);
  });

  it('reads a generic trade list in lots', () => {
    const csv = `Open Time,Close Time,Symbol,Type,Lots,Open Price,Close Price,S/L,Profit
2026-01-05 10:00,2026-01-05 12:00,EURUSD,buy,1,1.1000,1.1020,1.0990,200
2026-01-06 10:00,2026-01-06 11:00,EURUSD,sell,0.5,1.1050,1.1060,1.1060,-50`;
    const imp = parseTradeCsv(csv);
    expect(imp.format).toBe('generic');
    expect(imp.trades[0].lots).toBe(1);
    expect(imp.trades[0].r).toBeCloseTo(2);
    expect(imp.trades[1].r).toBeCloseTo(-1);
    expect(imp.trades[1].pips).toBeCloseTo(-10);
  });

  it('explains a file it cannot read', () => {
    expect(() => parseTradeCsv('a,b\n1,2')).toThrow(/Missing columns/);
  });

  it('becomes an analytics-only session that is real data and badged', () => {
    const imp = parseTradeCsv(FXR);
    const s = importedSession(imp, { id: 'imp', name: 'FXR', balance: 100000, file: 'x.csv', timezone: 'UTC' });
    expect(s.imported?.source).toBe('fxreplay');
    expect(s.state.broker.balance).toBeCloseTo(100000 + 2901.6 + 1404.96 - 501.28 + 1286.45);
    const recs = buildRecords([s], new Map());
    expect(recs.every((r) => r.synthetic === false)).toBe(true);
    const r = buildReport(recs, { initial: 100000, off: offsetFn('UTC') })!;
    expect(r.synthetic).toBe('none');
    expect(badges(r, [s]).map((b) => b.id)).toContain('imported');
    const e = eligibility({ id: 'st', name: 'S', author: 'A', timeframe: '', description: '', sessionIds: ['imp'], published: true, createdAt: 1, updatedAt: 1 }, r);
    expect(e.reasons.join(' ')).not.toMatch(/not on this device|synthetic/);
  });
});
