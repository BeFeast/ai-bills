import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, deviceTokens } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, withTenant, type Db } from '../src/lib/db';
import { issueDeviceToken, listDeviceTokens, revokeDeviceToken, tenantForDeviceDigest } from '../src/lib/device-tokens';
import { ensureIngestTokens, requireTenant, resetTenantCache, resolveTenant } from '../src/lib/tenant';

let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
vi.mock('../src/lib/db', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/db')>();
  return { ...original, getDb: () => db };
});

let pg: PGlite; let db: Db;
beforeAll(async () => {
  pg = new PGlite();
  const owner = drizzle(pg, { schema });
  await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER });
  await pg.exec(`SET ROLE ${APP_ROLE}`);
  db = owner as unknown as Db;
}, 60_000);
afterAll(async () => { await pg.close(); });

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const membershipEnv = { AI_BILLS_AUTH: 'clerk', DATABASE_URL: 'postgres://mocked', AI_BILLS_TENANT: 'oleg' };
async function inMembershipMode<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { AI_BILLS_AUTH: process.env.AI_BILLS_AUTH, DATABASE_URL: process.env.DATABASE_URL, AI_BILLS_TENANT: process.env.AI_BILLS_TENANT };
  Object.assign(process.env, membershipEnv);
  try { return await fn(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

describe('device tokens', () => {
  it('issues a token whose plaintext is returned once and only its digest is stored', async () => {
    const tenant = await ensureTenant(db, 'oleg');
    const issued = await issueDeviceToken(db, tenant.id, '  idunn  ');
    expect(issued.token).toMatch(/^zd_[A-Za-z0-9_-]{40,}$/);
    expect(issued.label).toBe('idunn');
    const rows = await withTenant(db, tenant.id, tx => tx.select().from(deviceTokens));
    expect(rows).toHaveLength(1);
    expect(rows[0].sha256).toBe(digest(issued.token));
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    const listed = await listDeviceTokens(db, tenant.id);
    expect(listed).toEqual([{ id: issued.id, label: 'idunn', createdAt: expect.any(String), lastUsedAt: null, revokedAt: null }]);
    expect(JSON.stringify(listed)).not.toContain('sha256');
  });

  it('resolves a presented token to its tenant, records the use, and forgets it once revoked', async () => {
    const tenant = await ensureTenant(db, 'oleg');
    const issued = await issueDeviceToken(db, tenant.id, 'slava');
    expect(await tenantForDeviceDigest(db, digest(issued.token))).toEqual({ id: tenant.id, slug: 'oleg' });
    expect((await listDeviceTokens(db, tenant.id)).find(row => row.id === issued.id)?.lastUsedAt).not.toBeNull();
    expect(await tenantForDeviceDigest(db, digest('zd_unknown'))).toBeNull();
    expect(await revokeDeviceToken(db, tenant.id, issued.id)).toBe(true);
    expect(await revokeDeviceToken(db, tenant.id, issued.id)).toBe(false);
    expect(await tenantForDeviceDigest(db, digest(issued.token))).toBeNull();
    expect((await listDeviceTokens(db, tenant.id)).find(row => row.id === issued.id)?.revokedAt).not.toBeNull();
  });

  it('keeps tenants apart: another tenant cannot list, revoke or write the token', async () => {
    const oleg = await ensureTenant(db, 'oleg');
    const partner = await ensureTenant(db, 'partner');
    const issued = await issueDeviceToken(db, oleg.id, 'laptop');
    expect((await listDeviceTokens(db, partner.id)).map(row => row.id)).not.toContain(issued.id);
    expect(await revokeDeviceToken(db, partner.id, issued.id)).toBe(false);
    const refused = await withTenant(db, partner.id, tx => tx.insert(deviceTokens).values({ tenantId: oleg.id, sha256: digest('zd_forged'), label: 'forged' })).catch((error: Error & { cause?: Error }) => error);
    expect(`${(refused as { cause?: Error })?.cause?.message ?? ''} ${(refused as Error)?.message ?? ''}`).toMatch(/row-level security/);
    expect(await tenantForDeviceDigest(db, digest('zd_forged'))).toBeNull();
    expect(await tenantForDeviceDigest(db, digest(issued.token))).toEqual({ id: oleg.id, slug: 'oleg' });
  });

  it('is a read-only credential: the widget route admits it, every other route and the ingest path refuse it', async () => {
    resetTenantCache();
    const tenant = await ensureTenant(db, 'oleg');
    const issued = await issueDeviceToken(db, tenant.id, 'desk');
    await ensureIngestTokens(db, tenant.id, [digest('zk_collector')]);
    requestHeaders = new Headers({ authorization: `Bearer ${issued.token}` });
    expect(await resolveTenant(membershipEnv)).toMatchObject({ id: tenant.id, slug: 'oleg', role: 'member', userId: null, access: 'device' });
    await inMembershipMode(async () => {
      const widget = await requireTenant({ device: true });
      expect(widget.forbidden).toBeNull(); expect(widget.tenant?.access).toBe('device');
      const other = await requireTenant();
      expect(other.tenant).toBeNull(); expect(other.forbidden?.status).toBe(403);
      expect(await other.forbidden!.json()).toMatchObject({ error: 'Forbidden' });
    });
    requestHeaders = new Headers({ authorization: 'Bearer zk_collector' });
    expect(await resolveTenant(membershipEnv)).toMatchObject({ id: tenant.id, access: 'ingest' });
    await inMembershipMode(async () => { expect((await requireTenant()).forbidden).toBeNull(); expect((await requireTenant({ device: true })).forbidden).toBeNull(); });
    requestHeaders = new Headers();
  });
});
