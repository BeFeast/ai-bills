import { latestSnapshot } from './snapshot-store';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { historyPoints, journalRecords, subscriptionOverrides } from '@/db/schema';
import type { AppConfig } from './config';
import { getDb, withTenant, type Db } from './db';

/**
 * Tenancy phase 5: the database is the only store. Every reader takes the tenant scope; without a
 * configured database (or without a tenant) a read yields the empty snapshot and the stores are null,
 * and the callers say so instead of inventing data.
 */
/** Shaped so a TenantContext (which has `id`) can be passed straight in. */
export type Scope = { id: string | null };
const dbFor = (scope: Scope | undefined, env = process.env): { db: Db; tenantId: string } | null => {
  const db = scope?.id ? getDb(env) : null;
  return db && scope?.id ? { db, tenantId: scope.id } : null;
};

export type SnapshotRead = { body: unknown; version: string | null };
/** The tenant's newest stored snapshot; `version` (its receipt time) changes whenever the content does. */
export async function readSnapshot(_config: AppConfig | undefined, scope?: Scope): Promise<SnapshotRead> {
  const target = dbFor(scope);
  if (!target) return { body: {}, version: null };
  const row = await latestSnapshot(target.db, target.tenantId);
  return { body: row?.body ?? {}, version: row ? row.receivedAt.toISOString() : null };
}

// ---------------------------------------------------------------- journal

export type JournalRow = { recordId: string; record: unknown; observedAt: Date };
export type JournalStore = {
  configured: boolean;
  read(): Promise<{ rows: JournalRow[]; observedAt: string | null }>;
  /** Insert rows whose recordId is new; returns how many were added. Conflict detection is the caller's (accounting.ts). */
  add(rows: JournalRow[]): Promise<number>;
};

export function dbJournalStore(db: Db, tenantId: string): JournalStore {
  return {
    configured: true,
    async read() {
      const rows = await withTenant(db, tenantId, tx => tx.select({ recordId: journalRecords.recordId, record: journalRecords.record, observedAt: journalRecords.observedAt, createdAt: journalRecords.createdAt }).from(journalRecords).where(eq(journalRecords.tenantId, tenantId)).orderBy(journalRecords.createdAt));
      const newest = rows.reduce<Date | null>((best, row) => best && best > row.createdAt ? best : row.createdAt, null);
      return { rows: rows.map(({ recordId, record, observedAt }) => ({ recordId, record, observedAt })), observedAt: newest?.toISOString() ?? null };
    },
    async add(rows) {
      if (!rows.length) return 0;
      const inserted = await withTenant(db, tenantId, tx => tx.insert(journalRecords).values(rows.map(row => ({ tenantId, ...row }))).onConflictDoNothing().returning({ id: journalRecords.id }));
      return inserted.length;
    },
  };
}
/** The journal store for a scope when the database is the source; null means "use the file path as before". */
export const journalStoreFor = (scope?: Scope): JournalStore | null => { const target = dbFor(scope); return target ? dbJournalStore(target.db, target.tenantId) : null; };

// ---------------------------------------------------------------- subscription overrides

export type OverridesStore = { read(): Promise<Record<string, unknown>>; write(subscriptionId: string, override: unknown): Promise<void> };
export function dbOverridesStore(db: Db, tenantId: string): OverridesStore {
  return {
    async read() {
      const rows = await withTenant(db, tenantId, tx => tx.select({ id: subscriptionOverrides.subscriptionId, override: subscriptionOverrides.override }).from(subscriptionOverrides).where(eq(subscriptionOverrides.tenantId, tenantId)));
      return Object.fromEntries(rows.map(row => [row.id, row.override]));
    },
    async write(subscriptionId, override) {
      await withTenant(db, tenantId, tx => tx.insert(subscriptionOverrides).values({ tenantId, subscriptionId, override, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [subscriptionOverrides.tenantId, subscriptionOverrides.subscriptionId], set: { override, updatedAt: new Date() } }));
    },
  };
}
export const overridesStoreFor = (scope?: Scope): OverridesStore | null => { const target = dbFor(scope); return target ? dbOverridesStore(target.db, target.tenantId) : null; };

// ---------------------------------------------------------------- history

export type HistorySample = { at: Date; runpod: number | null; vast: number | null; estUsdToday: number | null };
export type HistoryStore = { last(): Promise<Date | null>; append(sample: HistorySample): Promise<void>; since(cutoff: Date, until: Date): Promise<HistorySample[]> };
export function dbHistoryStore(db: Db, tenantId: string): HistoryStore {
  return {
    async last() {
      const [row] = await withTenant(db, tenantId, tx => tx.select({ at: historyPoints.at }).from(historyPoints).where(eq(historyPoints.tenantId, tenantId)).orderBy(desc(historyPoints.at)).limit(1));
      return row?.at ?? null;
    },
    async append(sample) { await withTenant(db, tenantId, tx => tx.insert(historyPoints).values({ tenantId, ...sample })); },
    async since(cutoff, until) {
      return withTenant(db, tenantId, tx => tx.select({ at: historyPoints.at, runpod: historyPoints.runpod, vast: historyPoints.vast, estUsdToday: historyPoints.estUsdToday }).from(historyPoints)
        .where(and(eq(historyPoints.tenantId, tenantId), gte(historyPoints.at, cutoff), lte(historyPoints.at, until))).orderBy(historyPoints.at));
    },
  };
}
export const historyStoreFor = (scope?: Scope): HistoryStore | null => { const target = dbFor(scope); return target ? dbHistoryStore(target.db, target.tenantId) : null; };

// ---------------------------------------------------------------- operator

/** Cross-tenant read context for the operator screen: sets app.operator for one transaction. Never used on a write path. */
export async function withOperator<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.operator', 'on', true)`);
    return fn(tx as unknown as Db);
  });
}
