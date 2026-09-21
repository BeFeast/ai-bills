import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/config', () => ({ loadConfig: () => ({
  server: { timezone: 'UTC', usage_refresh_seconds: 300 },
  billing: {},
  accounts: [{ key: 'api', provider: 'claude', label: 'API account', email: 'api@example.test' }],
}), tenantAccounts: (config: { accounts: unknown[] }) => config.accounts }));
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));
/** The tenant's newest stored snapshot, as the storage layer would report it: `version` is its receipt time. */
let stored: { body: unknown; version: string | null } = { body: {}, version: null };
vi.mock('../src/lib/storage', () => ({ readSnapshot: async () => stored }));

import { fetchUsageThroughCdp } from '../src/lib/cdp';
import { getUsageResponse, resetUsageCacheForTests } from '../src/lib/usage-service';

const scope = { id: 'tenant-a' };
const deliver = (generated: string) => { stored = { body: { generated }, version: generated }; };

beforeEach(() => {
  vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => ({ account, ok: true, fetchedAt: new Date().toISOString(), sourceUrl: 'snapshot', data: { seven_day: { utilization: 10 } } }));
});
afterEach(() => { resetUsageCacheForTests(); vi.clearAllMocks(); stored = { body: {}, version: null }; });

describe('usage cache and the stored snapshot', () => {
  it('re-reads quotas when the collector delivers a new snapshot, inside the refresh interval', async () => {
    deliver('2026-09-19T14:25:00Z');
    await getUsageResponse(false, scope);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
    // Same snapshot: the cache stands, the refresh interval has not elapsed.
    await getUsageResponse(false, scope);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
    // The collector delivers a new snapshot; the next reader must see it rather than the previous quota.
    deliver('2026-09-19T15:35:00Z');
    await getUsageResponse(false, scope);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);
    await getUsageResponse(false, scope);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);
  });

  it('does not refresh per request when no snapshot exists or it is unchanged', async () => {
    deliver('2026-09-19T14:25:00Z');
    await getUsageResponse(false, scope);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
    stored = { body: {}, version: null };
    await getUsageResponse(false, scope);
    await getUsageResponse(false, scope);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
  });

  it('still honours an explicit refresh, and keeps one cache per tenant', async () => {
    deliver('2026-09-19T14:25:00Z');
    await getUsageResponse(false, scope);
    await getUsageResponse(true, scope);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);
    await getUsageResponse(false, { id: 'tenant-b' });
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(3);
  });
});
