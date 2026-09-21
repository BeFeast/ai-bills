import { NextResponse } from 'next/server';
import { alertsReport } from '@/lib/alerts';
import { requireTenant } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  try { return NextResponse.json(await alertsReport(undefined, tenant), { headers: { 'cache-control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'Alerts unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
}
