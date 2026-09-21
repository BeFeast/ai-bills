import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../src/lib/config', () => ({ tenantAccounts: (config: { accounts: unknown[] }) => config.accounts, loadConfig: () => ({ accounts: [{ key: 'browser', provider: 'kimi' }], accounting: { declared_accounts: [{ id: 'meta', provider: 'meta' }] } }) }));
import { sourceHealth } from '../src/lib/source-health';
import { rememberUsageObservations } from '../src/lib/usage-observations';
afterEach(() => rememberUsageObservations([]));
test('monitor reads observations without opening browsers or requiring unsupported declared accounts', () => {
  const now = Date.now();
  expect(sourceHealth(now).sources).toHaveLength(1);
  expect(sourceHealth(now).sources[0].cdp_path).toMatchObject({ mode: 'idle', ok: null, live: false });
  rememberUsageObservations([{ account: { key: 'browser', provider: 'kimi', label: 'Test', email: 'test@example.test' }, ok: false, fetchedAt: new Date(now).toISOString(), sourceUrl: 'private-source', error: 'private error' }]);
  expect(sourceHealth(now).sources[0]).toMatchObject({ status: 'error', expected: true, cdp_path: { mode: 'observed', ok: false, live: false } });
  expect(JSON.stringify(sourceHealth(now))).not.toMatch(/private|example.test/);
  expect(sourceHealth(now + 601_000).sources[0].status).toBe('stale');
});
