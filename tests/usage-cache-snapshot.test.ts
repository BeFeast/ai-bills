import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Inlined inside the factory: vi.mock is hoisted above this file's own constants.
vi.mock('../src/lib/config', () => ({ loadConfig: () => ({
  server: { timezone: 'UTC', usage_refresh_seconds: 300 },
  billing: { snapshot_path: join(tmpdir(), 'zecori-usage-cache-test-snapshot.json') },
  accounts: [{ key: 'api', provider: 'claude', label: 'API account', email: 'api@example.test' }],
}) }));
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));

import { fetchUsageThroughCdp } from '../src/lib/cdp';
import { getUsageResponse, resetUsageCacheForTests } from '../src/lib/usage-service';

const SNAPSHOT = join(tmpdir(), 'zecori-usage-cache-test-snapshot.json');
const write = (generated: string, seconds: number) => { writeFileSync(SNAPSHOT, JSON.stringify({ generated })); utimesSync(SNAPSHOT, seconds, seconds); };

beforeEach(() => {
  vi.mocked(fetchUsageThroughCdp).mockImplementation(async account => ({ account, ok: true, fetchedAt: new Date().toISOString(), sourceUrl: 'snapshot', data: { seven_day: { utilization: 10 } } }));
});
afterEach(() => { resetUsageCacheForTests(); vi.clearAllMocks(); rmSync(SNAPSHOT, { force: true }); });

describe('usage cache and the snapshot on disk', () => {
  it('re-reads quotas when the collector replaces the snapshot, inside the refresh interval', async () => {
    write('2026-09-19T14:25:00Z', 1_758_291_900);
    await getUsageResponse();
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
    // Same file: the cache stands, the refresh interval has not elapsed.
    await getUsageResponse();
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
    // The collector delivers a new snapshot; the next reader must see it rather than the previous quota.
    write('2026-09-19T15:35:00Z', 1_758_295_800);
    await getUsageResponse();
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);
    await getUsageResponse();
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);
  });

  it('does not refresh per request when the snapshot is missing or unchanged', async () => {
    write('2026-09-19T14:25:00Z', 1_758_291_900);
    await getUsageResponse();
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
    rmSync(SNAPSHOT, { force: true });
    await getUsageResponse();
    await getUsageResponse();
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(1);
  });

  it('still honours an explicit refresh', async () => {
    write('2026-09-19T14:25:00Z', 1_758_291_900);
    await getUsageResponse();
    await getUsageResponse(true);
    expect(fetchUsageThroughCdp).toHaveBeenCalledTimes(2);
  });
});
