import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountingOverview, appendFinancialRecords, currentMonth, freshness, opaqueId, readFinancialSource, validateRecord } from '../src/lib/accounting';
import { accountRegistry, discoverConfiguredAccounts } from '../src/lib/accounts';
import { loadConfig, resetConfigCache } from '../src/lib/config';
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'accounting-test-')); directories.push(path); return path; }
afterEach(async () => { resetConfigCache(); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const record = { sourceId: 'invoice', sourceRecordId: 'payment-1', accountId: 'test-account', provider: 'test', kind: 'payment', amount: 20, currency: 'USD', date: '2026-09-07' };

describe('financial journal', () => {
  test('concurrent imports are durable and idempotent; conflicting corrections never overwrite', async () => {
    const path = join(await directory(), 'payments.jsonl');
    const results = await Promise.all([appendFinancialRecords(path, [record]), appendFinancialRecords(path, [record])]);
    expect(results.reduce((n, r) => n + r.inserted, 0)).toBe(1);
    const before = await readFile(path, 'utf8');
    await expect(appendFinancialRecords(path, [{ ...record, amount: 30 }])).rejects.toThrow('Conflicting');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
  test('payments, accruals and estimates stay separate and foreign currency is not silently converted', async () => {
    const path = join(await directory(), 'payments.jsonl');
    await appendFinancialRecords(path, [record, { ...record, sourceRecordId: 'usage-1', kind: 'accrual', amount: 4 }, { ...record, sourceRecordId: 'equivalent-1', kind: 'api-equivalent', amount: 100 }, { ...record, sourceRecordId: 'eur', currency: 'EUR', amount: 50 }]);
    const view = await accountingOverview({ journal_path: path }, '2026-09');
    expect([view.paymentsUsd, view.accruedUsd, view.apiEquivalentUsd]).toEqual([20, 4, 100]);
    expect(view.complete).toBe(false);
    expect(view.diagnostics.join(' ')).toContain('EUR');
    expect((await accountingOverview({ journal_path: path }, '2026-08')).paymentsUsd).toBeNull();
  });
  test('validates dates, kinds and source identities before any append', () => {
    expect(() => validateRecord({ ...record, date: '2026-02-30' })).toThrow();
    expect(() => validateRecord({ ...record, amount: Infinity })).toThrow();
    expect(() => validateRecord({ ...record, kind: 'cost' })).toThrow();
  });
  test('Jerusalem month boundary follows local time', () => {
    expect(currentMonth('Asia/Jerusalem', new Date('2026-08-31T22:00:00Z'))).toBe('2026-09');
  });
});

describe('source adapters and inventory', () => {
  test('provider field maps retain source freshness rather than treating a successful read as current', async () => {
    const path = join(await directory(), 'source.json');
    await writeFile(path, JSON.stringify({ at: '2020-01-01T00:00:00Z', data: [{ id: 'invoice-3', dollars: 1.5, day: '2026-09-07' }] }));
    const source = await readFinancialSource({ id: 'provider', kind: 'json-file', path, records_path: 'data', observed_at_path: 'at', account_id: 'account', provider: 'test', currency: 'USD', record_kind: 'accrual', fields: { sourceRecordId: 'id', amount: 'dollars', date: 'day' } });
    expect(source.records[0].amount).toBe(1.5); expect(source.freshness.status).toBe('stale');
    expect((await readFinancialSource({ id: 'unknown', kind: 'unsupported' })).freshness.status).toBe('unsupported');
    expect(freshness('no-date', null).status).toBe('missing');
  });
  test('configured accounts remain distinct without leaking keys/endpoints or auto-enrollment', () => {
    const rows = discoverConfiguredAccounts({ 'codex-api-key': [{ 'api-key': 'test-secret' }], 'openai-compatibility': [{ name: 'example', 'base-url': 'https://private.invalid', 'api-key-entries': [{ 'api-key': 'secret-a' }, { 'api-key': 'secret-b' }] }] }, new Date().toISOString());
    expect(rows).toHaveLength(3); expect(new Set(rows.map(row => row.id)).size).toBe(3);
    expect(rows.every(row => !row.routingEnrolled && row.billingMode === 'unknown')).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/test-secret|secret-a|secret-b|private.invalid/);
  });
  test('direct Meta and OpenCode Muse remain independent accounts without inferred quota or routing', async () => {
    const config = loadConfig('tests/fixtures/accounts.toml');
    config.accounting = { declared_accounts: [
      { id: 'direct-meta', provider: 'meta', label: 'Muse Code / Meta', website_url: 'https://dev.meta.ai/' },
      { id: 'opencode-muse', provider: 'opencode', label: 'OpenCode Muse', website_url: 'https://opencode.ai/' },
    ] };
    const view = await accountRegistry(config);
    const accounts = view.accounts.filter(row => ['Muse Code / Meta', 'OpenCode Muse'].includes(row.label));
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map(row => row.id)).size).toBe(2);
    expect(accounts.every(row => row.quota.remaining === null && row.quota.status === 'unknown' && row.routingEnrolled !== true)).toBe(true);
    expect(accounts.find(row => row.provider === 'meta')?.websiteUrl).toBe('https://dev.meta.ai/');
  });
  test('OpenRouter funds attach only to the explicitly declared account', async () => {
    const config = loadConfig('tests/fixtures/accounts.toml');
    config.accounting = { openrouter_account_id: 'openrouter-main', declared_accounts: [
      { id: 'openrouter-main', provider: 'openrouter', label: 'OpenRouter main' },
      { id: 'openrouter-other', provider: 'openrouter', label: 'Other OpenRouter account' },
    ] };
    config.billing.snapshot_path = join(await directory(), 'snapshot.json');
    const observedAt = new Date().toISOString();
    await writeFile(config.billing.snapshot_path, JSON.stringify({ openrouter: {
      credits: { ok: true, observedAt, balanceUsd: 10, totalUsageUsd: 1 },
      key: { ok: true, observedAt, usageUsd: 0, limitUsd: null },
    } }));
    let view = await accountRegistry(config);
    expect(view.accounts.find(row => row.label === 'OpenRouter main')?.proxyConfigured).toBe(false);
    const snapshot = JSON.parse(await readFile(config.billing.snapshot_path, 'utf8'));
    snapshot.account_registry = { generatedAt: observedAt, accounts: [{ id: 'a'.repeat(24), provider: 'OpenRouter', label: 'Proxy credential', origin: 'configured' }] };
    await writeFile(config.billing.snapshot_path, JSON.stringify(snapshot));
    config.accounting.account_bindings = [{ id: opaqueId('declared:openrouter-main'), members: [opaqueId('declared:openrouter-main'), 'a'.repeat(24)], label: 'OpenRouter main' }];
    view = await accountRegistry(config);
    expect(view.accounts.find(row => row.funds)?.proxyConfigured).toBe(true);
    expect(view.accounts.find(row => row.funds)?.routingEnrolled).not.toBe(true);
    expect(view.accounts.find(row => row.label === 'OpenRouter main')?.funds?.accountBalance.usd).toBe(10);
    expect(view.accounts.find(row => row.label === 'Other OpenRouter account')?.funds).toBeUndefined();
    expect(view.sources.find(row => row.id === 'openrouter-key-usage')?.status).toBe('fresh');
  });
  test('remote sanitized collector inventory works without access to the OAuth directory', async () => {
    const path = join(await directory(), 'snapshot.json');
    await writeFile(path, JSON.stringify({ account_registry: { generatedAt: '2020-01-01T00:00:00Z', accounts: [{ id: 'a'.repeat(24), provider: 'test', label: 'Remote OAuth', origin: 'oauth', access_token: 'never-output', routingEnrolled: true }], sources: [] } }));
    const config = loadConfig('tests/fixtures/accounts.toml'); config.billing.snapshot_path = path;
    const view = await accountRegistry(config);
    expect(view.accounts.some(row => row.label === 'Remote OAuth' && !row.routingEnrolled)).toBe(true);
    expect(view.sources.find(row => row.id === 'collector-account-registry')?.status).toBe('stale');
    expect(JSON.stringify(view)).not.toContain('never-output');
  });
});
