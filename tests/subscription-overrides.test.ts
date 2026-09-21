import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, type Db } from '../src/lib/db';
import type { AppConfig } from '../src/lib/config';
import { productOverview } from '../src/lib/overview';
import { storeSnapshot } from '../src/lib/snapshot-store';
import { dbOverridesStore } from '../src/lib/storage';
import { saveSubscriptionOverride, validateSubscriptionPatch } from '../src/lib/subscription-overrides';

let pg: PGlite; let db: Db; let n = 0;
vi.mock('../src/lib/db', async importOriginal => ({ ...(await importOriginal<typeof import('../src/lib/db')>()), getDb: () => db }));
beforeAll(async () => { pg = new PGlite(); const owner = drizzle(pg, { schema }); await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER }); await pg.exec(`SET ROLE ${APP_ROLE}`); db = owner as unknown as Db; }, 60_000);
afterAll(async () => { await pg.close(); });
const source = JSON.stringify({ generated: '2026-09-21T10:00:00Z', providers: [{ provider: 'Fixture', plan: 'Pro', billing: 'subscription', cost_usd_month: '~20', status: 'active' }] });
/** A tenant with one collector snapshot; the overrides store of that tenant is what saveSubscriptionOverride writes to. */
async function fixture() {
  const tenant = await ensureTenant(db, `overrides-${++n}`);
  await storeSnapshot(db, tenant.id, source, '2026-09-21T10:00:00Z');
  const config = { server: { timezone: 'Asia/Jerusalem' }, billing: {}, accounting: {}, accounts: [] } as unknown as AppConfig;
  return { config, scope: { id: tenant.id }, store: dbOverridesStore(db, tenant.id) };
}
describe('subscription metadata overrides', () => {
  it('persists manual dates across source refresh without touching the source and preserves estimated price evidence', async () => {
    const { config, scope, store } = await fixture();
    const before = await productOverview(config, scope); const id = before.subscriptions[0].id;
    await saveSubscriptionOverride(config, { id, amount: 20, currency: 'USD', period: 'month', renewsAt: '2026-10-03', endsAt: null, status: 'active' }, before, store);
    // The next collector delivery replaces only its own source; the edit survives it.
    await storeSnapshot(db, scope.id, source, '2026-09-21T10:05:00Z');
    const after = await productOverview(config, scope);
    expect(after.subscriptions[0].renewsAt).toBe('2026-10-03');
    expect(after.subscriptions[0].costEvidence).toBe('estimated');
    expect(after.summary.monthlyCostEvidence).toBe('estimated');
    expect(Object.keys(await store.read())).toEqual([id]);
  });
  it('recalculates amounts and currency after a price edit and supports explicit null date clearing', async () => {
    const { config, scope, store } = await fixture(); const before = await productOverview(config, scope); const id = before.subscriptions[0].id;
    await saveSubscriptionOverride(config, { id, amount: 120, currency: 'EUR', period: 'year', renewsAt: '2026-10-03' }, before, store);
    const updated = await productOverview(config, scope);
    expect(updated.summary.knownMonthlyCosts).toEqual([{ currency: 'EUR', amount: 10 }]);
    expect(updated.subscriptions[0].costEvidence).toBe('declared');
    await saveSubscriptionOverride(config, { id, renewsAt: null }, updated, store);
    expect((await productOverview(config, scope)).subscriptions[0].renewsAt).toBeNull();
  });
  it('rejects invalid dates, currency, negative costs, unsupported fields and invented identities', async () => {
    for (const changes of [{ amount: -1 }, { currency: 'ZZZ' }, { renewsAt: '2026-02-30' }, { endsAt: 'tomorrow' }, { status: 'surprise' }, { apiKey: 'secret' }]) expect(() => validateSubscriptionPatch({ id: 'known', ...changes })).toThrow();
    const { config, scope, store } = await fixture();
    await expect(saveSubscriptionOverride(config, { id: 'invented', amount: 1 }, await productOverview(config, scope), store)).rejects.toThrow('no longer exists');
    const before = await productOverview(config, scope);
    await expect(saveSubscriptionOverride(config, { id: before.subscriptions[0].id, amount: 1 }, before, null)).rejects.toThrow('need the database');
  });
});
