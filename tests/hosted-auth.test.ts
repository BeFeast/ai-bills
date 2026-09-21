import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authMode, authorizeEmail, clerkRuntime, parseEmailList } from '../src/lib/hosted-auth';
import { publicUrl } from '../src/middleware';
import { bearerAccepted, parseTokenDigests, readBounded, validateSnapshot } from '../src/lib/snapshot-ingest';

describe('hosted authorization', () => {
  it('is off unless explicitly switched to clerk', () => {
    expect(authMode({})).toBe('none');
    expect(authMode({ AI_BILLS_AUTH: 'clerk' })).toBe('clerk');
    expect(authMode({ AI_BILLS_AUTH: 'yes' })).toBe('none');
  });
  it('normalises the lists and admits only listed addresses once a list exists', () => {
    const allowed = parseEmailList(' Owner@Example.com, second@example.com\n bogus ');
    expect(allowed).toEqual(['owner@example.com', 'second@example.com']);
    expect(authorizeEmail('owner@example.com', allowed)).toMatchObject({ allowed: true, admin: false, reason: 'allowed' });
    expect(authorizeEmail('  OWNER@example.com ', allowed)).toMatchObject({ allowed: true });
    expect(authorizeEmail('stranger@example.com', allowed)).toMatchObject({ allowed: false, reason: 'not-listed' });
    expect(authorizeEmail(null, allowed)).toMatchObject({ allowed: false, reason: 'no-email' });
    expect(authorizeEmail('admin@example.com', allowed, ['admin@example.com'])).toMatchObject({ allowed: true, admin: true });
  });
  it('keeps an unconfigured list permissive so a deploy without the variable does not lock everyone out', () => {
    expect(authorizeEmail('anyone@example.com', [])).toMatchObject({ allowed: true, reason: 'open' });
  });
});

describe('snapshot ingest', () => {
  const token = 'zk_test_token_value';
  const digest = createHash('sha256').update(token).digest('hex');
  it('accepts only a bearer whose digest is configured, in constant time', () => {
    expect(parseTokenDigests(`sha256:${digest}, nonsense`)).toEqual([digest]);
    expect(bearerAccepted(`Bearer ${token}`, [digest])).toBe(true);
    expect(bearerAccepted(`bearer ${token}`, [digest])).toBe(true);
    expect(bearerAccepted('Bearer other', [digest])).toBe(false);
    expect(bearerAccepted(`Bearer ${token}`, [])).toBe(false);
    expect(bearerAccepted(null, [digest])).toBe(false);
  });
  it('validates the envelope like the SSH receiver', () => {
    expect(validateSnapshot('{"generated":"2026-09-19T00:00:00Z"}')).toEqual({ ok: true, generated: '2026-09-19T00:00:00Z' });
    expect(validateSnapshot('[]')).toMatchObject({ ok: false });
    expect(validateSnapshot('{"generated":5}')).toMatchObject({ ok: false });
    expect(validateSnapshot('{')).toMatchObject({ ok: false, error: 'snapshot is not valid JSON' });
  });
  it('stops reading an oversized body at the cap, with or without a content-length header', async () => {
    const big = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(1024).fill(120)); controller.close(); } });
    expect(await readBounded(new Request('http://x/', { method: 'PUT', body: big, duplex: 'half' } as RequestInit), 4096)).toEqual({ ok: false });
    expect(await readBounded(new Request('http://x/', { method: 'PUT', body: 'small', headers: { 'content-length': '99999999' } }), 4096)).toEqual({ ok: false });
    expect(await readBounded(new Request('http://x/', { method: 'PUT', body: '{"generated":"a"}' }), 4096)).toEqual({ ok: true, text: '{"generated":"a"}' });
  });
  it('serves the route with the configured digest, stores for the default tenant and rejects everything else', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const { schema } = await import('../src/db/schema');
    const dbModule = await import('../src/lib/db');
    const pg = new PGlite(); const owner = drizzle(pg, { schema });
    await migrate(owner, { migrationsFolder: dbModule.MIGRATIONS_FOLDER }); await pg.exec(`SET ROLE ${dbModule.APP_ROLE}`);
    const spy = vi.spyOn(dbModule, 'getDb').mockReturnValue(owner as unknown as ReturnType<typeof dbModule.getDb>);
    process.env.AI_BILLS_INGEST_TOKEN_SHA256 = digest;
    process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`;
    process.env.AI_BILLS_TENANT = 'route-test';
    const { resetConfigCache } = await import('../src/lib/config'); resetConfigCache();
    const { PUT } = await import('../src/app/api/snapshot/route');
    const call = (auth: string | null, body: string) => PUT(new Request('http://hosted.test/api/snapshot', { method: 'PUT', headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {}, body }));
    expect((await call(null, '{"generated":"x"}')).status).toBe(401);
    expect((await call('Bearer wrong', '{"generated":"x"}')).status).toBe(401);
    expect((await call(`Bearer ${token}`, '{"nope":true}')).status).toBe(400);
    const ok = await call(`Bearer ${token}`, '{"generated":"2026-09-19T00:00:00Z","alerts":{}}');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, stored: { tenant: 'route-test' } });
    const { latestSnapshot } = await import('../src/lib/snapshot-store');
    const tenant = await dbModule.ensureTenant(owner as unknown as ReturnType<typeof dbModule.getDb> & object, 'route-test');
    expect(((await latestSnapshot(owner as unknown as Parameters<typeof latestSnapshot>[0], tenant.id))?.body as { generated: string }).generated).toBe('2026-09-19T00:00:00Z');
    delete process.env.AI_BILLS_INGEST_TOKEN_SHA256;
    expect((await call(`Bearer ${token}`, '{"generated":"x"}')).status).toBe(404);
    spy.mockRestore(); dbModule.resetDefaultTenantCache(); await pg.close();
  }, 60_000);
});

describe('public return address', () => {
  const request = { nextUrl: { pathname: '/usage', search: '?x=1' }, url: 'https://0.0.0.0:18088/usage?x=1' };
  it('rebuilds the URL on the configured public origin and falls back to the request URL', () => {
    expect(publicUrl(request, 'https://zecori.befeast.com')).toBe('https://zecori.befeast.com/usage?x=1');
    expect(publicUrl(request, undefined)).toBe('https://0.0.0.0:18088/usage?x=1');
    expect(publicUrl(request, 'not a url')).toBe('https://0.0.0.0:18088/usage?x=1');
  });
});

describe('clerk runtime wiring', () => {
  it('reads the publishable key at runtime and configures a satellite from the primary origin', () => {
    expect(clerkRuntime({ CLERK_PUBLISHABLE_KEY: 'pk_live_a', AI_BILLS_PUBLIC_ORIGIN: 'https://zecori.befeast.com/' })).toMatchObject({ publishableKey: 'pk_live_a', isSatellite: false, signInUrl: '/sign-in', domain: undefined });
    expect(clerkRuntime({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_build' }).publishableKey).toBe('pk_build');
    const sat = clerkRuntime({ CLERK_PUBLISHABLE_KEY: 'pk_live_a', AI_BILLS_PUBLIC_ORIGIN: 'https://zecori-demo.befeast.com', AI_BILLS_CLERK_PRIMARY_ORIGIN: 'https://zecori.befeast.com', AI_BILLS_CLERK_ALLOWED_REDIRECT_ORIGINS: 'https://zecori.befeast.com, https://*.befeast.com' });
    expect(sat).toMatchObject({ isSatellite: true, domain: 'zecori-demo.befeast.com', signInUrl: 'https://zecori.befeast.com/sign-in', afterSignOutUrl: 'https://zecori.befeast.com/sign-in', allowedRedirectOrigins: ['https://zecori.befeast.com', 'https://*.befeast.com'] });
    // The primary naming itself is not a satellite.
    expect(clerkRuntime({ AI_BILLS_PUBLIC_ORIGIN: 'https://zecori.befeast.com', AI_BILLS_CLERK_PRIMARY_ORIGIN: 'https://zecori.befeast.com' }).isSatellite).toBe(false);
    // A satellite without its own public origin cannot be configured for Clerk; refuse instead of running half-set-up.
    expect(() => clerkRuntime({ AI_BILLS_CLERK_PRIMARY_ORIGIN: 'https://zecori.befeast.com' })).toThrow(/AI_BILLS_PUBLIC_ORIGIN/);
    expect(() => clerkRuntime({ AI_BILLS_PUBLIC_ORIGIN: 'not a url', AI_BILLS_CLERK_PRIMARY_ORIGIN: 'https://zecori.befeast.com' })).toThrow(/AI_BILLS_PUBLIC_ORIGIN/);
    expect(() => clerkRuntime({ AI_BILLS_PUBLIC_ORIGIN: 'http://zecori-demo.befeast.com', AI_BILLS_CLERK_PRIMARY_ORIGIN: 'https://zecori.befeast.com' })).toThrow(/AI_BILLS_PUBLIC_ORIGIN/);
  });
});
