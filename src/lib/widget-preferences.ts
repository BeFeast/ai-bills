import { eq } from 'drizzle-orm';
import { widgetPreferences } from '@/db/schema';
import { getDb, withTenant, type Db } from './db';
import type { Scope } from './storage';

export function validateWidgetProviders(input: unknown): string[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'providers')) throw new Error('Expected providers');
  const providers = (input as { providers?: unknown }).providers;
  if (providers === null) return null;
  if (!Array.isArray(providers) || providers.length > 8 || providers.some(p => typeof p !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(p)) || new Set(providers).size !== providers.length) throw new Error('Choose up to eight different providers');
  return providers;
}
export async function readWidgetPreferences(scope: Scope, db: Db | null = getDb()): Promise<string[] | null> {
  if (!scope.id || !db) return null;
  const rows = await withTenant(db, scope.id, tx => tx.select().from(widgetPreferences).where(eq(widgetPreferences.tenantId, scope.id!)));
  return rows[0]?.providers ?? null;
}
export async function writeWidgetPreferences(scope: Scope, providers: string[] | null, db: Db | null = getDb()): Promise<void> {
  if (!scope.id || !db) throw new Error('Desktop bar settings need a database');
  await withTenant(db, scope.id, tx => tx.insert(widgetPreferences).values({ tenantId: scope.id!, providers })
    .onConflictDoUpdate({ target: widgetPreferences.tenantId, set: { providers, updatedAt: new Date() } }));
}
