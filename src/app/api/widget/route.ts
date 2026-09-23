import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/tenant';
import { widgetPayload } from '@/lib/widget';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
/** The desktop widget's read: a device token or a signed-in person. The ingest token feeds this instance; it does not read it. */
export async function GET() {
  const { tenant, forbidden } = await requireTenant({ device: true }); if (forbidden) return forbidden;
  if (tenant.access === 'ingest') return NextResponse.json({ error: 'Forbidden', reason: 'An ingest token cannot read the widget' }, { status: 403, headers });
  try { return NextResponse.json(await widgetPayload(tenant), { headers }); }
  catch (error) {
    // A device token is the least trusted credential this instance accepts; it gets the fact, not the internals.
    console.error('[zecori] widget payload failed', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Widget data unavailable' }, { status: 503, headers });
  }
}
