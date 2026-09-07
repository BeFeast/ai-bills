import { NextResponse } from 'next/server';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { loadConfig } from '@/lib/config';
import { accountingOverview, appendFinancialRecords, AccountingConflictError, AccountingInputError, currentMonth } from '@/lib/accounting';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const config = loadConfig();
    const month = new URL(request.url).searchParams.get('month') ?? currentMonth(config.server.timezone);
    return NextResponse.json(await accountingOverview(config.accounting, month), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin accounting changes are not allowed' }, { status: 403 });
  try {
    const path = loadConfig().accounting?.journal_path;
    if (!path) return NextResponse.json({ error: 'Private accounting journal is not configured' }, { status: 503 });
    const content = await request.text();
    if (content.length > 2_000_000) throw new AccountingInputError('Import is too large');
    const body = JSON.parse(content);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountingInputError('Expected a JSON object');
    if (!Array.isArray(body.records)) throw new AccountingInputError('Expected records array');
    return NextResponse.json(await appendFinancialRecords(path, body.records));
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  const input = error instanceof AccountingInputError || error instanceof SyntaxError;
  const conflict = error instanceof AccountingConflictError;
  return NextResponse.json({ error: input || conflict ? (error as Error).message : 'Accounting source unavailable' }, { status: input ? 400 : conflict ? 409 : 503 });
}
