import { NextResponse } from 'next/server';
import { reconcileMonth } from '@/lib/reconciliation';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { loadConfig } from '@/lib/config';
import { accountingOverview, appendFinancialRecords, appendFinancialRecordsTo, journalRecordsFromRows, AccountingConflictError, AccountingInputError, currentMonth, fxRates } from '@/lib/accounting';
import { requireTenant } from '@/lib/tenant';
import { journalStoreFor, readSnapshot } from '@/lib/storage';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  try {
    const config = loadConfig();
    const month = new URL(request.url).searchParams.get('month') ?? currentMonth(config.server.timezone);
    const journal = journalStoreFor(tenant);
    const journalInput = journal ? await journal.read().then(read => ({ records: journalRecordsFromRows(read.rows), observedAt: read.observedAt })) : null;
    const overview = await accountingOverview(config.accounting, month, journalInput);
    // Reconciliation needs the whole month's records (the overview already filtered them) and the ledger rollup from the snapshot.
    let ledgerMonth: unknown = null;
    try { ledgerMonth = ((await readSnapshot(config, tenant)).body as { usage_ledger?: { month?: unknown } }).usage_ledger?.month ?? null; } catch { ledgerMonth = null; }
    return NextResponse.json({ ...overview, reconciliation: reconcileMonth(overview.records, ledgerMonth, month, { rates: fxRates(config.accounting?.fx_rates) }) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin accounting changes are not allowed' }, { status: 403 });
  try {
    const store = journalStoreFor(tenant);
    const path = loadConfig().accounting?.journal_path;
    if (!store && !path) return NextResponse.json({ error: 'Private accounting journal is not configured' }, { status: 503 });
    const content = await request.text();
    if (content.length > 2_000_000) throw new AccountingInputError('Import is too large');
    const body = JSON.parse(content);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountingInputError('Expected a JSON object');
    if (!Array.isArray(body.records)) throw new AccountingInputError('Expected records array');
    return NextResponse.json(store ? await appendFinancialRecordsTo(store, body.records) : await appendFinancialRecords(path!, body.records));
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  const input = error instanceof AccountingInputError || error instanceof SyntaxError;
  const conflict = error instanceof AccountingConflictError;
  return NextResponse.json({ error: input || conflict ? (error as Error).message : 'Accounting source unavailable' }, { status: input ? 400 : conflict ? 409 : 503 });
}
