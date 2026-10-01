import { NextResponse } from 'next/server';
import { guardsReport } from '@/lib/guards';
import { requireTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };

/** Quota guards of the tenant: read by the dashboard and, with the ingest token, by the collector's push relay. */
export async function GET() {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  try { return NextResponse.json(await guardsReport(tenant), { headers }); }
  catch (error) {
    console.error('[zecori] guards report failed', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Guards unavailable' }, { status: 503, headers });
  }
}
