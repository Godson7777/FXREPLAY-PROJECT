import { guessSpec, type InstrumentSpec } from '../core/types';
import { newBrokerState, quoteToUsd, type ExitReason, type Side, type Trade } from '../engine/broker';
import { newSession, type Session } from '../engine/replay';

/**
 * Turns a closed-trade history CSV (an FX Replay "backtesting analytics" export, or any
 * file with open/close time, symbol, side, entry/exit price, size and profit columns)
 * into the app's Trade objects, so the whole analytics stack can score it.
 */
export type TradeFormat = 'fxreplay' | 'generic';

export interface TradeImport {
  format: TradeFormat;
  trades: Trade[];
  symbols: string[];
  specs: Record<string, InstrumentSpec>;
  /** starting balance found in the file (FX Replay `initialBalance`), else null */
  initialBalance: number | null;
  from: number;
  to: number;
  rows: number;
  warnings: string[];
}

const norm = (s: string) => s.trim().replace(/^\uFEFF/, '').replace(/["']/g, '').toLowerCase().replace(/[\s_\-()/]+/g, '');

/** Split one CSV line, honouring double-quoted cells. */
function cells(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') (cur += '"'), i++;
      else q = !q;
    } else if (ch === delim && !q) (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** "2026/08/31 11:25:00", "2026-08-31T11:25:00Z", "2026.08.31 11:25", "31.08.2026 11:25", unix s/ms */
export function parseTime(v: string, offsetHours = 0): number | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.floor(+s);
  if (/^\d{13}$/.test(s)) return Math.floor(+s / 1000);
  let m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  let y: number, mo: number, d: number, hh = 0, mi = 0, ss = 0;
  if (m) [y, mo, d, hh, mi, ss] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
  else {
    m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (!m) return null;
    [d, mo, y, hh, mi, ss] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
  }
  const t = Date.UTC(y, mo - 1, d, hh, mi, ss) / 1000;
  if (!isFinite(t)) return null;
  // an explicit Z / ±hh:mm in the text wins over the chosen offset
  const tz = /(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (tz) {
    if (tz[1] === 'Z') return t;
    const sign = tz[1][0] === '-' ? -1 : 1;
    const digits = tz[1].replace(/[^0-9]/g, '');
    return t - sign * (+digits.slice(0, 2) * 3600 + +digits.slice(2) * 60);
  }
  return t - offsetHours * 3600;
}

const COLS: Record<string, string[]> = {
  open: ['datestart', 'opentime', 'opendate', 'entrytime', 'entrydate', 'timeopen', 'open'],
  close: ['dateend', 'closetime', 'closedate', 'exittime', 'exitdate', 'timeclose', 'close'],
  symbol: ['pair', 'symbol', 'instrument', 'market', 'item', 'ticker'],
  side: ['side', 'type', 'direction', 'action', 'buysell'],
  entry: ['entryprice', 'openprice', 'priceopen', 'entry', 'price'],
  exit: ['avgcloseprice', 'closeprice', 'exitprice', 'priceclose', 'exit'],
  sl: ['initialsl', 'sl', 'stoploss', 's/l', 'stop'],
  size: ['amount', 'size', 'volume', 'lots', 'quantity', 'qty', 'units'],
  pnl: ['rpnl', 'profit', 'pnl', 'netprofit', 'netpnl', 'realizedpnl', 'p/l', 'pl'],
  r: ['avgriskreward', 'r', 'rmultiple', 'rr'],
  tags: ['tags', 'tag', 'setup', 'strategy', 'comment', 'notes'],
  status: ['status'],
  balance: ['initialbalance'],
  id: ['id', 'ticket', 'order', 'position', 'deal'],
  commission: ['commission', 'fees', 'fee'],
  swap: ['swap'],
};

export function parseTradeCsv(text: string, opts: { utcOffsetHours?: number } = {}): TradeImport {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) throw new Error('The file has no trade rows');
  const delim = [',', ';', '\t'].map((d) => [d, lines[0].split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const head = cells(lines[0], delim).map(norm);
  const col = (k: keyof typeof COLS) => {
    for (const name of COLS[k]) {
      const i = head.indexOf(norm(name));
      if (i >= 0) return i;
    }
    return -1;
  };
  const C = Object.fromEntries(Object.keys(COLS).map((k) => [k, col(k as keyof typeof COLS)])) as Record<keyof typeof COLS, number>;
  const format: TradeFormat = C.balance >= 0 && head.includes('rpnl') ? 'fxreplay' : 'generic';
  const need: (keyof typeof COLS)[] = ['open', 'close', 'side', 'entry', 'pnl'];
  const missing = need.filter((k) => C[k] < 0);
  if (missing.length) throw new Error(`Missing columns: ${missing.join(', ')} — the file needs open time, close time, side, entry price and profit`);
  const off = opts.utcOffsetHours ?? 0;
  const warnings: string[] = [];
  const trades: Trade[] = [];
  const specs: Record<string, InstrumentSpec> = {};
  let initialBalance: number | null = null;
  const num = (v: string | undefined) => (v == null || v.trim() === '' ? NaN : +v.replace(/[\s$,](?=\d)|\s/g, ''));
  for (let li = 1; li < lines.length; li++) {
    const c = cells(lines[li], delim);
    const rowNo = li + 1;
    const get = (k: keyof typeof COLS) => (C[k] >= 0 ? c[C[k]] ?? '' : '');
    const status = get('status').toLowerCase();
    if (status && status !== 'closed') {
      warnings.push(`Row ${rowNo}: skipped (status "${status}")`);
      continue;
    }
    const sideRaw = get('side').toLowerCase();
    const side: Side | null = /^(buy|long|b)\b/.test(sideRaw) ? 'long' : /^(sell|short|s)\b/.test(sideRaw) ? 'short' : null;
    const et = parseTime(get('open'), off), xt = parseTime(get('close'), off);
    const entry = num(get('entry')), pnl = num(get('pnl'));
    if (!side || et == null || xt == null || !isFinite(entry) || !isFinite(pnl)) {
      warnings.push(`Row ${rowNo}: skipped (could not read ${!side ? 'side' : et == null || xt == null ? 'a date' : 'a number'})`);
      continue;
    }
    if (initialBalance == null && C.balance >= 0 && isFinite(num(get('balance')))) initialBalance = num(get('balance'));
    const symbol = (get('symbol') || 'TRADES').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    const spec = (specs[symbol] ??= guessSpec(symbol, entry));
    const dir = side === 'long' ? 1 : -1;
    const sizeRaw = num(get('size'));
    let exit = num(get('exit'));
    const q = quoteToUsd(symbol, entry);
    // FX Replay `amount` is in units (P&L = move × amount); generic files are usually in lots
    const unitsGuess = isFinite(sizeRaw) && isFinite(exit) && exit !== entry ? Math.abs(pnl / ((exit - entry) * q)) : NaN;
    let units: number;
    if (format === 'fxreplay') units = sizeRaw;
    else if (isFinite(sizeRaw) && isFinite(unitsGuess) && Math.abs(unitsGuess - sizeRaw * spec.contractSize) / (sizeRaw * spec.contractSize) < 0.25) units = sizeRaw * spec.contractSize;
    else if (isFinite(sizeRaw) && isFinite(unitsGuess) && Math.abs(unitsGuess - sizeRaw) / sizeRaw < 0.25) units = sizeRaw;
    else units = isFinite(sizeRaw) ? sizeRaw * spec.contractSize : unitsGuess;
    if (!(units > 0)) {
      warnings.push(`Row ${rowNo}: skipped (no position size)`);
      continue;
    }
    if (!isFinite(exit)) exit = entry + (dir * pnl) / (units * q);
    const sl = num(get('sl'));
    const hasSl = isFinite(sl) && sl > 0 && dir * (entry - sl) > 0;
    const risk = hasSl ? Math.abs(entry - sl) * units * q : null;
    const rCol = num(get('r'));
    const r = risk ? pnl / risk : isFinite(rCol) ? rCol : null;
    const commission = Math.abs(num(get('commission')) || 0) + Math.max(0, -(num(get('swap')) || 0));
    const exitReason: ExitReason = r == null ? (pnl >= 0 ? 'tp' : 'sl') : r > 0.05 ? 'tp' : Math.abs(r + 1) < 0.08 ? 'sl' : 'manual';
    const tags = get('tags').split(/[|;]/).map((x) => x.trim()).filter(Boolean);
    const lots = Math.round((units / spec.contractSize) * 10000) / 10000;
    trades.push({
      id: trades.length + 1, symbol, side, lots, entry, exit, entryTime: et, exitTime: Math.max(xt, et),
      gross: pnl + commission, commission, pnl, pips: (dir * (exit - entry)) / spec.pipSize,
      risk, r: r != null && isFinite(r) ? r : null,
      maePips: 0, mfePips: 0, maeR: null, mfeR: null,
      holdSec: Math.max(0, xt - et), exitReason, orderType: 'market', tags,
      note: C.id >= 0 && get('id') ? `Imported #${get('id')}` : '', balanceAfter: 0,
    });
  }
  if (!trades.length) throw new Error(`No closed trades could be read${warnings.length ? ` (${warnings[0]})` : ''}`);
  trades.sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
  trades.forEach((t, i) => (t.id = i + 1));
  return {
    format, trades, symbols: Object.keys(specs), specs, initialBalance,
    from: Math.min(...trades.map((t) => t.entryTime)), to: Math.max(...trades.map((t) => t.exitTime)),
    rows: lines.length - 1, warnings,
  };
}

/** A saved session holding the imported trades (no chart data — analytics only). */
export function importedSession(imp: TradeImport, o: { id: string; name: string; balance: number; file: string; timezone: string }): Session {
  const s = newSession({
    id: o.id, name: o.name, description: `Imported from ${imp.format === 'fxreplay' ? 'FX Replay' : 'CSV'} · ${o.file}`,
    symbols: imp.symbols, start: imp.from, end: imp.to, balance: o.balance, commissionPerLot: 0, spreadPips: { '*': 0 },
    slFirst: true, timezone: o.timezone, riskPct: 1, createdAt: Date.now(), specs: imp.specs,
    imported: { source: imp.format === 'fxreplay' ? 'fxreplay' : 'csv', file: o.file, rows: imp.rows },
  });
  const br = newBrokerState(o.balance);
  let bal = o.balance;
  br.trades = imp.trades.map((t) => {
    bal += t.pnl;
    return { ...t, balanceAfter: bal };
  });
  br.balance = bal;
  br.nextId = imp.trades.length + 1;
  br.equity = [{ t: imp.from, balance: o.balance, equity: o.balance }, ...br.trades.map((t) => ({ t: t.exitTime, balance: t.balanceAfter, equity: t.balanceAfter }))];
  s.state.broker = br;
  s.state.clock = imp.to + 1;
  s.state.finished = true;
  return s;
}
