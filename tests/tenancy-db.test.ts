import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { schema, snapshots, quotaObservations } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, withTenant, type Db } from '../src/lib/db';
import { SNAPSHOT_RETENTION, countSnapshots, latestSnapshot, quotaObservationsFrom, storeSnapshot } from '../src/lib/snapshot-store';

/** A real Postgres (PGlite) with the repo's migrations applied, then the application role: RLS is exercised exactly as in production. */
let pg: PGlite; let db: Db;
beforeAll(async () => {
  pg = new PGlite();
  const owner = drizzle(pg, { schema });
  await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER });
  await pg.exec(`SET ROLE ${APP_ROLE}`);
  db = owner as unknown as Db;
}, 60_000);
afterAll(async () => { await pg.close(); });

const claudeEntry = (fetchedAt: string, extra: Record<string, unknown> = {}) => ({ ok: true, status: 200, fetched_at: fetchedAt, source: 'direct', data: { five_hour: { utilization: 4, resets_at: '2026-09-21T13:00:00Z' } }, ...extra });
const snapshot = (generated: string, fetchedAt = generated) => {
  const entry = claudeEntry(fetchedAt);
  return JSON.stringify({ generated, claude_usage: { '0123456789abcdef01234567': entry, 'work@example.test': entry }, codex_usage: {} });
};

describe('quotaObservationsFrom', () => {
  it('stores each observation once under its email key, keeps identities without an alias, and carries fallback provenance', () => {
    const entry = claudeEntry('2026-09-21T08:35:04+00:00');
    const orphan = { ok: false, status: 429, fetched_at: '2026-09-21T08:35:05+00:00', error: 'Proxy quota request rejected (HTTP 429)' };
    const fallback = { ok: true, status: null, fetched_at: '2026-09-21T08:31:00+00:00', source: 'proxy_headers', direct: { status: 429 }, data: { rate_limit: {} } };
    const rows = quotaObservationsFrom({ claude_usage: { aaaaaaaaaaaaaaaaaaaaaaaa: entry, 'a@example.test': entry, bbbbbbbbbbbbbbbbbbbbbbbb: orphan }, codex_usage: { 'c@example.test': fallback, broken: { fetched_at: 'nope' } } });
    expect(rows.map(row => [row.provider, row.accountKey, row.ok, row.status, row.source])).toEqual([
      ['claude', 'a@example.test', true, 200, 'direct'], ['claude', 'bbbbbbbbbbbbbbbbbbbbbbbb', false, 429, 'direct'], ['codex', 'c@example.test', true, null, 'proxy_headers']]);
    expect(rows[1].windows).toBeNull(); expect(rows[1].error).toContain('429');
    expect(rows[2].direct).toEqual({ status: 429 }); expect(rows[2].windows).toEqual({ rate_limit: {} });
    expect(quotaObservationsFrom(null)).toEqual([]); expect(quotaObservationsFrom({ claude_usage: 'x' })).toEqual([]);
  });
});

describe('tenancy database', () => {
  it('creates the default tenant once and reuses it', async () => {
    const a = await ensureTenant(db, 'default', 'Default');
    const again = await ensureTenant(db, 'default');
    expect(again.id).toBe(a.id);
    expect((await db.select().from(schema.tenants)).map(row => row.slug)).toEqual(['default']);
  });

  it('stores a snapshot with its observations, deduplicates unchanged observations and prunes to the retention', async () => {
    const tenant = await ensureTenant(db, 'store-test');
    // Receipt times are fixed so the ordering assertions below do not depend on the wall clock.
    const first = await storeSnapshot(db, tenant.id, snapshot('2026-09-21T08:35:30Z', '2026-09-21T08:35:04+00:00'), '2026-09-21T08:35:30Z', new Date('2026-09-21T08:35:31Z'));
    expect(first.observations).toBe(1);
    // The collector re-sends an unchanged observation with the next snapshot: same observation time, nothing new to record.
    const second = await storeSnapshot(db, tenant.id, snapshot('2026-09-21T08:40:30Z', '2026-09-21T08:35:04+00:00'), '2026-09-21T08:40:30Z', new Date('2026-09-21T08:40:31Z'));
    expect(second.observations).toBe(0);
    expect(await countSnapshots(db, tenant.id)).toBe(2);
    for (let i = 0; i < SNAPSHOT_RETENTION + 3; i++) {
      const at = new Date(Date.parse('2026-09-21T09:00:00Z') + i * 300_000);
      await storeSnapshot(db, tenant.id, snapshot(at.toISOString()), at.toISOString(), at);
    }
    expect(await countSnapshots(db, tenant.id)).toBe(SNAPSHOT_RETENTION);
    const latest = await latestSnapshot(db, tenant.id);
    expect(latest?.generatedAt.toISOString()).toBe(new Date(Date.parse('2026-09-21T09:00:00Z') + (SNAPSHOT_RETENTION + 2) * 300_000).toISOString());
    // Observations outlive the pruned snapshot bodies.
    const kept = await withTenant(db, tenant.id, tx => tx.select({ n: sql<number>`count(*)::int` }).from(quotaObservations));
    expect(kept[0].n).toBe(1 + SNAPSHOT_RETENTION + 3);
  });

  it('never shows one tenant the rows of another, in either direction, and shows nothing without a tenant context', async () => {
    const a = await ensureTenant(db, 'tenant-a'); const b = await ensureTenant(db, 'tenant-b');
    await storeSnapshot(db, a.id, snapshot('2026-09-21T10:00:00Z'), '2026-09-21T10:00:00Z');
    await storeSnapshot(db, b.id, snapshot('2026-09-21T10:01:00Z'), '2026-09-21T10:01:00Z');
    const seenByA = await withTenant(db, a.id, tx => tx.select({ tenantId: snapshots.tenantId }).from(snapshots));
    const seenByB = await withTenant(db, b.id, tx => tx.select({ tenantId: snapshots.tenantId }).from(snapshots));
    expect(new Set(seenByA.map(row => row.tenantId))).toEqual(new Set([a.id]));
    expect(new Set(seenByB.map(row => row.tenantId))).toEqual(new Set([b.id]));
    expect((await withTenant(db, a.id, tx => tx.select().from(quotaObservations))).every(row => row.tenantId === a.id)).toBe(true);
    // No context at all: the application role sees no tenant data, even though the rows exist.
    expect(await db.select().from(snapshots)).toEqual([]);
    expect(await db.select().from(quotaObservations)).toEqual([]);
    // A row for tenant B written under tenant A's context is refused by the policy, not silently accepted.
    const refused = await withTenant(db, a.id, tx => tx.insert(snapshots).values({ tenantId: b.id, generatedAt: new Date(), bytes: 2, body: {} })).then(() => null, (error: Error & { cause?: Error }) => error);
    expect(refused).not.toBeNull();
    expect(`${refused?.cause?.message ?? ''} ${refused?.message ?? ''}`).toMatch(/row-level security/);
    expect((await withTenant(db, b.id, tx => tx.select().from(snapshots))).length).toBe(1);
    // Cross-tenant reads by primary key are refused as well.
    const [bRow] = await withTenant(db, b.id, tx => tx.select({ id: snapshots.id }).from(snapshots));
    expect(await withTenant(db, a.id, tx => tx.select().from(snapshots).where(sql`${snapshots.id} = ${bRow.id}`))).toEqual([]);
  });
});
