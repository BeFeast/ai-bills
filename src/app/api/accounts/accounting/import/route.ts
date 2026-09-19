import { NextResponse } from 'next/server';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { loadConfig } from '@/lib/config';
import { AccountingConflictError, AccountingInputError, appendFinancialRecords } from '@/lib/accounting';
import { MAX_STATEMENT_BYTES, StatementImportError, importStatement, type StatementImportInput } from '@/lib/statement-import';
import { readBounded } from '@/lib/snapshot-ingest';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set(['payment', 'accrual', 'api-equivalent', 'balance', 'subscription']);
const DATE_FORMATS = new Set(['iso', 'mdy', 'dmy']);

/** CSV statement → financial records. `dryRun: true` previews the parse and writes nothing. */
export async function POST(request: Request) {
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin accounting changes are not allowed' }, { status: 403 });
  try {
    const path = loadConfig().accounting?.journal_path;
    if (!path) return NextResponse.json({ error: 'Private accounting journal is not configured' }, { status: 503 });
    // Bounded by bytes on the wire. JSON escaping can double a quote-heavy CSV, so the wire bound is twice the
    // decoded limit plus the envelope; the decoded CSV is still held to MAX_STATEMENT_BYTES by importStatement.
    const read = await readBounded(request, MAX_STATEMENT_BYTES * 2 + 10_000);
    if (!read.ok) throw new AccountingInputError('Import is too large');
    const body = JSON.parse(read.text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountingInputError('Expected a JSON object');
    for (const key of ['csv', 'sourceId', 'accountId', 'provider', 'kind']) if (typeof body[key] !== 'string' || !body[key].trim()) throw new AccountingInputError(`Missing ${key}`);
    if (!KINDS.has(body.kind)) throw new AccountingInputError('Invalid financial kind');
    if (body.dateFormat !== undefined && !DATE_FORMATS.has(body.dateFormat)) throw new AccountingInputError('dateFormat must be iso, mdy or dmy');
    if (body.mapping !== undefined && (!body.mapping || typeof body.mapping !== 'object' || Array.isArray(body.mapping) || Object.values(body.mapping).some(v => typeof v !== 'string'))) throw new AccountingInputError('mapping must map fields to column headers');
    const input: StatementImportInput = { csv: body.csv, sourceId: body.sourceId.trim(), accountId: body.accountId.trim(), provider: body.provider.trim(), kind: body.kind, currency: typeof body.currency === 'string' ? body.currency.trim() : undefined, mapping: body.mapping, dateFormat: body.dateFormat };
    const parsed = importStatement(input);
    const preview = { parsed: parsed.records.length, skipped: parsed.skipped, columns: parsed.columns, mapping: parsed.mapping, sample: parsed.records.slice(0, 5) };
    if (body.dryRun === true) return NextResponse.json({ ...preview, dryRun: true }, { headers: { 'cache-control': 'no-store' } });
    if (!parsed.records.length) throw new AccountingInputError('No rows could be read; nothing was imported');
    const result = await appendFinancialRecords(path, parsed.records);
    return NextResponse.json({ ...preview, ...result, dryRun: false }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const input = error instanceof AccountingInputError || error instanceof StatementImportError || error instanceof SyntaxError;
    const conflict = error instanceof AccountingConflictError;
    return NextResponse.json({ error: input || conflict ? (error as Error).message : 'Accounting source unavailable' }, { status: input ? 400 : conflict ? 409 : 503 });
  }
}
