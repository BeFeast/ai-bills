import { defaultTenantSlug, ensureTenant, getDb, runMigrations } from '@/lib/db';
import { parseTokenDigests } from '@/lib/snapshot-ingest';
import { ensureIngestTokens } from '@/lib/tenant';

/**
 * When a database is configured, migrations are applied and the instance's default tenant exists
 * before the first request; ingest tokens configured in the environment become rows of that tenant.
 * Without DATABASE_URL nothing happens and the file-backed instance starts as before. A failure is
 * logged and does not stop the server: the file path still serves, and /api/snapshot reports the
 * database as failed.
 */
export async function initialiseDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await runMigrations();
    const db = getDb();
    if (db) {
      const tenant = await ensureTenant(db, defaultTenantSlug());
      const adopted = await ensureIngestTokens(db, tenant.id, parseTokenDigests(process.env.AI_BILLS_INGEST_TOKEN_SHA256));
      console.info(`[zecori] database ready; default tenant ${tenant.slug} (${tenant.id})${adopted ? `; ${adopted} ingest token(s) adopted from the environment` : ''}`);
    }
  } catch (error) {
    console.error('[zecori] database initialisation failed; serving from the snapshot file only', error instanceof Error ? error.message : error);
  }
}
