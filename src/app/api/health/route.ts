import { NextResponse } from 'next/server';
import { sourceHealth } from '@/lib/source-health';
import { loadConfig } from '@/lib/config';
import { defaultTenant, getDb } from '@/lib/db';
import { readSnapshot, storageMode } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** Public liveness: health of the instance's default tenant, from the database when that is the source. */
export async function GET() {
  let snapshot: unknown | undefined;
  if (storageMode() === 'db') {
    const db = getDb();
    if (db) { try { snapshot = (await readSnapshot(loadConfig(), { id: (await defaultTenant(db)).id })).body; } catch { snapshot = undefined; } }
  }
  return NextResponse.json(sourceHealth(Date.now(), snapshot), { headers: { 'cache-control': 'no-store' } });
}
