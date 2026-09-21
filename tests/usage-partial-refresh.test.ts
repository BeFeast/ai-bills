import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderUsage } from '../src/lib/usage';

vi.mock('../src/lib/config', () => ({ tenantAccounts: (config: { accounts: unknown[] }) => config.accounts, loadConfig: () => ({
  server: { timezone: 'UTC', usage_refresh_seconds: 300 },
  accounts: [
    { key: 'api', provider: 'claude', label: 'API account', email: 'api@example.test' },
    { key: 'browser', provider: 'kimi', label: 'Browser account', email: 'browser@example.test' },
  ],
}) }));
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));

import { fetchUsageThroughCdp } from '../src/lib/cdp';
import { getUsageResponse, resetUsageCacheForTests } from '../src/lib/usage-service';

afterEach(() => { vi.useRealTimers(); resetUsageCacheForTests(); vi.clearAllMocks(); });

describe('independent quota refresh', () => {
  it('clears a rejected shared refresh so a later request can recover', async () => {
    vi.mocked(fetchUsageThroughCdp).mockRejectedValue(new Error('fixture failure'));
    await expect(getUsageResponse()).rejects.toThrow('fixture failure');
    vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => ({ account, ok: false,
      fetchedAt: new Date().toISOString(), sourceUrl: 'fixture', error: 'Not configured' }));
    const recovered = await getUsageResponse(true);
    expect(recovered.refreshing).toBe(false);
    expect(recovered.accounts.every(row => row.error === 'Not configured')).toBe(true);
  });
  it('returns fresh API quota while an unrelated browser is unavailable, sharing the pending job', async () => {
    vi.useFakeTimers();
    let finishBrowser!: (value: ProviderUsage) => void;
    const browser = new Promise<ProviderUsage>(resolve => { finishBrowser = resolve; });
    vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => account.key === 'browser' ? browser : ({
      account, ok: true, fetchedAt: new Date().toISOString(), sourceUrl: 'snapshot',
      data: { seven_day: { utilization: 100, resets_at: '2099-01-01T00:00:00Z' } },
    }));
    const request = getUsageResponse();
    await vi.advanceTimersByTimeAsync(101);
    const partial = await request;
    expect(partial.refreshing).toBe(true);
    expect(partial.accounts.find(account => account.account.key === 'api')?.ok).toBe(true);
    expect(partial.accounts.find(account => account.account.key === 'browser')?.error).toContain('first quota observation');
    expect((await getUsageResponse()).accounts[0].ok).toBe(true);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);

    finishBrowser({ account: { key: 'browser', provider: 'kimi', label: 'Browser', email: 'browser@example.test' },
      ok: false, fetchedAt: new Date().toISOString(), sourceUrl: 'browser', error: 'Browser unavailable' });
    await vi.advanceTimersByTimeAsync(0);
    const complete = await getUsageResponse();
    expect(complete.refreshing).toBe(false);
    expect(complete.accounts[0].ok).toBe(true);
    expect(complete.accounts[1].error).toBe('Browser unavailable');
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);
  });
});
