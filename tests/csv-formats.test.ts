import { describe, expect, it } from 'vitest';
import { parseCsv, parseStamp } from '../src/data/csv';

/**
 * Candle files as people actually have them: exported by different platforms, opened and
 * re-saved in a spreadsheet, with odd separators, date styles and the occasional broken line.
 * A wrong date or price here poisons every backtest made on the data, so each layout is pinned.
 */
const T = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const ohlc = (b: ReturnType<typeof parseCsv>, i: number) => [b.o[i], b.h[i], b.l[i], b.c[i]].map((x) => +x.toFixed(5));
const sane = (b: ReturnType<typeof parseCsv>) => {
  for (let i = 0; i < b.n; i++) {
    expect(Number.isFinite(b.t[i]) && b.t[i] > 0, `time of bar ${i}`).toBe(true);
    for (const k of ['o', 'h', 'l', 'c'] as const) expect(Number.isFinite(b[k][i]) && b[k][i] > 0, `${k} of bar ${i}`).toBe(true);
    expect(b.h[i]).toBeGreaterThanOrEqual(Math.max(b.o[i], b.c[i]));
    expect(b.l[i]).toBeLessThanOrEqual(Math.min(b.o[i], b.c[i]));
    if (i) expect(b.t[i]).toBeGreaterThan(b.t[i - 1]);
  }
};

describe('candle CSV layouts', () => {
  it('MetaTrader: date and time in separate columns, no header', () => {
    const b = parseCsv('2024.01.02,00:00,1.10420,1.10450,1.10400,1.10430,123\n2024.01.02,00:01,1.10430,1.10460,1.10410,1.10440,98');
    expect(b.n).toBe(2);
    expect(b.t[0]).toBe(T(2024, 1, 2));
    expect(ohlc(b, 1)).toEqual([1.1043, 1.1046, 1.1041, 1.1044]);
    sane(b);
  });
  it('MetaTrader 5: tab separated with <DATE> <TIME> header', () => {
    const b = parseCsv(
      '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n2024.01.02\t00:00:00\t2063.11\t2063.80\t2062.90\t2063.50\t120\t0\t15\n2024.01.02\t00:01:00\t2063.50\t2064.10\t2063.40\t2063.95\t98\t0\t15',
    );
    expect(b.n).toBe(2);
    expect(b.t[1]).toBe(T(2024, 1, 2, 0, 1));
    expect(ohlc(b, 0)).toEqual([2063.11, 2063.8, 2062.9, 2063.5]);
    sane(b);
  });
  it('TradingView: unix seconds', () => {
    const b = parseCsv(`time,open,high,low,close,Volume\n${T(2024, 1, 2)},1.1,1.2,1.0,1.15,10\n${T(2024, 1, 2, 0, 1)},1.15,1.25,1.1,1.2,11`);
    expect([b.n, b.t[0], b.t[1]]).toEqual([2, T(2024, 1, 2), T(2024, 1, 2, 0, 1)]);
    sane(b);
  });
  it('TradingView: ISO times that carry their own UTC offset', () => {
    // exported from a chart set to Jakarta time: 07:00+07:00 is midnight UTC
    const b = parseCsv('time,open,high,low,close\n2024-01-02T07:00:00+07:00,1.1,1.2,1.0,1.15\n2024-01-02T07:01:00+07:00,1.15,1.25,1.1,1.2');
    expect([b.t[0], b.t[1]]).toEqual([T(2024, 1, 2), T(2024, 1, 2, 0, 1)]);
    expect(parseStamp('2024-01-02T07:00:00+07:00')).toBe(T(2024, 1, 2));
    expect(parseStamp('2024-01-01T19:00:00-05:00')).toBe(T(2024, 1, 2));
    expect(parseStamp('2024-01-02T00:00:00.000Z')).toBe(T(2024, 1, 2));
    expect(parseStamp('2024-01-02 00:00:00+0000')).toBe(T(2024, 1, 2));
  });
  it('a file with its own offset ignores the "timezone of the file" setting', () => {
    const b = parseCsv('time,open,high,low,close\n2024-01-02T07:00:00+07:00,1.1,1.2,1.0,1.15', 7);
    expect(b.t[0]).toBe(T(2024, 1, 2));
  });
  it('HistData: semicolons and compact dates, source in New York time', () => {
    const b = parseCsv('20240102 000000;1.10420;1.10450;1.10400;1.10430;0\n20240102 000100;1.10430;1.10460;1.10410;1.10440;0', -5);
    expect(b.t[0]).toBe(T(2024, 1, 2, 5));
    sane(b);
  });
  it('Dukascopy: day first with milliseconds', () => {
    const b = parseCsv(
      'Gmt time,Open,High,Low,Close,Volume\n02.01.2024 00:00:00.000,1.1042,1.1045,1.1040,1.1043,12.5\n02.01.2024 00:01:00.000,1.1043,1.1046,1.1041,1.1044,9',
    );
    expect([b.t[0], b.t[1]]).toEqual([T(2024, 1, 2), T(2024, 1, 2, 0, 1)]);
    sane(b);
  });
  it('Binance klines: milliseconds and extra columns', () => {
    const b = parseCsv(`${T(2024, 1, 2) * 1000},42283.58,42554.57,42261.02,42475.23,1271.68,${T(2024, 1, 2) * 1000 + 59999},54000000,1200,600,27000000,0`);
    expect(b.t[0]).toBe(T(2024, 1, 2));
    expect(ohlc(b, 0)).toEqual([42283.58, 42554.57, 42261.02, 42475.23]);
  });
  it('daily bars with a date only', () => {
    const b = parseCsv('Date,Open,High,Low,Close\n2024-01-02,1,2,0.5,1.5\n2024-01-03,1.5,2.5,1,2');
    expect([b.t[0], b.t[1]]).toEqual([T(2024, 1, 2), T(2024, 1, 3)]);
  });
});

describe('candle CSVs that went through a spreadsheet', () => {
  it('European style: semicolons with decimal commas', () => {
    const b = parseCsv(
      'Date;Time;Open;High;Low;Close;Volume\n02.01.2024;00:00;1,10420;1,10450;1,10400;1,10430;123\n02.01.2024;00:01;1,10430;1,10460;1,10410;1,10440;98',
    );
    expect(b.n).toBe(2);
    expect(ohlc(b, 0)).toEqual([1.1042, 1.1045, 1.104, 1.1043]);
    expect(b.t[1]).toBe(T(2024, 1, 2, 0, 1));
    sane(b);
  });
  it('US dates (month first) are read the same way on every line', () => {
    // the 13th can only be a day, so the whole file is month/day/year
    const rows = ['01/05/2024 00:00', '01/12/2024 00:00', '01/13/2024 00:00', '02/01/2024 00:00'].map(
      (d, i) => `${d},${1 + i / 10},${1.05 + i / 10},${0.95 + i / 10},${1.02 + i / 10},5`,
    );
    const b = parseCsv('Date,Open,High,Low,Close,Volume\n' + rows.join('\n'));
    expect(Array.from(b.t.slice(0, b.n))).toEqual([T(2024, 1, 5), T(2024, 1, 12), T(2024, 1, 13), T(2024, 2, 1)]);
    sane(b);
  });
  it('day-first dates with slashes stay day first', () => {
    const rows = ['05/01/2024 00:00', '12/01/2024 00:00', '13/01/2024 00:00', '01/02/2024 00:00'].map(
      (d, i) => `${d},${1 + i / 10},${1.05 + i / 10},${0.95 + i / 10},${1.02 + i / 10},5`,
    );
    const b = parseCsv('Date,Open,High,Low,Close,Volume\n' + rows.join('\n'));
    expect(Array.from(b.t.slice(0, b.n))).toEqual([T(2024, 1, 5), T(2024, 1, 12), T(2024, 1, 13), T(2024, 2, 1)]);
  });
  it('quoted fields, spaces after separators, a byte-order mark and Windows line ends', () => {
    const b = parseCsv(
      '﻿"Date","Open","High","Low","Close"\r\n"2024-01-02 00:00", "1.1", "1.2", "1.0", "1.15"\r\n"2024-01-02 00:01", "1.15", "1.25", "1.1", "1.2"\r\n',
    );
    expect(b.n).toBe(2);
    expect(ohlc(b, 1)).toEqual([1.15, 1.25, 1.1, 1.2]);
    sane(b);
  });
  it('a byte-order mark in front of a file without a header', () => {
    const b = parseCsv('﻿2024.01.02,00:00,1.1,1.2,1.0,1.15,1\n2024.01.02,00:01,1.15,1.25,1.1,1.2,1');
    expect(b.n).toBe(2);
    expect(b.t[0]).toBe(T(2024, 1, 2));
  });
  it('12-hour clock times', () => {
    const b = parseCsv('Date,Open,High,Low,Close\n01/13/2024 1:05 PM,1.1,1.2,1.0,1.15\n01/13/2024 12:10 AM,1.0,1.1,0.9,1.05');
    expect(Array.from(b.t.slice(0, b.n))).toEqual([T(2024, 1, 13, 0, 10), T(2024, 1, 13, 13, 5)]);
  });
});

describe('damaged candle CSVs', () => {
  it('rows out of order and repeated rows are sorted and merged', () => {
    const b = parseCsv(
      'time,open,high,low,close\n2024-01-02 00:02,3,3,3,3\n2024-01-02 00:00,1,1,1,1\n2024-01-02 00:01,2,2,2,2\n2024-01-02 00:01,2.5,2.6,2.4,2.5',
    );
    expect(b.n).toBe(3);
    expect(Array.from(b.c.slice(0, 3))).toEqual([1, 2.5, 3]);
    sane(b);
  });
  it('broken lines are skipped, never turned into broken candles', () => {
    const b = parseCsv(
      [
        'time,open,high,low,close,volume',
        '2024-01-02 00:00,1.1,1.2,1.0,1.15,5',
        'this line is nonsense',
        '2024-01-02 00:01,abc,1.2,1.0,1.15,5',
        '2024-01-02 00:02,1.1',
        '2024-01-02 00:03,1.1,,,1.15,5',
        '2024-01-02 00:04,0,0,0,0,0',
        '2024-01-02 00:05,-1,1,-2,1,0',
        '2024-01-02 00:06,1.15,1.25,1.1,1.2,7',
        '',
      ].join('\n'),
    );
    sane(b);
    // 00:00 and 00:06 are good; 00:03 has open and close, so its high and low come from them
    expect(Array.from(b.t.slice(0, b.n))).toEqual([T(2024, 1, 2, 0, 0), T(2024, 1, 2, 0, 3), T(2024, 1, 2, 0, 6)]);
    expect(ohlc(b, 1)).toEqual([1.1, 1.15, 1.1, 1.15]);
  });
  it('a header without high and low still gives whole candles', () => {
    const b = parseCsv('time,open,close\n2024-01-02 00:00,1.1,1.15\n2024-01-02 00:01,1.15,1.1');
    expect(b.n).toBe(2);
    sane(b);
  });
  it('an empty file, a header alone and a file that is not candles are refused with a reason', () => {
    expect(() => parseCsv('')).toThrow(/empty/i);
    expect(() => parseCsv('   \n \n')).toThrow(/empty/i);
    expect(() => parseCsv('time,open,high,low,close\n')).toThrow(/No parseable rows/);
    expect(() => parseCsv('{"app":"overflowtrade","sessions":[]}')).toThrow();
    expect(() => parseCsv('just some words\nand more words')).toThrow();
    expect(() => parseCsv('name,email\nann,ann@example.com')).toThrow();
  });
});
