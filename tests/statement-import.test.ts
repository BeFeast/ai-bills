import { describe, expect, it } from 'vitest';
import { importStatement, parseCsv, parseStatementAmount, parseStatementDate, resolveMapping } from '@/lib/statement-import';

const base = { sourceId: 'openai-invoices', accountId: 'acc-1', provider: 'openai', kind: 'payment' as const };

describe('parseCsv', () => {
  it('handles quotes, embedded commas and newlines, CRLF and a trailing line', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n1,2\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
    expect(parseCsv('a\n"multi\nline",\n')).toEqual([['a'], ['multi\nline', '']]);
  });
});

describe('dates and amounts', () => {
  it('reads ISO and month-name dates, refuses ambiguous slash dates without an order', () => {
    expect(parseStatementDate('2026-09-03')).toEqual({ date: '2026-09-03' });
    expect(parseStatementDate('2026-09-03T10:00:00Z')).toEqual({ date: '2026-09-03' });
    expect(parseStatementDate('Sep 3, 2026')).toEqual({ date: '2026-09-03' });
    expect(parseStatementDate('3 Sep 2026')).toEqual({ date: '2026-09-03' });
    expect(parseStatementDate('09/03/2026')).toMatchObject({ reason: expect.stringContaining('ambiguous') });
    expect(parseStatementDate('09/03/2026', 'mdy')).toEqual({ date: '2026-09-03' });
    expect(parseStatementDate('09/03/2026', 'dmy')).toEqual({ date: '2026-03-09' });
    expect(parseStatementDate('2026-02-30')).toMatchObject({ reason: expect.stringContaining('invalid') });
  });
  it('reads money with symbols, codes, separators and parentheses', () => {
    expect(parseStatementAmount('$1,234.50')).toEqual({ amount: 1234.5, currency: 'USD' });
    expect(parseStatementAmount('-$12.34')).toEqual({ amount: -12.34, currency: 'USD' });
    expect(parseStatementAmount('(20.00)')).toEqual({ amount: -20 });
    expect(parseStatementAmount('1.234,56 EUR')).toEqual({ amount: 1234.56, currency: 'EUR' });
    expect(parseStatementAmount('€19,99')).toEqual({ amount: 19.99, currency: 'EUR' });
    expect(parseStatementAmount('12.5')).toEqual({ amount: 12.5 });
    // A comma before one or two digits is a decimal comma; before exactly three it is grouping; anything else is refused.
    expect(parseStatementAmount('12,34')).toEqual({ amount: 12.34 });
    expect(parseStatementAmount('1,234')).toEqual({ amount: 1234 });
    expect(parseStatementAmount('1,2345')).toMatchObject({ reason: expect.stringContaining('unreadable') });
    expect(parseStatementAmount('n/a')).toMatchObject({ reason: expect.stringContaining('unreadable') });
  });
});

describe('resolveMapping', () => {
  it('detects common headers and honours explicit ones, failing on unknown columns', () => {
    expect(resolveMapping(['Invoice number', 'Date', 'Description', 'Amount', 'Currency'])).toEqual({ date: 'Date', amount: 'Amount', currency: 'Currency', id: 'Invoice number', description: 'Description' });
    expect(resolveMapping(['when', 'cost'], { date: 'when' })).toMatchObject({ date: 'when', amount: 'cost' });
    expect(() => resolveMapping(['when', 'cost'])).toThrow(/date column/);
    expect(() => resolveMapping(['Date', 'Amount'], { id: 'Ref' })).toThrow(/"Ref"/);
  });
});

describe('importStatement', () => {
  it('turns a billing export into idempotent records and reports what it skipped', () => {
    const csv = 'Invoice number,Date,Description,Amount,Status\nINV-1,2026-09-01,"API usage, August",$120.00,paid\nINV-2,2026-09-15,Credits,"$50.00",paid\n,not a date,Odd row,$1.00,paid\nINV-4,2026-09-20,Refund,,paid\n';
    const result = importStatement({ ...base, csv, currency: 'USD' });
    expect(result.records).toEqual([
      { ...base, sourceRecordId: 'INV-1', amount: 120, currency: 'USD', date: '2026-09-01', note: 'API usage, August' },
      { ...base, sourceRecordId: 'INV-2', amount: 50, currency: 'USD', date: '2026-09-15', note: 'Credits' },
    ]);
    expect(result.skipped).toEqual([{ row: 4, reason: expect.stringContaining('date') }, { row: 5, reason: 'empty amount' }]);
    expect(result.mapping).toMatchObject({ date: 'Date', amount: 'Amount', id: 'Invoice number' });
  });
  it('derives a stable identity from the row facts when the statement has no reference, keeping equal rows apart', () => {
    const csv = 'date,amount\n2026-09-01,10\n2026-09-01,10\n2026-09-02,10\n';
    const a = importStatement({ ...base, csv, currency: 'USD' }); const b = importStatement({ ...base, csv, currency: 'USD' });
    expect(a.records.map(r => r.sourceRecordId)).toEqual(b.records.map(r => r.sourceRecordId));
    // Two identical charges on one day are two records; the same file imported twice is still two records, not four.
    expect(a.records[0].sourceRecordId).toMatch(/^row:[a-f0-9]{24}$/);
    expect(a.records[1].sourceRecordId).toBe(`${a.records[0].sourceRecordId}#2`);
    expect(a.records[2].sourceRecordId).not.toBe(a.records[0].sourceRecordId);
    expect(new Set(a.records.map(r => r.sourceRecordId)).size).toBe(3);
  });
  it('needs a currency from the column, the amount or the default, and refuses empty or oversized statements', () => {
    expect(importStatement({ ...base, csv: 'date,amount\n2026-09-01,10\n' }).skipped[0].reason).toContain('no currency');
    expect(importStatement({ ...base, csv: 'date,amount,currency\n2026-09-01,10,eur\n' }).records[0].currency).toBe('EUR');
    expect(() => importStatement({ ...base, csv: '  ' })).toThrow(/empty/);
    expect(() => importStatement({ ...base, csv: 'date,amount\n' })).toThrow(/header row/);
    expect(() => importStatement({ ...base, csv: 'date,amount\n' + '2026-09-01,1\n'.repeat(5001) })).toThrow(/5000/);
  });
});
