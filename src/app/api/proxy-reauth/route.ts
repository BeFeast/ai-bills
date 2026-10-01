import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { reauthConfigured, reauthJob, startProxyReauth } from '@/lib/proxy-reauth';
import { requireTenant } from '@/lib/tenant';
import { isOperator } from '@/lib/operator';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
const accountKey = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : null;

export async function GET(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  const key = accountKey(new URL(request.url).searchParams.get('accountKey'));
  if (!key) return NextResponse.json({ error: 'Select an account' }, { status: 400, headers });
  return NextResponse.json({ configured: reauthConfigured(loadConfig()), job: reauthJob(tenant.id, key) }, { headers });
}

/** Starts the proxy's OAuth flow for one account. The proxy and its browser profiles are the instance's, not a tenant's:
 * only a signed-in platform operator may drive them, never an ingest or a device token. */
export async function POST(request: Request) {
  const { tenant, forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (tenant.access !== 'session' || !isOperator(tenant)) return NextResponse.json({ error: 'Only a signed-in operator can reconnect the proxy' }, { status: 403, headers });
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin proxy reconnect is not allowed' }, { status: 403, headers });
  const config = loadConfig();
  if (!reauthConfigured(config)) return NextResponse.json({ error: 'Proxy management is not configured on this instance' }, { status: 409, headers });
  let body: unknown;
  try { const text = await request.text(); if (text.length > 512) throw new Error('too large'); body = JSON.parse(text); } catch { return NextResponse.json({ error: 'Expected {"accountKey": "..."}' }, { status: 400, headers }); }
  const key = accountKey((body as { accountKey?: unknown } | null)?.accountKey);
  if (!key) return NextResponse.json({ error: 'Select an account' }, { status: 400, headers });
  const { job } = startProxyReauth(config, tenant.id, key);
  return NextResponse.json({ configured: true, job }, { status: 202, headers });
}
