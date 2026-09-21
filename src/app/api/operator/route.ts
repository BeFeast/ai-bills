import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isOperator, operatorOverview } from '@/lib/operator';
import { requireTenant } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };

/** Cross-tenant view for the platform operator: every tenant, its ingest freshness and its latest quota observations. */
export async function GET() {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (!isOperator(tenant)) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'No database configured; there is one tenant and it is this instance' }, { status: 404, headers });
  try { return NextResponse.json(await operatorOverview(db), { headers }); }
  catch { return NextResponse.json({ error: 'Operator overview unavailable' }, { status: 503, headers }); }
}
