import { and, eq, isNull } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { ingestTokens, memberships } from '@/db/schema';
import { defaultTenantSlug, ensureTenant, getDb, withTenant, type Db } from './db';
import { IDENTITY_HEADERS, authMode, authorizeEmail, membershipMode, normalizeEmail, parseEmailList } from './hosted-auth';

/**
 * Who the request is for. `id` is the tenant row when a database is configured; `null` keeps the
 * file-backed instance working exactly as before (self-host, or hosted without DATABASE_URL).
 */
export type TenantContext = { id: string | null; slug: string; role: 'admin' | 'member'; userId: string | null; email: string | null };
export type TenantDenied = { denied: true; reason: 'no-identity' | 'not-a-member'; email: string | null };

const MEMBERSHIP_TTL_MS = 60_000;
/** Above this many distinct users in one TTL window the oldest entries go first; the map never grows past it. */
const MEMBERSHIP_CACHE_MAX = 1000;
const membershipCache = new Map<string, { at: number; value: TenantContext | TenantDenied }>();
/** Test hook. */
export const resetTenantCache = () => membershipCache.clear();
export const membershipCacheSize = () => membershipCache.size;
/** Insert order is age order (a re-cached user is deleted first), so expiry and the size cap both walk from the front. */
function rememberMembership(userId: string, value: TenantContext | TenantDenied, now = Date.now()) {
  for (const [key, entry] of membershipCache) { if (now - entry.at >= MEMBERSHIP_TTL_MS) membershipCache.delete(key); else break; }
  membershipCache.delete(userId);
  membershipCache.set(userId, { at: now, value });
  while (membershipCache.size > MEMBERSHIP_CACHE_MAX) membershipCache.delete(membershipCache.keys().next().value!);
}

/**
 * Membership for a Clerk user: the row in `memberships`, or — for an address the instance's allow
 * list (or admin list) names — a membership created now in the default tenant. That is how the
 * allow list is adopted into the database without a manual step; an empty allow list stays open,
 * as it always did, so a deploy without the variable cannot lock the operator out.
 */
export async function membershipFor(db: Db, userId: string, email: string | null, env: Record<string, string | undefined> = process.env): Promise<TenantContext | TenantDenied> {
  const rows = await db.select({ tenantId: memberships.tenantId, role: memberships.role }).from(memberships).where(eq(memberships.clerkUserId, userId)).limit(1);
  const tenantOf = async (tenantId: string) => (await db.query.tenants.findFirst({ where: (t, { eq: equal }) => equal(t.id, tenantId), columns: { slug: true } }))?.slug ?? 'unknown';
  if (rows[0]) return { id: rows[0].tenantId, slug: await tenantOf(rows[0].tenantId), role: rows[0].role, userId, email };
  const verdict = authorizeEmail(email, parseEmailList(env.AI_BILLS_ALLOWED_EMAILS), parseEmailList(env.AI_BILLS_ADMIN_EMAILS));
  if (!verdict.allowed) return { denied: true, reason: email ? 'not-a-member' : 'no-identity', email };
  const tenant = await ensureTenant(db, defaultTenantSlug(env));
  const role = verdict.admin ? 'admin' : 'member';
  await withTenant(db, tenant.id, tx => tx.insert(memberships).values({ tenantId: tenant.id, clerkUserId: userId, email: normalizeEmail(email ?? ''), role }).onConflictDoNothing());
  console.info(`[zecori] adopted ${email} from the allow list into tenant ${tenant.slug} as ${role}`);
  return { id: tenant.id, slug: tenant.slug, role, userId, email };
}

/** The tenant of the current request (Node side). Public paths never call this; the middleware has already required a session. */
export async function resolveTenant(env: Record<string, string | undefined> = process.env): Promise<TenantContext | TenantDenied> {
  const db = getDb(env);
  if (authMode(env) !== 'clerk' || !membershipMode(env) || !db) {
    // File-backed or allow-list mode: one tenant, decided by configuration, not by the person.
    const slug = defaultTenantSlug(env);
    const tenant = db ? await ensureTenant(db, slug) : null;
    return { id: tenant?.id ?? null, slug, role: 'admin', userId: null, email: null };
  }
  const incoming = await headers();
  const userId = incoming.get(IDENTITY_HEADERS.userId);
  const email = incoming.get(IDENTITY_HEADERS.email);
  if (!userId) return { denied: true, reason: 'no-identity', email };
  const cached = membershipCache.get(userId);
  if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) return cached.value;
  const value = await membershipFor(db, userId, email, env);
  rememberMembership(userId, value);
  return value;
}

export const isDenied = (value: TenantContext | TenantDenied): value is TenantDenied => 'denied' in value;

/** For API routes: the tenant, or the 403 to return. Every non-public route calls this first (tests/tenancy-routes.test.ts enforces it). */
export async function requireTenant(): Promise<{ tenant: TenantContext; forbidden: null } | { tenant: null; forbidden: NextResponse }> {
  const resolved = await resolveTenant();
  if (isDenied(resolved)) return { tenant: null, forbidden: NextResponse.json({ error: 'Forbidden', account: resolved.email ?? undefined }, { status: 403, headers: { 'cache-control': 'no-store' } }) };
  return { tenant: resolved, forbidden: null };
}

/**
 * The tenant an ingest token belongs to: a live row in `ingest_tokens` by digest. Tokens configured
 * in the environment are adopted into that table at boot for the default tenant (ensureIngestTokens),
 * so the collector keeps working through the migration without a manual step.
 */
export async function tenantForIngestDigest(db: Db, digest: string): Promise<{ id: string; slug: string } | null> {
  const [row] = await db.select({ tenantId: ingestTokens.tenantId, id: ingestTokens.id }).from(ingestTokens).where(and(eq(ingestTokens.sha256, digest), isNull(ingestTokens.revokedAt))).limit(1);
  if (!row) return null;
  const tenant = await db.query.tenants.findFirst({ where: (t, { eq: equal }) => equal(t.id, row.tenantId), columns: { id: true, slug: true } });
  if (!tenant) return null;
  await withTenant(db, tenant.id, tx => tx.update(ingestTokens).set({ lastUsedAt: new Date() }).where(eq(ingestTokens.id, row.id)));
  return tenant;
}

export async function ensureIngestTokens(db: Db, tenantId: string, digests: string[]): Promise<number> {
  if (!digests.length) return 0;
  const inserted = await withTenant(db, tenantId, tx => tx.insert(ingestTokens).values(digests.map(sha256 => ({ tenantId, sha256, label: 'env' }))).onConflictDoNothing().returning({ id: ingestTokens.id }));
  return inserted.length;
}
