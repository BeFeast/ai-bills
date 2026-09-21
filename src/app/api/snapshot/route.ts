import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { defaultTenantSlug, ensureTenant, getDb } from '@/lib/db';
import { MAX_SNAPSHOT_BYTES, bearerAccepted, parseTokenDigests, readBounded, validateSnapshot, writeSnapshotAtomically } from '@/lib/snapshot-ingest';
import { storeSnapshot } from '@/lib/snapshot-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };

/** Collector push for hosted instances: bearer token (hashed on this side), envelope check, atomic replace. Never reads or evaluates the content. */
export async function PUT(request: Request) {
  const digests = parseTokenDigests(process.env.AI_BILLS_INGEST_TOKEN_SHA256);
  if (!digests.length) return NextResponse.json({ error: 'Snapshot ingest is not enabled on this instance' }, { status: 404, headers });
  if (!bearerAccepted(request.headers.get('authorization'), digests)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } });
  const body = await readBounded(request, MAX_SNAPSHOT_BYTES);
  if (!body.ok) return NextResponse.json({ error: 'snapshot too large' }, { status: 413, headers });
  const raw = body.text;
  const verdict = validateSnapshot(raw);
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.error === 'snapshot too large' ? 413 : 400, headers });
  try {
    await writeSnapshotAtomically(loadConfig().billing.snapshot_path, raw);
  } catch { return NextResponse.json({ error: 'Snapshot could not be stored' }, { status: 503, headers }); }
  // Tenancy phase 1: the file stays the source the dashboard reads; the database receives the same
  // snapshot for the default tenant. A database failure is reported, never turned into a failed ingest.
  const stored = await storeInDatabase(raw, verdict.generated);
  return NextResponse.json({ ok: true, generated: verdict.generated, bytes: raw.length, stored }, { headers });
}

async function storeInDatabase(raw: string, generated: string): Promise<{ file: true; database: 'stored' | 'disabled' | 'failed'; observations?: number }> {
  const db = getDb();
  if (!db) return { file: true, database: 'disabled' };
  try {
    const tenant = await ensureTenant(db, defaultTenantSlug());
    const result = await storeSnapshot(db, tenant.id, raw, generated);
    return { file: true, database: 'stored', observations: result.observations };
  } catch (error) {
    console.error('[zecori] snapshot stored on disk but not in the database', error instanceof Error ? error.message : error);
    return { file: true, database: 'failed' };
  }
}
