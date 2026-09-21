import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, journalRecords } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, withTenant, type Db } from '../src/lib/db';
import { storeSnapshot } from '../src/lib/snapshot-store';
import { dbHistoryStore, dbJournalStore, dbOverridesStore, readSnapshot, storageMode, withOperator } from '../src/lib/storage';
import { appendFinancialRecordsTo, journalRecordsFromRows } from '../src/lib/accounting';
import { readSeries, recordHistory } from '../src/lib/history';
import { operatorOverview, isOperator } from '../src/lib/operator';
import type { AppConfig } from '../src/lib/config';
import type { BillingSnapshot } from '../src/lib/billing';

let pg: PGlite; let db: Db;
vi.mock('../src/lib/db', async importOriginal => ({ ...(await importOriginal<typeof import('../src/lib/db')>()), getDb: () => db }));

const dir = mkdtempSync(join(tmpdir(), 'zecori-storage-'));
const config = { billing: { snapshot_path: join(dir, 'snapshot.json'), history_path: join(dir, 'history.jsonl') }, accounting: {}, accounts: [], server: { timezone: 'UTC' } } as unknown as AppConfig;

beforeAll(async () => {
  pg = new PGlite();
  const owner = drizzle(pg, { schema });
  await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER });
  await pg.exec(`SET ROLE ${APP_ROLE}`);
  db = owner as unknown as Db;
}, 60_000);
afterAll(async () => { await pg.close(); });

const record = (id: string, amount: number) => ({ sourceId: 'manual', sourceRecordId: id, accountId: 'acct', provider: 'anthropic', kind: 'payment', amount, currency: 'USD', date: '2026-09-10' });

describe('storage mode', () => {
  it('reads from the database only when asked and a database exists', () => {
    expect(storageMode({ AI_BILLS_STORAGE: 'db', DATABASE_URL: 'postgres://x' })).toBe('db');
    expect(storageMode({ AI_BILLS_STORAGE: 'db' })).toBe('file');
    expect(storageMode({ DATABASE_URL: 'postgres://x' })).toBe('file');
  });
});

describe('snapshot source', () => {
  it('serves each tenant its own newest snapshot in db mode and the file otherwise', async () => {
    process.env.AI_BILLS_STORAGE = 'db'; process.env.DATABASE_URL = 'postgres://mocked';
    const a = await ensureTenant(db, 'read-a'); const b = await ensureTenant(db, 'read-b');
    await storeSnapshot(db, a.id, JSON.stringify({ generated: '2026-09-21T10:00:00Z', marker: 'a-old' }), '2026-09-21T10:00:00Z', new Date('2026-09-21T10:00:30Z'));
    await storeSnapshot(db, a.id, JSON.stringify({ generated: '2026-09-21T10:05:00Z', marker: 'a-new' }), '2026-09-21T10:05:00Z', new Date('2026-09-21T10:05:30Z'));
    await storeSnapshot(db, b.id, JSON.stringify({ generated: '2026-09-21T10:01:00Z', marker: 'b' }), '2026-09-21T10:01:00Z', new Date('2026-09-21T10:01:30Z'));
    const readA = await readSnapshot(config, { id: a.id }); const readB = await readSnapshot(config, { id: b.id });
    expect((readA.body as { marker: string }).marker).toBe('a-new'); expect(readA.source).toBe('db'); expect(readA.version).toBe('2026-09-21T10:05:30.000Z');
    expect((readB.body as { marker: string }).marker).toBe('b');
    const empty = await readSnapshot(config, { id: (await ensureTenant(db, 'read-empty')).id });
    expect(empty).toEqual({ body: {}, version: null, source: 'db' });
    // File mode, or no tenant: the file as before, with its mtime as the version.
    writeFileSync(config.billing.snapshot_path, JSON.stringify({ generated: 'x', marker: 'file' }));
    expect(((await readSnapshot(config, { id: null })).body as { marker: string }).marker).toBe('file');
    process.env.AI_BILLS_STORAGE = 'file';
    const fromFile = await readSnapshot(config, { id: a.id });
    expect((fromFile.body as { marker: string }).marker).toBe('file'); expect(fromFile.source).toBe('file'); expect(fromFile.version).not.toBeNull();
    delete process.env.DATABASE_URL;
  });
});

describe('journal store', () => {
  it('keeps each tenant its own records, deduplicates on the record id and reports conflicts like the file did', async () => {
    const a = await ensureTenant(db, 'journal-a'); const b = await ensureTenant(db, 'journal-b');
    const storeA = dbJournalStore(db, a.id); const storeB = dbJournalStore(db, b.id);
    expect(await appendFinancialRecordsTo(storeA, [record('r1', 10), record('r2', 20)])).toEqual({ inserted: 2, duplicates: 0 });
    expect(await appendFinancialRecordsTo(storeA, [record('r2', 20), record('r3', 30)])).toEqual({ inserted: 1, duplicates: 1 });
    await expect(appendFinancialRecordsTo(storeA, [record('r1', 99)])).rejects.toThrow(/Conflicting/);
    expect(await appendFinancialRecordsTo(storeB, [record('r1', 1)])).toEqual({ inserted: 1, duplicates: 0 });
    const readA = await storeA.read(); const readB = await storeB.read();
    expect(journalRecordsFromRows(readA.rows).map(row => [row.sourceRecordId, row.amount])).toEqual([['r1', 10], ['r2', 20], ['r3', 30]]);
    expect(journalRecordsFromRows(readB.rows).map(row => [row.sourceRecordId, row.amount])).toEqual([['r1', 1]]);
    expect(readA.observedAt).not.toBeNull();
    // Without a tenant context the application role sees no journal at all.
    expect(await db.select().from(journalRecords)).toEqual([]);
  });
});

describe('subscription overrides store', () => {
  it('upserts per tenant and never shows another tenant an override', async () => {
    const a = await ensureTenant(db, 'ovr-a'); const b = await ensureTenant(db, 'ovr-b');
    const storeA = dbOverridesStore(db, a.id); const storeB = dbOverridesStore(db, b.id);
    await storeA.write('sub-1', { amount: 20, updatedAt: '2026-09-21T10:00:00Z' });
    await storeA.write('sub-1', { amount: 25, updatedAt: '2026-09-21T10:01:00Z' });
    await storeB.write('sub-1', { amount: 5, updatedAt: '2026-09-21T10:02:00Z' });
    expect(await storeA.read()).toEqual({ 'sub-1': { amount: 25, updatedAt: '2026-09-21T10:01:00Z' } });
    expect(await storeB.read()).toEqual({ 'sub-1': { amount: 5, updatedAt: '2026-09-21T10:02:00Z' } });
  });
});

describe('history store', () => {
  const billing = (runpod: number) => ({ balances: [{ provider: 'RunPod', balanceUsd: runpod }], summary: { meteredSpendTodayUsd: 1.5 } } as unknown as BillingSnapshot);
  it('throttles samples, averages per day and stays inside the tenant', async () => {
    const a = await ensureTenant(db, 'hist-a'); const b = await ensureTenant(db, 'hist-b');
    const storeA = dbHistoryStore(db, a.id); const storeB = dbHistoryStore(db, b.id);
    const day1 = Date.parse('2026-09-20T10:00:00Z'); const day2 = Date.parse('2026-09-21T10:00:00Z');
    expect(await recordHistory(billing(10), { store: storeA, now: day1 })).toBeNull();
    expect(await recordHistory(billing(30), { store: storeA, now: day1 + 5 * 60_000 })).toBeNull(); // throttled: within 30 minutes
    expect(await recordHistory(billing(20), { store: storeA, now: day1 + 60 * 60_000 })).toBeNull();
    expect(await recordHistory(billing(40), { store: storeA, now: day2 })).toBeNull();
    expect(await recordHistory(billing(99), { store: storeB, now: day2 })).toBeNull();
    expect(await readSeries('runpod', 30, { store: storeA, now: day2 + 1000 })).toEqual([15, 40]);
    expect(await readSeries('est_usd_today', 30, { store: storeA, now: day2 + 1000 })).toEqual([1.5, 1.5]);
    expect(await readSeries('runpod', 30, { store: storeB, now: day2 + 1000 })).toEqual([99]);
  });
});

describe('operator context', () => {
  it('lets the operator read every tenant while a tenant context still sees only its own rows', async () => {
    const a = await ensureTenant(db, 'op-a'); const b = await ensureTenant(db, 'op-b');
    const obs = { ok: true, status: 200, fetched_at: '2026-09-21T11:00:00+00:00', source: 'direct', data: { five_hour: { utilization: 1 } } };
    await storeSnapshot(db, a.id, JSON.stringify({ generated: '2026-09-21T11:00:30Z', claude_usage: { 'a@example.test': obs } }), '2026-09-21T11:00:30Z');
    await storeSnapshot(db, b.id, JSON.stringify({ generated: '2026-09-21T11:01:30Z', claude_usage: { 'b@example.test': { ...obs, ok: false, status: 429, error: 'rate limited' } } }), '2026-09-21T11:01:30Z');
    const overview = await operatorOverview(db, new Date('2026-09-21T11:05:00Z'));
    const rows = new Map(overview.tenants.map(row => [row.slug, row]));
    expect(rows.get('op-a')).toMatchObject({ snapshots: 1, sources: [{ provider: 'claude', accountKey: 'a@example.test', ok: true }] });
    expect(rows.get('op-b')).toMatchObject({ snapshots: 1, sources: [{ provider: 'claude', accountKey: 'b@example.test', ok: false, status: 429, error: 'rate limited' }] });
    // The operator context is read-only: a write under it is still refused by the tenant policies.
    const refused = await withOperator(db, tx => tx.insert(schema.snapshots).values({ tenantId: a.id, generatedAt: new Date(), bytes: 1, body: {} })).then(() => null, (error: Error) => error);
    expect(refused).not.toBeNull();
    // A tenant context is unchanged by the operator policy.
    expect((await withTenant(db, a.id, tx => tx.select({ id: schema.snapshots.tenantId }).from(schema.snapshots))).every(row => row.id === a.id)).toBe(true);
  });
  it('recognises the operator by address in Clerk mode and by the single admin without Clerk', () => {
    const env = { AI_BILLS_OPERATOR_EMAILS: 'oleg@example.test' };
    expect(isOperator({ id: 'x', slug: 'oleg', role: 'admin', userId: 'u1', email: 'Oleg@Example.test' }, env)).toBe(true);
    expect(isOperator({ id: 'x', slug: 'oleg', role: 'admin', userId: 'u2', email: 'other@example.test' }, env)).toBe(false);
    expect(isOperator({ id: null, slug: 'default', role: 'admin', userId: null, email: null }, env)).toBe(true);
  });
});
