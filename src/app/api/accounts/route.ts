import { NextResponse } from 'next/server';
import { accountRegistry } from '@/lib/accounts';
import { requireTenant } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const { forbidden } = await requireTenant(); if (forbidden) return forbidden;
  try { return NextResponse.json(await accountRegistry(), { headers: { 'cache-control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'Account inventory unavailable' }, { status: 503 }); }
}
