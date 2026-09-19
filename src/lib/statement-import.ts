import { createHash } from 'node:crypto';
import type { FinancialInput, FinancialKind } from './accounting';

/**
 * CSV statement import: provider billing exports (invoices, cost reports) become financial records.
 * Columns are matched by header name; nothing is guessed about ambiguous dates or amounts, rows that
 * cannot be read are reported as skipped with the reason, and the source-record identity is the
 * statement's own reference when it has one, otherwise a digest of the row's facts.
 */
export type ColumnMapping = { date?: string; amount?: string; currency?: string; id?: string; description?: string };
export type DateFormat = 'iso' | 'mdy' | 'dmy';
export type StatementImportInput = {
  csv: string; sourceId: string; accountId: string; provider: string; kind: FinancialKind;
  /** Applied when the statement has no currency column. */
  currency?: string;
  /** Column headers per field; omitted fields are detected from common header names. */
  mapping?: ColumnMapping;
  /** Required for slash-separated dates; ISO dates are always accepted. */
  dateFormat?: DateFormat;
};
export type SkippedRow = { row: number; reason: string };
export type StatementImport = { records: FinancialInput[]; skipped: SkippedRow[]; columns: string[]; mapping: Required<Pick<ColumnMapping, 'date' | 'amount'>> & ColumnMapping };

export const MAX_STATEMENT_BYTES = 2_000_000;
export const MAX_STATEMENT_ROWS = 5000;

/** RFC 4180 parser: quoted fields, doubled quotes, CR/LF line ends. Returns rows of raw strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');
const CANDIDATES: Record<keyof ColumnMapping, string[]> = {
  date: ['date', 'invoicedate', 'transactiondate', 'createdat', 'created', 'day', 'billingdate', 'paidat', 'periodstart'],
  amount: ['amount', 'amountusd', 'total', 'totalusd', 'cost', 'costusd', 'amountdue', 'charge', 'spend', 'netamount'],
  currency: ['currency', 'currencycode'],
  id: ['invoicenumber', 'invoiceid', 'invoice', 'id', 'reference', 'transactionid', 'receiptnumber', 'number'],
  description: ['description', 'memo', 'item', 'lineitem', 'model', 'workspace', 'product', 'service', 'note'],
};

/** Pick the column index for each field: the explicit header when given, else the first common header present. */
export function resolveMapping(columns: string[], mapping: ColumnMapping = {}): StatementImport['mapping'] {
  const normalized = columns.map(normalize);
  const find = (field: keyof ColumnMapping): string | undefined => {
    const explicit = mapping[field];
    if (explicit !== undefined) {
      const index = normalized.indexOf(normalize(explicit));
      if (index < 0) throw new StatementImportError(`Column "${explicit}" (for ${field}) is not in the statement header`);
      return columns[index];
    }
    for (const candidate of CANDIDATES[field]) { const index = normalized.indexOf(candidate); if (index >= 0) return columns[index]; }
    return undefined;
  };
  const date = find('date'); const amount = find('amount');
  if (!date) throw new StatementImportError('No date column found; pass mapping.date');
  if (!amount) throw new StatementImportError('No amount column found; pass mapping.amount');
  return { date, amount, currency: find('currency'), id: find('id'), description: find('description') };
}

export class StatementImportError extends Error {}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };
/** Calendar date as YYYY-MM-DD, or a reason it could not be read. Slash dates need an explicit order. */
export function parseStatementDate(raw: string, format: DateFormat = 'iso'): { date: string } | { reason: string } {
  const value = raw.trim();
  const valid = (y: string, m: string, d: string) => {
    const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date ? { date } : { reason: `invalid calendar date "${value}"` };
  };
  let m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/); if (m) return valid(m[1], m[2], m[3]);
  m = value.match(/^([A-Za-z]{3,4})\.? (\d{1,2}),? (\d{4})$/); if (m && MONTHS[m[1].toLowerCase()]) return valid(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  m = value.match(/^(\d{1,2}) ([A-Za-z]{3,4})\.? (\d{4})$/); if (m && MONTHS[m[2].toLowerCase()]) return valid(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  m = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) {
    if (format === 'mdy') return valid(m[3], m[1], m[2]);
    if (format === 'dmy') return valid(m[3], m[2], m[1]);
    return { reason: `ambiguous date "${value}"; set dateFormat to mdy or dmy` };
  }
  return { reason: `unrecognised date "${value}"` };
}

/** Money as a number: currency symbols and thousands separators removed, parentheses mean negative. */
export function parseStatementAmount(raw: string): { amount: number; currency?: string } | { reason: string } {
  let value = raw.trim(); if (!value) return { reason: 'empty amount' };
  let negative = false;
  if (/^\(.*\)$/.test(value)) { negative = true; value = value.slice(1, -1); }
  const code = value.match(/\b([A-Z]{3})\b/)?.[1];
  const symbols: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₪': 'ILS' };
  const symbol = value.match(/[$€£₪]/)?.[0];
  value = value.replace(/[A-Z]{3}/g, '').replace(/[$€£₪\s]/g, '');
  if (value.startsWith('-')) { negative = !negative; value = value.slice(1); }
  if (value.startsWith('+')) value = value.slice(1);
  // Grouping: a comma or dot followed by exactly three digits is a thousands separator; a comma followed by
  // one or two digits can only be a decimal comma. Anything else ("1,2345") is reported, not guessed.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) value = value.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(value)) value = value.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d{1,2}$/.test(value)) value = value.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(value)) return { reason: `unreadable amount "${raw.trim()}"` };
  const amount = Number(value) * (negative ? -1 : 1);
  const currency = code ?? (symbol ? symbols[symbol] : undefined);
  return currency ? { amount, currency } : { amount };
}

export function importStatement(input: StatementImportInput): StatementImport {
  if (typeof input.csv !== 'string' || !input.csv.trim()) throw new StatementImportError('Statement is empty');
  if (input.csv.length > MAX_STATEMENT_BYTES) throw new StatementImportError('Statement is too large');
  const rows = parseCsv(input.csv.replace(/^﻿/, ''));
  if (rows.length < 2) throw new StatementImportError('Statement needs a header row and at least one data row');
  if (rows.length - 1 > MAX_STATEMENT_ROWS) throw new StatementImportError(`Statement has more than ${MAX_STATEMENT_ROWS} rows`);
  const columns = rows[0].map(c => c.trim());
  const mapping = resolveMapping(columns, input.mapping);
  const index = (header?: string) => header === undefined ? -1 : columns.indexOf(header);
  const at = (row: string[], header?: string) => { const i = index(header); return i >= 0 ? (row[i] ?? '').trim() : ''; };
  const records: FinancialInput[] = []; const skipped: SkippedRow[] = [];
  // Rows with identical facts and no reference are distinct charges: numbered in statement order, stable across re-imports.
  const seen = new Map<string, number>();
  rows.slice(1).forEach((row, n) => {
    const line = n + 2;
    const date = parseStatementDate(at(row, mapping.date), input.dateFormat);
    if ('reason' in date) { skipped.push({ row: line, reason: date.reason }); return; }
    const money = parseStatementAmount(at(row, mapping.amount));
    if ('reason' in money) { skipped.push({ row: line, reason: money.reason }); return; }
    const currency = (at(row, mapping.currency) || money.currency || input.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) { skipped.push({ row: line, reason: currency ? `invalid currency "${currency}"` : 'no currency column and no default currency' }); return; }
    const description = at(row, mapping.description);
    const reference = at(row, mapping.id);
    // A statement reference is the identity; without one, the row's facts plus its ordinal among equal rows are.
    let sourceRecordId = reference;
    if (!sourceRecordId) {
      const digest = `row:${createHash('sha256').update([date.date, money.amount, currency, description].join('\0')).digest('hex').slice(0, 24)}`;
      const ordinal = (seen.get(digest) ?? 0) + 1; seen.set(digest, ordinal);
      sourceRecordId = ordinal === 1 ? digest : `${digest}#${ordinal}`;
    }
    const record: FinancialInput = { sourceId: input.sourceId, sourceRecordId, accountId: input.accountId, provider: input.provider, kind: input.kind, amount: money.amount, currency, date: date.date };
    if (description) record.note = description.slice(0, 1000);
    records.push(record);
  });
  return { records, skipped, columns, mapping };
}
