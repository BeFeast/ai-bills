import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deviceTokenGate, revokeDeviceToken } from '@/lib/device-tokens';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { requireTenant } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  const gate = deviceTokenGate(tenant); if (gate) return gate;
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin token changes are not allowed' }, { status: 403, headers });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'Not a token id' }, { status: 400, headers });
  const revoked = await revokeDeviceToken(getDb()!, tenant.id!, id);
  return revoked ? NextResponse.json({ ok: true, id }, { headers }) : NextResponse.json({ error: 'No live device token with that id' }, { status: 404, headers });
}
