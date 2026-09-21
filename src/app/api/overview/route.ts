import { NextResponse } from 'next/server';
import { productOverview } from '@/lib/overview';
import { loadConfig } from '@/lib/config';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { saveSubscriptionOverride, SubscriptionInputError, SubscriptionBusyError, SubscriptionStoreError } from '@/lib/subscription-overrides';
import { requireTenant } from '@/lib/tenant';
import { overridesStoreFor } from '@/lib/storage';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
export async function GET() {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  return NextResponse.json(await productOverview(undefined, tenant), { headers });
}
export async function PATCH(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin subscription changes are not allowed' }, { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 16_000) throw new SubscriptionInputError('Subscription update is too large');
    const config = loadConfig();
    await saveSubscriptionOverride(config, JSON.parse(text), await productOverview(config, tenant), overridesStoreFor(tenant));
    return NextResponse.json(await productOverview(config, tenant), { headers });
  } catch (error) {
    const input = error instanceof SubscriptionInputError || error instanceof SyntaxError;
    const conflict = error instanceof SubscriptionBusyError;
    const unconfigured = error instanceof SubscriptionStoreError;
    return NextResponse.json({ error: input || conflict || unconfigured ? (error as Error).message : 'Subscription update could not be saved' }, { status: input ? 400 : conflict ? 409 : 503, headers });
  }
}
