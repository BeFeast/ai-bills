import { desc, eq, sql } from 'drizzle-orm';
import { ingestTokens, memberships, quotaObservations, snapshots, tenants } from '@/db/schema';
import type { Db } from './db';
import { normalizeEmail, parseEmailList } from './hosted-auth';
import { withOperator } from './storage';
import type { TenantContext } from './tenant';

/** Platform operators are named by address in AI_BILLS_OPERATOR_EMAILS; without Clerk the single configured tenant's admin is the operator. */
export function isOperator(tenant: TenantContext, env: Record<string, string | undefined> = process.env): boolean {
  if (tenant.userId === null) return tenant.role === 'admin';
  return Boolean(tenant.email) && parseEmailList(env.AI_BILLS_OPERATOR_EMAILS).includes(normalizeEmail(tenant.email!));
}

export type OperatorTenantRow = {
  id: string; slug: string; name: string; createdAt: string; members: number; liveTokens: number;
  snapshots: number; lastReceivedAt: string | null; lastGeneratedAt: string | null;
  /** Latest observation per provider/account for the tenant, with whether the direct check succeeded. */
  sources: { provider: string; accountKey: string; observedAt: string; ok: boolean; source: string; status: number | null; error: string | null }[];
};

/** Everything the operator screen shows: one row per tenant, read under the operator context, never through a tenant's own context. */
export async function operatorOverview(db: Db, now = new Date()): Promise<{ generatedAt: string; tenants: OperatorTenantRow[] }> {
  const rows = await db.select().from(tenants).orderBy(tenants.createdAt);
  const members = await db.select({ tenantId: memberships.tenantId, count: sql<number>`count(*)::int` }).from(memberships).groupBy(memberships.tenantId);
  const tokens = await db.select({ tenantId: ingestTokens.tenantId, count: sql<number>`count(*) filter (where ${ingestTokens.revokedAt} is null)::int` }).from(ingestTokens).groupBy(ingestTokens.tenantId);
  const result = await withOperator(db, async tx => {
    const counts = await tx.select({ tenantId: snapshots.tenantId, count: sql<number>`count(*)::int`, lastReceived: sql<Date | null>`max(${snapshots.receivedAt})`, lastGenerated: sql<Date | null>`max(${snapshots.generatedAt})` }).from(snapshots).groupBy(snapshots.tenantId);
    const latest = await tx.selectDistinctOn([quotaObservations.tenantId, quotaObservations.provider, quotaObservations.accountKey], {
      tenantId: quotaObservations.tenantId, provider: quotaObservations.provider, accountKey: quotaObservations.accountKey, observedAt: quotaObservations.observedAt,
      ok: quotaObservations.ok, source: quotaObservations.source, status: quotaObservations.status, error: quotaObservations.error,
    }).from(quotaObservations).orderBy(quotaObservations.tenantId, quotaObservations.provider, quotaObservations.accountKey, desc(quotaObservations.observedAt));
    return { counts, latest };
  });
  const by = <T extends { tenantId: string }>(list: T[]) => new Map(list.map(row => [row.tenantId, row]));
  const memberCount = by(members); const tokenCount = by(tokens); const snapshotCount = by(result.counts);
  const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
  return {
    generatedAt: now.toISOString(),
    tenants: rows.map(tenant => ({
      id: tenant.id, slug: tenant.slug, name: tenant.name, createdAt: tenant.createdAt.toISOString(),
      members: memberCount.get(tenant.id)?.count ?? 0, liveTokens: tokenCount.get(tenant.id)?.count ?? 0,
      snapshots: snapshotCount.get(tenant.id)?.count ?? 0, lastReceivedAt: iso(snapshotCount.get(tenant.id)?.lastReceived), lastGeneratedAt: iso(snapshotCount.get(tenant.id)?.lastGenerated),
      sources: result.latest.filter(row => row.tenantId === tenant.id).map(row => ({ provider: row.provider, accountKey: row.accountKey, observedAt: row.observedAt.toISOString(), ok: row.ok, source: row.source, status: row.status, error: row.error })),
    })),
  };
}

/** Tenant rows are readable by any member (policy `tenants_read`); this is the operator-only detail behind `eq` on id, used by tests. */
export const tenantById = (db: Db, id: string) => db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
