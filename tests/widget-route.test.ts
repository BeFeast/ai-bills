import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, resetDefaultTenantCache, type Db } from '../src/lib/db';
import { issueDeviceToken } from '../src/lib/device-tokens';
import { IDENTITY_HEADERS } from '../src/lib/hosted-auth';
import { storeSnapshot } from '../src/lib/snapshot-store';
import { ensureIngestTokens, resetTenantCache } from '../src/lib/tenant';

let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
vi.mock('../src/lib/db', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/db')>();
  return { ...original, getDb: () => db };
});
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));

import { fetchUsageThroughCdp } from '../src/lib/cdp';

let pg: PGlite; let db: Db;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  pg = new PGlite();
  const owner = drizzle(pg, { schema });
  await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER });
  await pg.exec(`SET ROLE ${APP_ROLE}`);
  db = owner as unknown as Db;
  for (const key of ['AI_BILLS_AUTH', 'DATABASE_URL', 'AI_BILLS_TENANT', 'AI_BILLS_CONFIG', 'AI_BILLS_ALLOWED_EMAILS', 'AI_BILLS_ADMIN_EMAILS']) saved[key] = process.env[key];
  Object.assign(process.env, { AI_BILLS_AUTH: 'clerk', DATABASE_URL: 'postgres://mocked', AI_BILLS_TENANT: 'oleg', AI_BILLS_CONFIG: `${process.cwd()}/tests/fixtures/accounts.toml`, AI_BILLS_ALLOWED_EMAILS: 'owner@example.test, member@example.test', AI_BILLS_ADMIN_EMAILS: 'owner@example.test' });
  const { resetConfigCache } = await import('../src/lib/config'); resetConfigCache();
  resetDefaultTenantCache(); resetTenantCache();
  vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => ({ account, ok: true, fetchedAt: new Date().toISOString(), sourceUrl: 'snapshot', data: { five_hour: { utilization: 40, resets_at: '2026-09-23T20:00:00Z' }, seven_day: { utilization: 10, resets_at: '2026-09-27T00:00:00Z' } } }));
}, 60_000);
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await pg.close();
});

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const bearer = (token: string) => { requestHeaders = new Headers({ authorization: `Bearer ${token}` }); };
const session = (userId: string, email: string) => { requestHeaders = new Headers({ [IDENTITY_HEADERS.userId]: userId, [IDENTITY_HEADERS.email]: email }); };
const anonymous = () => { requestHeaders = new Headers(); };
const origin = 'http://hosted.test';
const json = (method: string, path: string, body?: unknown) => new Request(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', origin }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('GET /api/widget', () => {
  it('answers a device token with the tenant\'s limits and today\'s spend, and refuses everything else', async () => {
    const tenant = await ensureTenant(db, 'oleg');
    const today = new Date().toISOString().slice(0, 10);
    await storeSnapshot(db, tenant.id, JSON.stringify({ generated: new Date().toISOString(), usage_ledger: { today: { date: today, period: 'day', by_client: [{ name: 'slava', priced_api_equivalent_usd: 0.33, tokens: 803952, requests: 31 }, { name: 'claude-idunn', priced_api_equivalent_usd: 0.41, tokens: 109900, requests: 8 }] } } }), new Date().toISOString());
    const issued = await issueDeviceToken(db, tenant.id, 'slava');
    await ensureIngestTokens(db, tenant.id, [digest('zk_collector')]);
    const { GET } = await import('../src/app/api/widget/route');

    bearer(issued.token);
    // The first read publishes pending rows while the refresh runs; the second sees the observations.
    await GET(); await new Promise(resolve => setTimeout(resolve, 50));
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const body = await ok.json();
    expect(body.snapshot).toMatchObject({ stale: false, reason: null });
    expect(body.accounts.length).toBeGreaterThan(0);
    expect(body.accounts[0]).toMatchObject({ state: 'fresh', limiting: { remainingPercent: 60 } });
    expect(body.today).toMatchObject({ date: today });
    expect(body.today.byClient.map((row: { name: string }) => row.name)).toEqual(['slava', 'claude-idunn']);

    bearer('zk_collector');
    expect((await GET()).status).toBe(403);
    bearer('zd_not_issued');
    expect((await GET()).status).toBe(401);
    anonymous();
    const none = await GET();
    expect(none.status).toBe(401); expect(none.headers.get('www-authenticate')).toBe('Bearer');
    session('user_owner', 'owner@example.test');
    expect((await GET()).status).toBe(200);
  }, 30_000);

  it('keeps a device token out of every other route and out of ingest', async () => {
    const tenant = await ensureTenant(db, 'oleg');
    const issued = await issueDeviceToken(db, tenant.id, 'idunn');
    bearer(issued.token);
    const usage = await import('../src/app/api/usage/route');
    expect((await usage.GET(new Request(`${origin}/api/usage?refresh=1`))).status).toBe(403);
    const overview = await import('../src/app/api/overview/route');
    expect((await overview.PATCH(json('PATCH', '/api/overview', {}))).status).toBe(403);
    const tokens = await import('../src/app/api/device-tokens/route');
    expect((await tokens.GET()).status).toBe(403);
    const snapshot = await import('../src/app/api/snapshot/route');
    expect((await snapshot.PUT(new Request(`${origin}/api/snapshot`, { method: 'PUT', headers: { authorization: `Bearer ${issued.token}` }, body: '{"generated":"x"}' }))).status).toBe(401);
  });
});

describe('/api/device-tokens', () => {
  it('lets a signed-in admin issue, list and revoke; refuses members, bearers and cross-origin changes', async () => {
    const tokens = await import('../src/app/api/device-tokens/route');
    const revoke = await import('../src/app/api/device-tokens/[id]/route');
    session('user_owner', 'owner@example.test');
    const created = await tokens.POST(json('POST', '/api/device-tokens', { label: 'desk' }));
    expect(created.status).toBe(201);
    const issued = await created.json();
    expect(issued).toMatchObject({ label: 'desk', id: expect.any(String), token: expect.stringMatching(/^zd_/) });
    const listed = await (await tokens.GET()).json();
    expect(listed.tokens.some((row: { id: string; revokedAt: string | null }) => row.id === issued.id && row.revokedAt === null)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect((await tokens.POST(json('POST', '/api/device-tokens', {}))).status).toBe(400);
    expect((await tokens.POST(new Request(`${origin}/api/device-tokens`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://elsewhere.test' }, body: '{"label":"x"}' }))).status).toBe(403);
    expect((await revoke.DELETE(json('DELETE', '/api/device-tokens/nope'), { params: Promise.resolve({ id: 'nope' }) })).status).toBe(400);
    expect((await revoke.DELETE(json('DELETE', `/api/device-tokens/${issued.id}`), { params: Promise.resolve({ id: issued.id }) })).status).toBe(200);
    expect((await revoke.DELETE(json('DELETE', `/api/device-tokens/${issued.id}`), { params: Promise.resolve({ id: issued.id }) })).status).toBe(404);
    bearer(issued.token);
    const widget = await import('../src/app/api/widget/route');
    expect((await widget.GET()).status).toBe(401);

    session('user_member', 'member@example.test');
    expect((await tokens.POST(json('POST', '/api/device-tokens', { label: 'x' }))).status).toBe(403);
    expect((await tokens.GET()).status).toBe(403);
    const tenant = await ensureTenant(db, 'oleg');
    await ensureIngestTokens(db, tenant.id, [digest('zk_admin_try')]);
    bearer('zk_admin_try');
    expect((await tokens.POST(json('POST', '/api/device-tokens', { label: 'x' }))).status).toBe(403);
  });
});
