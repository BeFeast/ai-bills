import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { MAX_SNAPSHOT_BYTES, bearerAccepted, parseTokenDigests, validateSnapshot, writeSnapshotAtomically } from '@/lib/snapshot-ingest';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };

/** Collector push for hosted instances: bearer token (hashed on this side), envelope check, atomic replace. Never reads or evaluates the content. */
export async function PUT(request: Request) {
  const digests = parseTokenDigests(process.env.AI_BILLS_INGEST_TOKEN_SHA256);
  if (!digests.length) return NextResponse.json({ error: 'Snapshot ingest is not enabled on this instance' }, { status: 404, headers });
  if (!bearerAccepted(request.headers.get('authorization'), digests)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } });
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_SNAPSHOT_BYTES) return NextResponse.json({ error: 'snapshot too large' }, { status: 413, headers });
  const raw = await request.text();
  const verdict = validateSnapshot(raw);
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.error === 'snapshot too large' ? 413 : 400, headers });
  try {
    await writeSnapshotAtomically(loadConfig().billing.snapshot_path, raw);
  } catch { return NextResponse.json({ error: 'Snapshot could not be stored' }, { status: 503, headers }); }
  return NextResponse.json({ ok: true, generated: verdict.generated, bytes: raw.length }, { headers });
}
