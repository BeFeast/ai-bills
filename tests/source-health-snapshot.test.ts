import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/lib/config', () => ({ loadConfig: () => ({
  billing: { snapshot_path: join(tmpdir(), 'zecori-source-health-test-snapshot.json') },
  accounts: [
    { key: 'claude-work', provider: 'claude', label: 'Work', email: 'work@example.test' },
    { key: 'codex-work', provider: 'codex', label: 'Work', email: 'work@example.test', quota_snapshot_key: 'proxy-key' },
  ],
}) }));

import { sourceHealth } from '../src/lib/source-health';
import { rememberUsageObservations } from '../src/lib/usage-observations';

const SNAPSHOT = join(tmpdir(), 'zecori-source-health-test-snapshot.json');
const now = Date.parse('2026-09-19T15:40:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const write = (claude: unknown, codex: unknown) => writeFileSync(SNAPSHOT, JSON.stringify({ claude_usage: { 'work@example.test': claude }, codex_usage: { 'proxy-key': codex } }));

afterEach(() => { rememberUsageObservations([]); rmSync(SNAPSHOT, { force: true }); });

describe('collector-observed sources', () => {
  it('reports the collector observation when nothing in this process has read it', () => {
    write({ ok: true, fetched_at: at(4) }, { ok: true, fetched_at: at(4) });
    const health = sourceHealth(now);
    expect(health.collection).toBe('fresh');
    expect(health.sources.map(row => [row.id, row.status, row.observedAt])).toEqual([
      ['claude-work', 'fresh', at(4)], ['codex-work', 'fresh', at(4)],
    ]);
  });

  it('keeps ageing and failure visible', () => {
    write({ ok: true, fetched_at: at(70) }, { ok: false, fetched_at: at(1), error: 'collector fetch failed' });
    const health = sourceHealth(now);
    expect(health.sources.map(row => row.status)).toEqual(['stale', 'error']);
    expect(health.collection).toBe('degraded');
  });

  it('prefers whichever observation is newer and survives a missing snapshot', () => {
    write({ ok: true, fetched_at: at(30) }, { ok: true, fetched_at: at(30) });
    rememberUsageObservations([{ account: { key: 'claude-work', provider: 'claude', label: 'Work', email: 'work@example.test' }, ok: true, fetchedAt: at(2), sourceUrl: 'snapshot' }]);
    expect(sourceHealth(now).sources[0]).toMatchObject({ status: 'fresh', observedAt: at(2) });
    // The in-process reader is older than the collector's own observation: the collector's wins.
    rememberUsageObservations([{ account: { key: 'claude-work', provider: 'claude', label: 'Work', email: 'work@example.test' }, ok: true, fetchedAt: at(90), sourceUrl: 'snapshot' }]);
    expect(sourceHealth(now).sources[0]).toMatchObject({ status: 'stale', observedAt: at(30) });
    rmSync(SNAPSHOT, { force: true });
    expect(sourceHealth(now).sources.map(row => row.status)).toEqual(['stale', 'missing']);
  });

  it('never publishes an address or a payload', () => {
    write({ ok: true, fetched_at: at(1), data: { seven_day: { utilization: 3 } } }, { ok: true, fetched_at: at(1) });
    expect(JSON.stringify(sourceHealth(now))).not.toMatch(/example\.test|utilization|proxy-key/);
  });
});
