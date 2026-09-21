import { sql, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { join } from 'node:path';
import { schema, tenants } from '@/db/schema';

/** Any drizzle Postgres database (postgres.js in production, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');
export const APP_ROLE = 'zecori_app';

/** The database is optional until phase 3 of the tenancy migration: without DATABASE_URL the file path alone serves the instance. */
export const dbEnabled = (env: Record<string, string | undefined> = process.env) => Boolean(env.DATABASE_URL);

let client: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;

/** Lazily connected application database, or null when none is configured. The app role must not bypass RLS. */
export function getDb(env: Record<string, string | undefined> = process.env): Db | null {
  if (!env.DATABASE_URL) return null;
  if (!db) {
    client = postgres(env.DATABASE_URL, { max: 4, idle_timeout: 30, prepare: false });
    db = drizzle(client, { schema });
  }
  return db;
}

/** Test hook: drop the cached connection so a new DATABASE_URL takes effect. */
export async function resetDb(): Promise<void> {
  const previous = client; client = null; db = null;
  if (previous) await previous.end({ timeout: 2 }).catch(() => undefined);
}

/**
 * Run `fn` inside a transaction whose row-level-security context is `tenantId`. `set_config(..., true)`
 * is transaction-local, so a pooled connection never carries one tenant's context into another's query.
 */
export async function withTenant<T>(database: Db, tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return database.transaction(async tx => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Apply pending migrations with an owner connection (DATABASE_ADMIN_URL, else DATABASE_URL). Idempotent; safe at every boot. */
export async function runMigrations(env: Record<string, string | undefined> = process.env, folder = MIGRATIONS_FOLDER): Promise<void> {
  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  if (!url) return;
  const admin = postgres(url, { max: 1, prepare: false });
  try { await migrate(drizzle(admin, { schema }), { migrationsFolder: folder }); }
  finally { await admin.end({ timeout: 5 }); }
}

/**
 * The tenant this instance serves when no membership decides it (self-host, or the primary instance
 * before phase 2). Tenants are not under RLS for lookup by slug, so this runs outside withTenant().
 */
export async function ensureTenant(database: Db, slug: string, name = slug): Promise<{ id: string; slug: string }> {
  const existing = await database.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (existing[0]) return existing[0];
  const inserted = await database.insert(tenants).values({ slug, name }).onConflictDoNothing().returning({ id: tenants.id, slug: tenants.slug });
  if (inserted[0]) return inserted[0];
  const raced = await database.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return raced[0];
}

export const defaultTenantSlug = (env: Record<string, string | undefined> = process.env) => (env.AI_BILLS_TENANT || 'default').trim().toLowerCase();
