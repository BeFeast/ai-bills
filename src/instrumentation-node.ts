import { readFile } from 'node:fs/promises';
import { loadConfig } from '@/lib/config';
import { defaultTenantSlug, ensureTenant, getDb, runMigrations, type Db } from '@/lib/db';
import { readFinancialJournal } from '@/lib/accounting';
import { parseTokenDigests } from '@/lib/snapshot-ingest';
import { dbJournalStore, dbOverridesStore, storageMode } from '@/lib/storage';
import { subscriptionOverridesPath } from '@/lib/subscription-overrides';
import { ensureIngestTokens } from '@/lib/tenant';

/**
 * When a database is configured, migrations are applied and the instance's default tenant exists
 * before the first request; ingest tokens configured in the environment become rows of that tenant,
 * and — when the database is the source — the operator-entered files are imported once. Without
 * DATABASE_URL nothing happens and the file-backed instance starts as before. A failure is logged
 * and does not stop the server: the file path still serves, and /api/snapshot reports the database
 * as failed.
 */
export async function initialiseDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await runMigrations();
    const db = getDb();
    if (db) {
      const tenant = await ensureTenant(db, defaultTenantSlug());
      const adopted = await ensureIngestTokens(db, tenant.id, parseTokenDigests(process.env.AI_BILLS_INGEST_TOKEN_SHA256));
      const imported = storageMode() === 'db' ? await importFilesOnce(db, tenant.id) : '';
      console.info(`[zecori] database ready; default tenant ${tenant.slug} (${tenant.id})${adopted ? `; ${adopted} ingest token(s) adopted from the environment` : ''}${imported}`);
    }
  } catch (error) {
    console.error('[zecori] database initialisation failed; serving from the snapshot file only', error instanceof Error ? error.message : error);
  }
}

/**
 * One-off import of what the operator entered by hand (spec decision 12): the accounting journal and
 * the subscription overrides. Each is imported only while its table is still empty for the tenant, so
 * the files stop mattering the moment the database holds the rows; history and alert state start fresh.
 */
export async function importFilesOnce(db: Db, tenantId: string): Promise<string> {
  const config = loadConfig();
  const notes: string[] = [];
  const journal = dbJournalStore(db, tenantId);
  if (config.accounting?.journal_path && !(await journal.read()).rows.length) {
    try {
      const records = await readFinancialJournal(config.accounting.journal_path);
      if (records.length) notes.push(`; imported ${await journal.add(records.map(row => ({ recordId: row.id, record: row, observedAt: new Date(row.observedAt) })))} journal record(s) from ${config.accounting.journal_path}`);
    } catch (error) { notes.push(`; journal import skipped (${error instanceof Error ? error.message : String(error)})`); }
  }
  const overrides = dbOverridesStore(db, tenantId);
  if (!Object.keys(await overrides.read()).length) {
    try {
      const data = JSON.parse(await readFile(subscriptionOverridesPath(config), 'utf8')) as { version?: unknown; subscriptions?: Record<string, unknown> };
      const entries = data.version === 1 && data.subscriptions && typeof data.subscriptions === 'object' ? Object.entries(data.subscriptions) : [];
      for (const [id, override] of entries) await overrides.write(id, override);
      if (entries.length) notes.push(`; imported ${entries.length} subscription override(s)`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') notes.push(`; overrides import skipped (${error instanceof Error ? error.message : String(error)})`); }
  }
  return notes.join('');
}
