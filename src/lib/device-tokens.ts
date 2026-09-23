import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { deviceTokens } from '@/db/schema';
import { getDb, withTenant, type Db } from './db';
import type { TenantContext } from './tenant';

/**
 * Device tokens: a read-only credential a desktop widget holds to ask `GET /api/widget` for the tenant's
 * limits and today's spend. They are minted here and only their SHA-256 is stored, exactly like ingest
 * tokens; unlike ingest tokens they can neither ingest nor reach any other route (see requireTenant).
 */
export type DeviceTokenRow = { id: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

export const DEVICE_TOKEN_PREFIX = 'zd_';
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');

/** A fresh token for the tenant. The plaintext is returned once and never stored. */
export async function issueDeviceToken(db: Db, tenantId: string, label: string): Promise<{ id: string; label: string; token: string }> {
  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const clean = label.trim().slice(0, 64);
  const [row] = await withTenant(db, tenantId, tx => tx.insert(deviceTokens).values({ tenantId, sha256: tokenDigest(token), label: clean }).returning({ id: deviceTokens.id }));
  return { id: row.id, label: clean, token };
}

/** The tenant's own tokens. The SELECT policy is open (digests resolve before a context exists), so the tenant filter is explicit here. */
export async function listDeviceTokens(db: Db, tenantId: string): Promise<DeviceTokenRow[]> {
  const rows = await withTenant(db, tenantId, tx => tx.select({ id: deviceTokens.id, label: deviceTokens.label, createdAt: deviceTokens.createdAt, lastUsedAt: deviceTokens.lastUsedAt, revokedAt: deviceTokens.revokedAt }).from(deviceTokens).where(eq(deviceTokens.tenantId, tenantId)).orderBy(deviceTokens.createdAt));
  return rows.map(row => ({ id: row.id, label: row.label, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null }));
}

/** Revoke by id; the row stays so the label and last use remain visible. Returns false when the tenant has no live token with that id. */
export async function revokeDeviceToken(db: Db, tenantId: string, id: string): Promise<boolean> {
  const updated = await withTenant(db, tenantId, tx => tx.update(deviceTokens).set({ revokedAt: new Date() }).where(and(eq(deviceTokens.id, id), eq(deviceTokens.tenantId, tenantId), isNull(deviceTokens.revokedAt))).returning({ id: deviceTokens.id }));
  return updated.length > 0;
}

/** The tenant a presented device token belongs to (a live row by digest), recording the use; null for anything else. */
export async function tenantForDeviceDigest(db: Db, digest: string): Promise<{ id: string; slug: string } | null> {
  const [row] = await db.select({ tenantId: deviceTokens.tenantId, id: deviceTokens.id }).from(deviceTokens).where(and(eq(deviceTokens.sha256, digest), isNull(deviceTokens.revokedAt))).limit(1);
  if (!row) return null;
  const tenant = await db.query.tenants.findFirst({ where: (t, { eq: equal }) => equal(t.id, row.tenantId), columns: { id: true, slug: true } });
  if (!tenant) return null;
  await withTenant(db, tenant.id, tx => tx.update(deviceTokens).set({ lastUsedAt: new Date() }).where(eq(deviceTokens.id, row.id)));
  return tenant;
}

/** Only a signed-in admin of the tenant manages device tokens; no bearer of any kind does, and there is nothing to manage without a database. */
export function deviceTokenGate(tenant: TenantContext): NextResponse | null {
  const headers = { 'cache-control': 'no-store' };
  if (tenant.access !== 'session' || tenant.role !== 'admin') return NextResponse.json({ error: 'Forbidden', reason: 'Device tokens are managed by a signed-in tenant admin' }, { status: 403, headers });
  if (!tenant.id || !getDb()) return NextResponse.json({ error: 'Device tokens need a database' }, { status: 503, headers });
  return null;
}
