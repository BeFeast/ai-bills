import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vi.mock is hoisted above every const, so the mock repeats the path instead of referencing SNAPSHOT.
vi.mock('../src/lib/config', () => ({ loadConfig: () => ({ billing: { snapshot_path: join(tmpdir(), 'zecori-usage-snapshot-fallback-test.json') }, accounts: [] }) }));
const SNAPSHOT = join(tmpdir(), 'zecori-usage-snapshot-fallback-test.json');

import { fetchCodexFromSnapshot, fetchUsageThroughCdp } from '../src/lib/cdp';
import type { ProviderConfig } from '../src/lib/usage';

const claude = { key: 'claude-work', provider: 'claude', label: 'Work', email: 'work@example.test' } as ProviderConfig;
const codex = { key: 'codex-work', provider: 'codex', label: 'Work', email: 'work@example.test', quota_snapshot_key: 'proxy-key' } as ProviderConfig;
const write = (claudeEntry: unknown, codexEntry: unknown) => writeFileSync(SNAPSHOT, JSON.stringify({ claude_usage: { 'work@example.test': claudeEntry }, codex_usage: { 'proxy-key': codexEntry } }));
const direct = { status: 429, error: 'Proxy quota request rejected (HTTP 429)', attempted_at: '2026-09-21T08:35:04+00:00' };

afterEach(() => rmSync(SNAPSHOT, { force: true }));

describe('collector fallback observations', () => {
  it('carries the fallback source and the direct outcome, with the fallback observation time and no status', async () => {
    write({ ok: true, status: null, fetched_at: '2026-09-21T08:31:00+00:00', data: { five_hour: { utilization: 1 } }, source: 'proxy_headers', direct },
      { ok: true, status: null, fetched_at: '2026-09-21T08:30:04+00:00', data: { rate_limit: { primary_window: { used_percent: 13 } } }, source: 'retained', direct: { ...direct, status: null } });
    const work = await fetchUsageThroughCdp(claude);
    expect(work).toMatchObject({ ok: true, fetchedAt: '2026-09-21T08:31:00+00:00', source: 'proxy_headers', direct: { status: 429, error: 'Proxy quota request rejected (HTTP 429)', attemptedAt: '2026-09-21T08:35:04+00:00' } });
    expect(work.status).toBeUndefined();
    expect(fetchCodexFromSnapshot(codex)).toMatchObject({ ok: true, source: 'retained', direct: { status: null } });
  });
  it('leaves direct observations and failures as they were', async () => {
    write({ ok: true, status: 200, fetched_at: '2026-09-21T08:35:04+00:00', data: { five_hour: { utilization: 1 } }, source: 'direct' },
      { ok: false, status: 429, fetched_at: '2026-09-21T08:35:04+00:00', error: 'Proxy quota request rejected (HTTP 429)' });
    const work = await fetchUsageThroughCdp(claude);
    expect(work).toMatchObject({ ok: true, status: 200 });
    expect(work.source).toBeUndefined(); expect(work.direct).toBeUndefined();
    expect(fetchCodexFromSnapshot(codex)).toMatchObject({ ok: false, status: 429, error: 'Proxy quota request rejected (HTTP 429)' });
    write({ ok: true, fetched_at: '2026-09-21T08:35:04+00:00', data: { five_hour: { utilization: 1 } }, source: 'made-up' }, {});
    expect((await fetchUsageThroughCdp(claude)).source).toBeUndefined();
  });
});
