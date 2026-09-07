vi.hoisted(() => { process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`; });
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyQuotaObservations, applyRoutingEnrollment, bindAccountIdentities, discoverConfiguredAccounts, type RegistryAccount } from '../src/lib/accounts';
import { opaqueId } from '../src/lib/accounting';
import { fetchCodexFromSnapshot } from '../src/lib/cdp';
import { loadConfig, resetConfigCache } from '../src/lib/config';
import type { ProviderUsage } from '../src/lib/usage';
const now = Date.parse('2026-01-10T12:00:00Z');
const accounts = () => discoverConfiguredAccounts({ 'codex-api-key': [{ 'api-key': 'synthetic-a' }, { 'api-key': 'synthetic-b' }] }, new Date(now).toISOString());
const observation = (key: string): ProviderUsage => ({ account: { key, provider: 'claude', label: key, email: 'same@example.invalid' }, ok: true, status: 200, fetchedAt: new Date(now - 1000).toISOString(), sourceUrl: 'fixture', data: { five_hour: { utilization: 10, resets_at: '2026-01-10T13:00:00Z' }, seven_day: { utilization: 75, resets_at: '2026-01-12T00:00:00Z' } } });
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); resetConfigCache(); });

describe('account identity and quota evidence', () => {
  it('does not merge accounts unless the operator declares both aliases', () => {
    const rows = accounts();
    expect(bindAccountIdentities(rows, [])).toHaveLength(2);
    const merged = bindAccountIdentities(rows, [{ id: 'canonical', label: 'One subscription', members: rows.map((row) => row.id) }]);
    expect(merged).toHaveLength(1); expect(merged[0].id).toBe('canonical'); expect(merged[0].memberIds).toHaveLength(2);
    expect(() => bindAccountIdentities(rows, [{ id: 'one', members: [rows[0].id] }, { id: 'two', members: [rows[0].id] }])).toThrow(/conflicting/);
  });
  it('projects the most constrained real quota and preserves stale/error uncertainty', () => {
    const rows = accounts(); const bindings = [{ id: rows[0].id, members: [], quota_account_key: 'quota-a' }];
    applyQuotaObservations(rows, [observation('quota-a')], bindings, now);
    expect(rows[0].quota).toMatchObject({ status: 'fresh', remaining: 25, unit: 'percent', resetAt: '2026-01-12T00:00:00Z' });
    expect(rows[1].quota.status).toBe('unknown');
    const stale = observation('quota-a'); stale.fetchedAt = '2026-01-01T00:00:00Z';
    const staleRows = accounts(); applyQuotaObservations(staleRows, [stale], bindings, now);
    expect(staleRows[0].quota).toMatchObject({ status: 'stale', remaining: null });
    const failed = observation('quota-a'); failed.ok = false; failed.status = 401;
    const failedRows = accounts(); applyQuotaObservations(failedRows, [failed], bindings, now);
    expect(failedRows[0].quota).toMatchObject({ status: 'error', remaining: null });
  });
  it('uses active policy enrollment and route evidence, never snapshot enrollment', () => {
    const rows = accounts();
    applyRoutingEnrollment(rows, { accounts: [{ id: rows[0].id, enabled: true }], models: [{ routes: [{ account_id: rows[0].id, billing: 'included' }] }] });
    expect(rows[0]).toMatchObject({ routingEnrolled: true, billingMode: 'included' });
    expect(rows[1]).toMatchObject({ routingEnrolled: false, billingMode: 'unknown' });
  });
  it('links declared quota without an explicit alias only to its exact declared registry identity', () => {
    const rows = accounts(); rows[0].id = opaqueId('declared:quota-a');
    applyQuotaObservations(rows, [observation('quota-a')], [], now);
    expect(rows[0].quota.remaining).toBe(25); expect(rows[1].quota.remaining).toBeNull();
  });
});

describe('proxy-owned Codex snapshot observations', () => {
  async function snapshot(data: unknown) {
    const directory = await mkdtemp(join(tmpdir(), 'ai-bills-quota-')); temporary.push(directory);
    const path = join(directory, 'snapshot.json'); await writeFile(path, JSON.stringify(data));
    resetConfigCache(); const config = loadConfig('tests/fixtures/accounts.toml'); config.billing.snapshot_path = path;
  }
  const account = { key: 'codex-example', provider: 'codex' as const, label: 'Codex example', email: 'fixture@example.invalid', quota_snapshot_key: 'binding' };
  it('uses collector quota and preserves original source timestamp', async () => {
    await snapshot({ codex_usage: { binding: { ok: true, status: 200, fetched_at: '2026-01-01T00:00:00Z', data: { rate_limit: { primary_window: { used_percent: 30 } } } } } });
    expect(fetchCodexFromSnapshot(account)).toMatchObject({ ok: true, sourceUrl: 'proxy-collector:codex-quota', fetchedAt: '2026-01-01T00:00:00Z' });
  });
  it('returns a failed observation on 401 or missing explicit binding, preventing fallback refresh', async () => {
    await snapshot({ codex_usage: { binding: { ok: false, status: 401, fetched_at: '2026-01-01T00:00:00Z', error: 'Rejected' } } });
    expect(fetchCodexFromSnapshot(account)).toMatchObject({ ok: false, status: 401 });
    expect(fetchCodexFromSnapshot({ ...account, quota_snapshot_key: 'missing' })).toMatchObject({ ok: false, fetchedAt: '' });
    expect(fetchCodexFromSnapshot({ ...account, quota_snapshot_key: undefined })).toBeNull();
  });
});
