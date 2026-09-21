import { NextResponse } from 'next/server';
import { defaultTenantSlug, ensureTenant, getDb } from '@/lib/db';
import { MAX_SNAPSHOT_BYTES, bearerAccepted, bearerDigest, parseTokenDigests, readBounded, validateSnapshot } from '@/lib/snapshot-ingest';
import { storeSnapshot } from '@/lib/snapshot-store';
import { tenantForIngestDigest } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };

/** Collector push: bearer token (hashed on this side), envelope check, stored for the tenant the token names (`ingest_tokens`;
 * environment digests map to the default tenant). Never reads or evaluates the content beyond the envelope and the quota entries it records. */
export async function PUT(request: Request) {
  const digests = parseTokenDigests(process.env.AI_BILLS_INGEST_TOKEN_SHA256);
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Snapshot ingest needs the database (DATABASE_URL)' }, { status: 503, headers });
  if (!digests.length && !(await hasAnyToken())) return NextResponse.json({ error: 'Snapshot ingest is not enabled on this instance' }, { status: 404, headers });
  const presented = bearerDigest(request.headers.get('authorization'));
  const tokenTenant = db && presented ? await tenantForIngestDigest(db, presented).catch(() => null) : null;
  if (!tokenTenant && !bearerAccepted(request.headers.get('authorization'), digests)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } });
  const body = await readBounded(request, MAX_SNAPSHOT_BYTES);
  if (!body.ok) return NextResponse.json({ error: 'snapshot too large' }, { status: 413, headers });
  const raw = body.text;
  const verdict = validateSnapshot(raw);
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.error === 'snapshot too large' ? 413 : 400, headers });
  try {
    const tenant = tokenTenant ?? await ensureTenant(db, defaultTenantSlug());
    const result = await storeSnapshot(db, tenant.id, raw, verdict.generated);
    return NextResponse.json({ ok: true, generated: verdict.generated, bytes: raw.length, stored: { tenant: tenant.slug, observations: result.observations } }, { headers });
  } catch (error) {
    console.error('[zecori] snapshot could not be stored', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Snapshot could not be stored' }, { status: 503, headers });
  }
}

/** Any live token row at all: an instance with tokens only in the database is enabled without the environment variable. */
async function hasAnyToken(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try { return (await db.query.ingestTokens.findFirst({ where: (t, { isNull }) => isNull(t.revokedAt), columns: { id: true } })) !== undefined; } catch { return false; }
}
