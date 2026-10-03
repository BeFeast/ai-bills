import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, type Db } from '../src/lib/db';
import { storeSnapshot } from '../src/lib/snapshot-store';
import type { CodexUsagePayload, ProviderUsage } from '../src/lib/usage';

vi.mock('../src/lib/db', async importOriginal => ({ ...(await importOriginal<typeof import('../src/lib/db')>()), getDb: () => db }));
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));
import { fetchUsageThroughCdp } from '../src/lib/cdp';
import { refreshUsage, resetUsageCacheForTests } from '../src/lib/usage-service';

let pg: PGlite; let db: Db;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  pg = new PGlite();
  const owner = drizzle(pg, { schema });
  await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER });
  await pg.exec(`SET ROLE ${APP_ROLE}`);
  db = owner as unknown as Db;
  for (const key of ['DATABASE_URL', 'AI_BILLS_CONFIG']) saved[key] = process.env[key];
  Object.assign(process.env, { DATABASE_URL: 'postgres://mocked', AI_BILLS_CONFIG: `${process.cwd()}/tests/fixtures/accounts.toml` });
  const { resetConfigCache } = await import('../src/lib/config'); resetConfigCache();
}, 60_000);
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetUsageCacheForTests();
  await pg.close();
});

// One clock for the stored history and the mocked observations: under load, two Date.now() reads drift apart by seconds.
let base = Date.now();
const minutesAgo = (minutes: number) => new Date(base - minutes * 60_000).toISOString();
const codex = (email: string, used: number, balance: string): CodexUsagePayload => ({ account_id: `acct-${email}`, email, plan_type: 'pro',
  rate_limit: { allowed: used < 100, limit_reached: used >= 100, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: Math.round(Date.now() / 1000) + 3600 }, secondary_window: null },
  credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance }, spend_control: { reached: false, individual_limit: null },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 2 } } as unknown as CodexUsagePayload);

describe('usage refresh', () => {
  it('attaches the credit drain to a used-up Codex account from its stored balances, and nothing to the others', async () => {
    base = Date.now();
    const tenant = await ensureTenant(db, 'drain');
    const personal = 'codex-personal@example.com'; const work = 'codex-work@example.com';
    // Half an hour ago the personal account had 4 000 more credits; the snapshot it rode in is the tenant's history.
    await storeSnapshot(db, tenant.id, JSON.stringify({ codex_usage: { [personal]: { ok: true, status: 200, fetched_at: minutesAgo(31), data: codex(personal, 100, '24000') } } }), minutesAgo(31), new Date(base - 31 * 60_000));
    await storeSnapshot(db, tenant.id, JSON.stringify({ codex_usage: {} }), minutesAgo(1), new Date(base - 60_000));
    vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => ({ account, ok: true, status: 200, fetchedAt: minutesAgo(1), sourceUrl: 'snapshot',
      data: account.provider === 'codex' ? codex(account.email, account.email === personal ? 100 : 10, '20000') : { five_hour: { utilization: 10 }, seven_day: { utilization: 10 } } }) as ProviderUsage);
    resetUsageCacheForTests();
    const { results } = await refreshUsage({ id: tenant.id });
    const byKey = new Map(results.map(result => [result.account.key, result]));
    expect(byKey.get('codex-personal')?.creditDrain).toEqual({ balance: 20000, perHour: 8000, since: expect.any(String), manualResets: 2 });
    expect(byKey.get('codex-work')?.creditDrain).toBeUndefined();
    expect(byKey.get('claude-work')?.creditDrain).toBeUndefined();
  });

  it('attaches a drain to a header fallback whose stored balance is falling', async () => {
    base = Date.now();
    const tenant = await ensureTenant(db, 'fallback');
    const personal = 'codex-personal@example.com';
    for (const [minutes, balance] of [[31, '24000'], [6, '20000']] as const) {
      await storeSnapshot(db, tenant.id, JSON.stringify({ codex_usage: { [personal]: { ok: true, status: 200, fetched_at: minutesAgo(minutes), data: codex(personal, 100, balance) } } }), minutesAgo(minutes), new Date(base - minutes * 60_000));
    }
    // The direct request failed; the proxy's rate-limit headers stood in, with no credits block.
    vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => (account.provider === 'codex' && account.email === personal
      ? { account, ok: true, source: 'proxy_headers', fetchedAt: minutesAgo(1), sourceUrl: 'snapshot', data: { plan_type: 'pro', rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: Math.round(base / 1000) + 3600 } } } }
      : { account, ok: true, status: 200, fetchedAt: minutesAgo(1), sourceUrl: 'snapshot', data: account.provider === 'codex' ? codex(account.email, 10, '20000') : { five_hour: { utilization: 10 }, seven_day: { utilization: 10 } } }) as ProviderUsage);
    resetUsageCacheForTests();
    const { results } = await refreshUsage({ id: tenant.id });
    expect(results.find(result => result.account.key === 'codex-personal')?.creditDrain).toMatchObject({ balance: 20000, perHour: 9600 });
  });

  it('still answers, without a rate, when the history cannot be read', async () => {
    const tenant = await ensureTenant(db, 'drain');
    vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => ({ account, ok: true, status: 200, fetchedAt: minutesAgo(1), sourceUrl: 'snapshot',
      data: account.provider === 'codex' ? codex(account.email, 100, '20000') : { five_hour: { utilization: 10 }, seven_day: { utilization: 10 } } }) as ProviderUsage);
    resetUsageCacheForTests();
    // The snapshot stays readable; only the history read fails.
    await pg.exec(`RESET ROLE; REVOKE SELECT ON quota_observations FROM ${APP_ROLE}; SET ROLE ${APP_ROLE}`);
    try {
      const { results } = await refreshUsage({ id: tenant.id });
      const codexResults = results.filter(item => item.account.provider === 'codex');
      expect(codexResults).toHaveLength(2);
      for (const result of codexResults) expect(result).toMatchObject({ ok: true, creditDrain: { balance: 20000, perHour: null, manualResets: 2 } });
    } finally {
      await pg.exec(`RESET ROLE; GRANT SELECT ON quota_observations TO ${APP_ROLE}; SET ROLE ${APP_ROLE}`);
    }
  });
});
