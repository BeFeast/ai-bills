import { NextResponse } from 'next/server';
import { productOverview } from '@/lib/overview';
import { loadConfig } from '@/lib/config';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { saveSubscriptionOverride, SubscriptionInputError, SubscriptionBusyError } from '@/lib/subscription-overrides';
import { requireTenant } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
export async function GET() {
  const { forbidden } = await requireTenant(); if (forbidden) return forbidden;
  return NextResponse.json(await productOverview(), { headers });
}
export async function PATCH(request: Request) {
  const { forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin subscription changes are not allowed' }, { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 16_000) throw new SubscriptionInputError('Subscription update is too large');
    const config = loadConfig();
    await saveSubscriptionOverride(config, JSON.parse(text), await productOverview(config));
    return NextResponse.json(await productOverview(config), { headers });
  } catch (error) {
    const input = error instanceof SubscriptionInputError || error instanceof SyntaxError;
    const conflict = error instanceof SubscriptionBusyError;
    return NextResponse.json({ error: input || conflict ? (error as Error).message : 'Subscription update could not be saved' }, { status: input ? 400 : conflict ? 409 : 503, headers });
  }
}
