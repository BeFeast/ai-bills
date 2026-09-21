import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { quotaObservations, snapshots } from '@/db/schema';
import { withTenant, type Db } from './db';

/** Whole snapshot bodies kept per tenant: four hours at the five-minute collector cadence. Observations are kept forever. */
export const SNAPSHOT_RETENTION = 48;

export type QuotaObservationRow = {
  provider: 'claude' | 'codex'; accountKey: string; observedAt: Date; ok: boolean; status: number | null;
  source: 'direct' | 'proxy_headers' | 'retained'; error: string | null; direct: unknown; windows: unknown;
};

type Entry = { ok?: unknown; status?: unknown; fetched_at?: unknown; error?: unknown; source?: unknown; direct?: unknown; data?: unknown };
const isEmail = (key: string) => key.includes('@');
const parseTime = (value: unknown): Date | null => { const time = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(time) ? new Date(time) : null; };

/**
 * The quota entries of a snapshot as observation rows. Entries are keyed twice by the collector —
 * an opaque identity and, when unambiguous, the email — and both point at the same observation;
 * the email key is the one the dashboard and alerts use, so it is the account key here. Identities
 * without an email alias are kept under their own key so nothing observed is dropped.
 */
export function quotaObservationsFrom(snapshot: unknown): QuotaObservationRow[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const rows: QuotaObservationRow[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const bucket = (snapshot as Record<string, unknown>)[`${provider}_usage`];
    if (!bucket || typeof bucket !== 'object') continue;
    const entries = Object.entries(bucket as Record<string, Entry>).filter(([, entry]) => entry && typeof entry === 'object');
    // After JSON parsing the alias and the identity are separate objects; the observation itself is what must be stored once.
    const signature = (entry: Entry) => JSON.stringify([entry.fetched_at, entry.ok, entry.status, entry.source, entry.error]);
    const emailed = new Set(entries.filter(([key]) => isEmail(key)).map(([, entry]) => signature(entry)));
    for (const [key, entry] of entries) {
      if (!isEmail(key) && emailed.has(signature(entry))) continue;
      const observedAt = parseTime(entry.fetched_at);
      if (!observedAt) continue;
      const source = entry.source === 'proxy_headers' || entry.source === 'retained' ? entry.source : 'direct';
      rows.push({ provider, accountKey: key, observedAt, ok: entry.ok === true, status: typeof entry.status === 'number' ? entry.status : null, source,
        error: typeof entry.error === 'string' ? entry.error : null, direct: entry.direct ?? null, windows: entry.ok === true ? entry.data ?? null : null });
    }
  }
  return rows;
}

export type StoredSnapshot = { snapshotId: string; observations: number; pruned: number };

/**
 * Record one received snapshot for a tenant: the body, its observations (deduplicated on the
 * observation time, since an unchanged observation rides along in every snapshot until the
 * collector observes again) and the retention prune. Runs under the tenant's RLS context.
 */
export async function storeSnapshot(db: Db, tenantId: string, raw: string, generated: string, now = new Date()): Promise<StoredSnapshot> {
  const body = JSON.parse(raw) as unknown;
  const generatedAt = parseTime(generated) ?? now;
  return withTenant(db, tenantId, async tx => {
    const [inserted] = await tx.insert(snapshots).values({ tenantId, generatedAt, receivedAt: now, bytes: Buffer.byteLength(raw, 'utf8'), body }).returning({ id: snapshots.id });
    const rows = quotaObservationsFrom(body);
    let observations = 0;
    if (rows.length) {
      const written = await tx.insert(quotaObservations).values(rows.map(row => ({ ...row, tenantId, snapshotId: inserted.id }))).onConflictDoNothing().returning({ id: quotaObservations.id });
      observations = written.length;
    }
    const keep = tx.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.tenantId, tenantId)).orderBy(desc(snapshots.receivedAt), desc(snapshots.id)).limit(SNAPSHOT_RETENTION);
    const pruned = await tx.delete(snapshots).where(and(eq(snapshots.tenantId, tenantId), notInArray(snapshots.id, keep))).returning({ id: snapshots.id });
    return { snapshotId: inserted.id, observations, pruned: pruned.length };
  });
}

/** The newest stored snapshot body for a tenant, or null. Phase 3 reads from here instead of the file. */
export async function latestSnapshot(db: Db, tenantId: string): Promise<{ body: unknown; generatedAt: Date; receivedAt: Date } | null> {
  return withTenant(db, tenantId, async tx => {
    const [row] = await tx.select({ body: snapshots.body, generatedAt: snapshots.generatedAt, receivedAt: snapshots.receivedAt }).from(snapshots)
      .where(eq(snapshots.tenantId, tenantId)).orderBy(desc(snapshots.receivedAt)).limit(1);
    return row ?? null;
  });
}

export const countSnapshots = async (db: Db, tenantId: string): Promise<number> => withTenant(db, tenantId, async tx => {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(snapshots).where(eq(snapshots.tenantId, tenantId));
  return row?.count ?? 0;
});
