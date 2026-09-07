import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/lib/config';
import { productOverview } from '../src/lib/overview';
import { saveSubscriptionOverride, subscriptionOverridesPath, validateSubscriptionPatch } from '../src/lib/subscription-overrides';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'subscriptions-')); directories.push(directory);
  const path = join(directory, 'snapshot.json');
  await writeFile(path, JSON.stringify({ providers: [{ provider: 'Fixture', plan: 'Pro', billing: 'subscription', cost_usd_month: '~20', status: 'active' }] }));
  const config = { server: { timezone: 'Asia/Jerusalem' }, billing: { snapshot_path: path }, accounting: { journal_path: join(directory, 'journal.jsonl') } } as AppConfig;
  return { directory, path, config };
}
describe('subscription metadata overrides', () => {
  it('persists manual dates across source refresh without rewriting source and preserves estimated price evidence', async () => {
    const { path, config, directory } = await fixture();
    const original = await readFile(path, 'utf8'); const before = await productOverview(config); const id = before.subscriptions[0].id;
    await saveSubscriptionOverride(config, { id, amount: 20, currency: 'USD', period: 'month', renewsAt: '2026-10-03', endsAt: null, status: 'active' }, before);
    expect(await readFile(path, 'utf8')).toBe(original);
    await writeFile(path, original); // Next collector run replaces only its own source.
    const after = await productOverview(config);
    expect(after.subscriptions[0].renewsAt).toBe('2026-10-03');
    expect(after.subscriptions[0].costEvidence).toBe('estimated');
    expect(after.summary.monthlyCostEvidence).toBe('estimated');
    expect(await readdir(directory)).not.toContain('subscription-overrides.json.lock');
    expect(JSON.parse(await readFile(subscriptionOverridesPath(config), 'utf8')).version).toBe(1);
  });
  it('recalculates amounts and currency after a price edit and supports explicit null date clearing', async () => {
    const { config } = await fixture(); const before = await productOverview(config); const id = before.subscriptions[0].id;
    await saveSubscriptionOverride(config, { id, amount: 120, currency: 'EUR', period: 'year', renewsAt: '2026-10-03' }, before);
    const updated = await productOverview(config);
    expect(updated.summary.knownMonthlyCosts).toEqual([{ currency: 'EUR', amount: 10 }]);
    expect(updated.subscriptions[0].costEvidence).toBe('declared');
    await saveSubscriptionOverride(config, { id, renewsAt: null }, updated);
    expect((await productOverview(config)).subscriptions[0].renewsAt).toBeNull();
  });
  it('rejects invalid dates, currency, negative costs, unsupported fields and invented identities', async () => {
    for (const changes of [{ amount: -1 }, { currency: 'ZZZ' }, { renewsAt: '2026-02-30' }, { endsAt: 'tomorrow' }, { status: 'surprise' }, { apiKey: 'secret' }]) expect(() => validateSubscriptionPatch({ id: 'known', ...changes })).toThrow();
    const { config } = await fixture();
    await expect(saveSubscriptionOverride(config, { id: 'invented', amount: 1 }, await productOverview(config))).rejects.toThrow('no longer exists');
  });
});
