import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, memberships, ingestTokens } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, withTenant, type Db } from '../src/lib/db';
import { ensureIngestTokens, isDenied, membershipFor, tenantForIngestDigest } from '../src/lib/tenant';
import { IDENTITY_HEADERS, membershipMode, stripIdentityHeaders } from '../src/lib/hosted-auth';

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

let pg: PGlite; let db: Db;
beforeAll(async () => {
  pg = new PGlite();
  const owner = drizzle(pg, { schema });
  await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER });
  await pg.exec(`SET ROLE ${APP_ROLE}`);
  db = owner as unknown as Db;
}, 60_000);
afterAll(async () => { await pg.close(); });

describe('membership mode', () => {
  it('is on only with Clerk and a database', () => {
    expect(membershipMode({ AI_BILLS_AUTH: 'clerk', DATABASE_URL: 'postgres://x' })).toBe(true);
    expect(membershipMode({ AI_BILLS_AUTH: 'clerk' })).toBe(false);
    expect(membershipMode({ DATABASE_URL: 'postgres://x' })).toBe(false);
  });
  it('drops identity headers a caller tries to present', () => {
    const clean = stripIdentityHeaders(new Headers({ [IDENTITY_HEADERS.userId]: 'user_evil', [IDENTITY_HEADERS.email]: 'evil@example.test', 'x-zecori-denied-email': 'x', accept: 'application/json' }));
    expect(clean.get(IDENTITY_HEADERS.userId)).toBeNull(); expect(clean.get(IDENTITY_HEADERS.email)).toBeNull(); expect(clean.get('x-zecori-denied-email')).toBeNull();
    expect(clean.get('accept')).toBe('application/json');
  });
});

describe('membership decides the tenant', () => {
  const env = { AI_BILLS_TENANT: 'oleg', AI_BILLS_ALLOWED_EMAILS: 'owner@example.test, second@example.test', AI_BILLS_ADMIN_EMAILS: 'owner@example.test' };

  it('adopts an allow-listed address into the default tenant once, with the role the lists give it', async () => {
    const first = await membershipFor(db, 'user_owner', 'Owner@Example.test', env);
    expect(isDenied(first)).toBe(false);
    if (isDenied(first)) return;
    expect(first).toMatchObject({ slug: 'oleg', role: 'admin', userId: 'user_owner' });
    const again = await membershipFor(db, 'user_owner', 'owner@example.test', { ...env, AI_BILLS_ALLOWED_EMAILS: '' });
    expect(again).toMatchObject({ id: first.id, role: 'admin' });
    const rows = await withTenant(db, first.id!, tx => tx.select().from(memberships));
    expect(rows.map(row => [row.clerkUserId, row.email, row.role])).toEqual([['user_owner', 'owner@example.test', 'admin']]);
    const member = await membershipFor(db, 'user_second', 'second@example.test', env);
    expect(member).toMatchObject({ id: first.id, role: 'member' });
  });

  it('denies a signed-in stranger by name and a session without an address, and never creates a row for them', async () => {
    const stranger = await membershipFor(db, 'user_stranger', 'stranger@example.test', env);
    expect(stranger).toEqual({ denied: true, reason: 'not-a-member', email: 'stranger@example.test' });
    const anonymous = await membershipFor(db, 'user_ghost', null, env);
    expect(anonymous).toEqual({ denied: true, reason: 'no-identity', email: null });
    const tenant = await ensureTenant(db, 'oleg');
    const rows = await withTenant(db, tenant.id, tx => tx.select({ user: memberships.clerkUserId }).from(memberships));
    expect(rows.map(row => row.user)).not.toContain('user_stranger');
  });

  it('follows an existing membership over the allow list, so a revoked list entry does not re-admit and a listed address does not move tenants', async () => {
    const other = await ensureTenant(db, 'other');
    await withTenant(db, other.id, tx => tx.insert(memberships).values({ tenantId: other.id, clerkUserId: 'user_moved', email: 'moved@example.test', role: 'member' }));
    const resolved = await membershipFor(db, 'user_moved', 'moved@example.test', { ...env, AI_BILLS_ALLOWED_EMAILS: 'moved@example.test' });
    expect(resolved).toMatchObject({ id: other.id, slug: 'other', role: 'member' });
  });

  it('keeps an empty allow list open, as the allow list always did', async () => {
    const open = await membershipFor(db, 'user_open', 'anyone@example.test', { AI_BILLS_TENANT: 'oleg' });
    expect(open).toMatchObject({ slug: 'oleg', role: 'member' });
  });
});

describe('ingest tokens decide the tenant', () => {
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');
  it('adopts environment digests for the default tenant once and resolves a presented token to its tenant', async () => {
    const tenant = await ensureTenant(db, 'oleg');
    expect(await ensureIngestTokens(db, tenant.id, [digest('zk_one'), digest('zk_two')])).toBe(2);
    expect(await ensureIngestTokens(db, tenant.id, [digest('zk_one')])).toBe(0);
    expect(await tenantForIngestDigest(db, digest('zk_one'))).toEqual({ id: tenant.id, slug: 'oleg' });
    expect(await tenantForIngestDigest(db, digest('zk_unknown'))).toBeNull();
    const rows = await withTenant(db, tenant.id, tx => tx.select({ sha256: ingestTokens.sha256, used: ingestTokens.lastUsedAt, label: ingestTokens.label }).from(ingestTokens));
    const row = rows.find(candidate => candidate.sha256 === digest('zk_one'))!;
    expect(rows.find(candidate => candidate.sha256 === digest('zk_two'))?.used).toBeNull();
    expect(row.used).not.toBeNull(); expect(row.label).toBe('env');
  });
  it('ignores a revoked token', async () => {
    const tenant = await ensureTenant(db, 'oleg');
    await withTenant(db, tenant.id, tx => tx.insert(ingestTokens).values({ tenantId: tenant.id, sha256: digest('zk_old'), label: 'rotated', revokedAt: new Date() }));
    expect(await tenantForIngestDigest(db, digest('zk_old'))).toBeNull();
  });
  it('resolves a partner token to the partner tenant, never to the default one', async () => {
    const partner = await ensureTenant(db, 'partner');
    await ensureIngestTokens(db, partner.id, [digest('zk_partner')]);
    expect(await tenantForIngestDigest(db, digest('zk_partner'))).toEqual({ id: partner.id, slug: 'partner' });
  });
});
