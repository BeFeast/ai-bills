import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/tenant';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { getDb } from '@/lib/db';
import { readWidgetPreferences, validateWidgetProviders, writeWidgetPreferences } from '@/lib/widget-preferences';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
export async function GET() {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (tenant.access !== 'session') return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
  return NextResponse.json({ providers: await readWidgetPreferences(tenant), editable: tenant.role === 'admin' && !!tenant.id && !!getDb() }, { headers });
}
export async function PUT(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (tenant.access !== 'session' || tenant.role !== 'admin' || !hasAllowedOrigin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
  if (!tenant.id || !getDb()) return NextResponse.json({ error: 'Desktop bar settings need a database' }, { status: 503, headers });
  let providers: string[] | null;
  try {
    const text = await request.text();
    if (text.length > 2000) throw new Error('Settings are too large');
    providers = validateWidgetProviders(JSON.parse(text));
  } catch { return NextResponse.json({ error: 'Choose up to eight different providers, or reset to automatic' }, { status: 400, headers }); }
  await writeWidgetPreferences(tenant, providers);
  return NextResponse.json({ providers, editable: true }, { headers });
}
