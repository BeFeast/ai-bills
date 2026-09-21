import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { EXPORT_DIMENSIONS, EXPORT_PERIODS, usageCsv, type ExportDimension } from '@/lib/usage-export';
import { requireTenant } from '@/lib/tenant';
import { readSnapshot } from '@/lib/storage';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `GET /api/usage/export?period=month&by=project` → CSV of the snapshot's ledger rollup. Nothing is computed here; it is the rollup as delivered. */
export async function GET(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  const params = new URL(request.url).searchParams;
  const period = params.get('period') ?? 'month'; const by = params.get('by') ?? 'project';
  if (!(EXPORT_PERIODS as readonly string[]).includes(period)) return NextResponse.json({ error: `period must be one of ${EXPORT_PERIODS.join(', ')}` }, { status: 400 });
  if (!(EXPORT_DIMENSIONS as readonly string[]).includes(by)) return NextResponse.json({ error: `by must be one of ${EXPORT_DIMENSIONS.join(', ')}` }, { status: 400 });
  let ledger: Record<string, unknown> | null = null;
  try { ledger = ((await readSnapshot(loadConfig(), tenant)).body as { usage_ledger?: Record<string, unknown> }).usage_ledger ?? null; } catch { ledger = null; }
  if (!ledger || !ledger[period]) return NextResponse.json({ error: 'No usage ledger rollup in the current snapshot' }, { status: 404 });
  const result = usageCsv(ledger[period], by as ExportDimension);
  return new NextResponse(result.csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${result.filename}"`, 'cache-control': 'no-store', 'x-rows': String(result.rows) } });
}
