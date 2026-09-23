import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deviceTokenGate, issueDeviceToken, listDeviceTokens } from '@/lib/device-tokens';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { requireTenant } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };

export async function GET() {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  const gate = deviceTokenGate(tenant); if (gate) return gate;
  return NextResponse.json({ tokens: await listDeviceTokens(getDb()!, tenant.id!) }, { headers });
}

export async function POST(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  const gate = deviceTokenGate(tenant); if (gate) return gate;
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin token changes are not allowed' }, { status: 403, headers });
  let label = '';
  try { const body = await request.json() as { label?: unknown }; label = typeof body.label === 'string' ? body.label.trim() : ''; }
  catch { return NextResponse.json({ error: 'Expected a JSON body with a label' }, { status: 400, headers }); }
  if (!label) return NextResponse.json({ error: 'A label (the device name) is required' }, { status: 400, headers });
  const issued = await issueDeviceToken(getDb()!, tenant.id!, label);
  // The plaintext appears exactly here, once; only its digest is stored.
  return NextResponse.json(issued, { status: 201, headers });
}
