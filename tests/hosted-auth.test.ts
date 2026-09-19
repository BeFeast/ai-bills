import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authMode, authorizeEmail, parseEmailList } from '../src/lib/hosted-auth';
import { bearerAccepted, parseTokenDigests, readBounded, validateSnapshot, writeSnapshotAtomically } from '../src/lib/snapshot-ingest';

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
  it('replaces the file atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zecori-ingest-'));
    const target = join(dir, 'nested', 'snapshot.json');
    await writeSnapshotAtomically(target, '{"generated":"a"}');
    await writeSnapshotAtomically(target, '{"generated":"b"}');
    expect(JSON.parse(await readFile(target, 'utf8')).generated).toBe('b');
  });
  it('stops reading an oversized body at the cap, with or without a content-length header', async () => {
    const big = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(1024).fill(120)); controller.close(); } });
    expect(await readBounded(new Request('http://x/', { method: 'PUT', body: big, duplex: 'half' } as RequestInit), 4096)).toEqual({ ok: false });
    expect(await readBounded(new Request('http://x/', { method: 'PUT', body: 'small', headers: { 'content-length': '99999999' } }), 4096)).toEqual({ ok: false });
    expect(await readBounded(new Request('http://x/', { method: 'PUT', body: '{"generated":"a"}' }), 4096)).toEqual({ ok: true, text: '{"generated":"a"}' });
  });
  it('serves the route with the configured digest and rejects everything else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zecori-route-'));
    process.env.AI_BILLS_INGEST_TOKEN_SHA256 = digest;
    process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`;
    const { resetConfigCache, loadConfig } = await import('../src/lib/config');
    resetConfigCache();
    loadConfig().billing.snapshot_path = join(dir, 'snapshot.json');
    const { PUT } = await import('../src/app/api/snapshot/route');
    const call = (auth: string | null, body: string) => PUT(new Request('http://hosted.test/api/snapshot', { method: 'PUT', headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {}, body }));
    expect((await call(null, '{"generated":"x"}')).status).toBe(401);
    expect((await call('Bearer wrong', '{"generated":"x"}')).status).toBe(401);
    expect((await call(`Bearer ${token}`, '{"nope":true}')).status).toBe(400);
    const ok = await call(`Bearer ${token}`, '{"generated":"2026-09-19T00:00:00Z","alerts":{}}');
    expect(ok.status).toBe(200);
    expect(JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8')).generated).toBe('2026-09-19T00:00:00Z');
    delete process.env.AI_BILLS_INGEST_TOKEN_SHA256;
    expect((await call(`Bearer ${token}`, '{"generated":"x"}')).status).toBe(404);
  });
});
