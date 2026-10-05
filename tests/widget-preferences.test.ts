import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, widgetPreferences } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, withTenant, type Db } from '../src/lib/db';
import { readWidgetPreferences, writeWidgetPreferences, validateWidgetProviders } from '../src/lib/widget-preferences';
import type { TenantContext } from '../src/lib/tenant';

let pg: PGlite; let db: Db;
const ctx = vi.hoisted(() => ({ tenant: null as TenantContext | null, db: null as Db | null }));
vi.mock('../src/lib/tenant', () => ({ requireTenant: async () => ({ tenant: ctx.tenant }) }));
vi.mock('../src/lib/db', async original => ({ ...await original<typeof import('../src/lib/db')>(), getDb: () => ctx.db }));
import { GET, PUT } from '../src/app/api/widget/preferences/route';
beforeAll(async () => {
  pg = new PGlite(); const owner = drizzle(pg, { schema });
  await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER }); await pg.exec(`SET ROLE ${APP_ROLE}`);
  db = owner as unknown as Db; ctx.db = db;
}, 60_000);
afterAll(async () => { await pg.close(); });

describe('shared desktop bar preferences', () => {
  it('validates automatic, empty and ordered selection and rejects duplicates and invalid IDs', () => {
    expect(validateWidgetProviders({ providers: null })).toBeNull();
    expect(validateWidgetProviders({ providers: [] })).toEqual([]);
    expect(validateWidgetProviders({ providers: ['codex', 'claude'] })).toEqual(['codex', 'claude']);
    for (const providers of [['claude', 'claude'], ['Bad input'], [''], 0, Array.from({ length: 9 }, (_, i) => 'p' + i)]) expect(() => validateWidgetProviders({ providers })).toThrow();
    expect(() => validateWidgetProviders({ other: [] })).toThrow();
  });
  it('persists order and icon-only selection, resets to automatic and isolates tenants with RLS', async () => {
    const a = await ensureTenant(db, 'bar-a'); const b = await ensureTenant(db, 'bar-b');
    expect(await readWidgetPreferences(a, db)).toBeNull();
    await writeWidgetPreferences(a, ['codex', 'claude'], db);
    expect(await readWidgetPreferences(a, db)).toEqual(['codex', 'claude']);
    expect(await readWidgetPreferences(b, db)).toBeNull();
    expect(await withTenant(db, b.id, tx => tx.select().from(widgetPreferences))).toEqual([]);
    await expect(withTenant(db, b.id, tx => tx.insert(widgetPreferences).values({ tenantId: a.id, providers: [] }))).rejects.toThrow();
    await writeWidgetPreferences(a, [], db); expect(await readWidgetPreferences(a, db)).toEqual([]);
    await writeWidgetPreferences(a, null, db); expect(await readWidgetPreferences(a, db)).toBeNull();
  });
  it('allows same-origin admin edits, denies devices, ingest tokens, members and foreign origins', async () => {
    const tenant = await ensureTenant(db, 'bar-route');
    const admin: TenantContext = { id: tenant.id, slug: tenant.slug, role: 'admin', userId: null, email: null, access: 'session' };
    const request = (body = '{"providers":["codex","claude"]}', origin = 'https://example.test') => new Request('https://example.test/api/widget/preferences', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body });
    ctx.tenant = admin;
    expect((await PUT(request())).status).toBe(200);
    expect(await (await GET()).json()).toEqual({ providers: ['codex', 'claude'], editable: true });
    expect((await PUT(request('{}'))).status).toBe(400);
    expect((await PUT(request(undefined, 'https://other.test'))).status).toBe(403);
    ctx.tenant = { ...admin, role: 'member' }; expect((await PUT(request())).status).toBe(403);
    for (const access of ['device', 'ingest'] as const) {
      ctx.tenant = { ...admin, access };
      expect((await PUT(request())).status).toBe(403); expect((await GET()).status).toBe(403);
    }
    ctx.tenant = admin;
    expect(await readWidgetPreferences(admin, db)).toEqual(['codex', 'claude']);
  });
});
