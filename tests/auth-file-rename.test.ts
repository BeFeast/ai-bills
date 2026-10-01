import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`; });

import { fetchClaudeFromSnapshot, fetchCodexFromSnapshot, fetchUsageThroughCdp } from '../src/lib/cdp';
import { bindAccountIdentities, type RegistryAccount } from '../src/lib/accounts';
import { buildGuardsReport, mappingCheck, mappingProblems } from '../src/lib/guards';
import { credentialId, quotaEntry } from '../src/lib/snapshot-keys';
import type { AccountConfig, AppConfig } from '../src/lib/config';

/**
 * The proxy renames a credential's auth file on re-login (live: claude-<email>.json → claude-<org8>-<email>.json).
 * Every file-name id changes; the account must stay linked, and the drift must be reported, not hidden.
 */
const id = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const EMAIL = 'personal@example.test';
const OLD_FILE = id('oauth:claude-personal@example.test.json');
const NEW_FILE = id('oauth:claude-c0ffee42-personal@example.test.json');
const STABLE = id(`oauth-account:claude:${EMAIL}`);
const account: AccountConfig = { key: 'claude-personal', provider: 'claude', label: 'Claude · personal', email: EMAIL, quota_snapshot_key: OLD_FILE };
const entry = { ok: true, status: 200, source: 'direct', fetched_at: '2026-10-01T10:30:00Z', data: { five_hour: { utilization: 3 }, seven_day: { utilization: 41 } } };
/** What the collector publishes after the rename: the new file-name key, the e-mail key and the stable key. */
const renamed = { claude_usage: { [NEW_FILE]: entry, [EMAIL]: entry, [STABLE]: entry },
  account_registry: { accounts: [{ id: NEW_FILE, provider: 'claude', label: 'claude OAuth', origin: 'oauth', aliases: [STABLE] }] } };

describe('a proxy rename of the credential file', () => {
  it('keeps the card linked through the e-mail key when quota_snapshot_key still names the old file', () => {
    const result = fetchClaudeFromSnapshot(account, renamed);
    expect(result).toMatchObject({ ok: true, fetchedAt: '2026-10-01T10:30:00Z' });
    expect(result.error).toBeUndefined();
    expect(quotaEntry(renamed.claude_usage, account)).toMatchObject({ key: EMAIL, viaEmailFallback: true });
    // The rename-proof id resolves directly.
    expect(quotaEntry(renamed.claude_usage, { ...account, quota_snapshot_key: STABLE })).toMatchObject({ key: STABLE, viaEmailFallback: false });
    expect(credentialId('claude', ' Personal@Example.test ')).toBe(STABLE);
    // Codex reads the same way.
    expect(fetchCodexFromSnapshot({ key: 'codex-personal', provider: 'codex', label: 'Codex', email: EMAIL, quota_snapshot_key: OLD_FILE },
      { codex_usage: { [EMAIL]: { ok: true, fetched_at: '2026-10-01T10:30:00Z', data: { rate_limit: {} } } } })?.ok).toBe(true);
  });

  it('never fills a missing key from an e-mail two configured accounts of one provider share', () => {
    const twin: AccountConfig = { ...account, key: 'claude-personal-team', quota_snapshot_key: 'e'.repeat(24) };
    expect(fetchClaudeFromSnapshot(account, renamed, [account, twin])).toMatchObject({ ok: false, error: 'no claude_usage entry in snapshot' });
    // Another provider with the same address is no ambiguity.
    expect(fetchClaudeFromSnapshot(account, renamed, [account, { ...twin, provider: 'codex' }]).ok).toBe(true);
  });

  it('matches a binding through the stable alias, and still through an old file-name member', () => {
    const row = (accountId: string, aliasIds?: string[]): RegistryAccount => ({ id: accountId, provider: 'claude', label: 'claude OAuth', origin: 'oauth', billingMode: 'unknown', routingEnrolled: false,
      quota: { status: 'unknown', remaining: null, resetAt: null }, coverage: { status: 'partial', reason: '' }, observedAt: '', ...(aliasIds ? { aliasIds } : {}) });
    const binding = { id: OLD_FILE, label: 'Claude · personal', members: [OLD_FILE, STABLE], quota_account_key: 'claude-personal' };
    // After the rename only the alias connects the new file to the binding; the ledger keeps the binding's id.
    expect(bindAccountIdentities([row(NEW_FILE, [STABLE])], [binding]).map(entry => [entry.id, entry.label])).toEqual([[OLD_FILE, 'Claude · personal']]);
    expect(bindAccountIdentities([row(OLD_FILE)], [binding]).map(entry => entry.id)).toEqual([OLD_FILE]);
    expect(bindAccountIdentities([row(NEW_FILE)], [binding]).map(entry => entry.id)).toEqual([NEW_FILE]);
    // Two credentials carrying one alias (one e-mail, two auth files): the alias binds neither.
    const second = id('oauth:claude-second.json');
    expect(bindAccountIdentities([row(NEW_FILE, [STABLE]), row(second, [STABLE])], [{ ...binding, members: [STABLE] }]).map(entry => entry.id).sort()).toEqual([NEW_FILE, second].sort());
  });

  it('reports the drift of every configured link, and is quiet once the configuration uses the stable id', () => {
    const stale = { accounts: [account], account_browsers: [{ account_key: 'claude-personal', profile_id: 'p', cdp_http: 'http://127.0.0.1:1', remote_url: 'https://x.example.test', login_url: 'https://claude.ai/login', manage_url: 'https://claude.ai/', proxy_account_id: OLD_FILE }],
      accounting: { account_bindings: [{ id: id('declared-binding'), label: 'Claude · personal', members: [OLD_FILE], quota_account_key: 'claude-personal' }] } } as unknown as AppConfig;
    const problems = mappingProblems(stale, renamed);
    expect(problems.map(problem => problem.problem)).toEqual([
      'quota_snapshot_key is not in the snapshot; the card uses the e-mail key meanwhile',
      'the account browser\'s proxy_account_id is not in the snapshot',
      'binding Claude · personal matches no credential in the proxy inventory',
    ]);
    const report = buildGuardsReport({ accounts: [], checks: [], snapshot: renamed, now: Date.parse('2026-10-01T10:31:00Z'), config: stale });
    expect(report.guards.mapping).toMatchObject({ status: 'down', message: expect.stringContaining('claude-personal: quota_snapshot_key') });
    const fixed = { ...stale, accounts: [{ ...account, quota_snapshot_key: STABLE }], account_browsers: [{ ...stale.account_browsers![0], proxy_account_id: STABLE }],
      accounting: { account_bindings: [{ ...stale.accounting!.account_bindings![0], members: [OLD_FILE, STABLE] }] } } as unknown as AppConfig;
    expect(mappingProblems(fixed, renamed)).toEqual([]);
    expect(buildGuardsReport({ accounts: [], checks: [], snapshot: renamed, now: 0, config: fixed }).guards.mapping.status).toBe('up');
  });

  it('treats a collector outage as an outage, not as configuration drift', () => {
    const stale = { accounts: [account], accounting: { account_bindings: [{ id: OLD_FILE, members: [OLD_FILE], quota_account_key: 'claude-personal' }] } } as unknown as AppConfig;
    // The collector's failure output: an empty quota bucket and an inventory whose oauth source failed.
    const failed = { claude_usage: {}, account_registry: { accounts: [{ id: id('configured:x'), provider: 'x' }], sources: [{ id: 'oauth', status: 'error' }] } };
    expect(mappingProblems(stale, failed)).toEqual([]);
    expect(mappingProblems(stale, { claude_usage: {}, account_registry: { accounts: [] } })).toEqual([]);
  });

  it('judges only collector-observed links', () => {
    const settings = { accounts: [account, { key: 'kimi-work', provider: 'kimi', label: 'Kimi', email: EMAIL }],
      account_browsers: [
        { account_key: 'kimi-work', profile_id: 'p', cdp_http: 'http://127.0.0.1:1', remote_url: 'https://x.example.test', login_url: 'https://www.kimi.ai/', manage_url: 'https://www.kimi.ai/', proxy_account_id: 'f'.repeat(24) },
        // A routing-policy id, and one that names a binding: neither is a collector key.
        { account_key: 'claude-personal', profile_id: 'p', cdp_http: 'http://127.0.0.1:1', remote_url: 'https://x.example.test', login_url: 'https://claude.ai/login', manage_url: 'https://claude.ai/', proxy_account_id: 'route-personal' },
      ],
      accounting: { account_bindings: [
        { id: id('declared:kimi-work'), label: 'Kimi', members: [id('declared:kimi-work')], quota_account_key: 'kimi-work' },
        { id: STABLE, label: 'Claude · personal', members: [], quota_account_key: 'claude-personal' },
      ] } } as unknown as AppConfig;
    expect(mappingProblems({ ...settings, accounts: [{ ...account, quota_snapshot_key: STABLE }, settings.accounts[1]] }, renamed)).toEqual([]);
    // A binding with no members is judged by its own id.
    const gone = { ...settings, accounts: [{ ...account, quota_snapshot_key: STABLE }, settings.accounts[1]],
      accounting: { account_bindings: [{ id: OLD_FILE, label: 'Claude · personal', members: [], quota_account_key: 'claude-personal' }] } } as unknown as AppConfig;
    expect(mappingProblems(gone, renamed).map(problem => problem.problem)).toEqual(['binding Claude · personal matches no credential in the proxy inventory']);
  });

  it('applies the shared-e-mail rule on the production path, and the guard words it the same way', async () => {
    const twin: AccountConfig = { ...account, key: 'claude-personal-team', quota_snapshot_key: 'e'.repeat(24) };
    const accounts = [account, twin];
    // usage-service hands the tenant's accounts to every fetch.
    expect(await fetchUsageThroughCdp(account, { snapshot: renamed, accounts })).toMatchObject({ ok: false, error: 'no claude_usage entry in snapshot' });
    expect((await fetchUsageThroughCdp(account, { snapshot: renamed, accounts: [account] })).ok).toBe(true);
    const problems = mappingProblems({ accounts } as unknown as AppConfig, renamed);
    expect(problems.find(problem => problem.subject === 'claude-personal')?.problem).toBe('quota_snapshot_key is not in the snapshot; the card has no proxy observation');
    // An account with the website source still shows numbers: say which.
    expect(mappingProblems({ accounts: [{ ...account, claude_web_quota: true }, twin] } as unknown as AppConfig, renamed)[0].problem).toBe('quota_snapshot_key is not in the snapshot; the card shows only the website reading');
  });

  it('skips a proxy_account_id that names a binding, and does not count an alias two credentials share', () => {
    const settings = { accounts: [{ ...account, quota_snapshot_key: STABLE }],
      account_browsers: [{ account_key: 'claude-personal', profile_id: 'p', cdp_http: 'http://127.0.0.1:1', remote_url: 'https://x.example.test', login_url: 'https://claude.ai/login', manage_url: 'https://claude.ai/', proxy_account_id: OLD_FILE }],
      accounting: { account_bindings: [{ id: OLD_FILE, label: 'Claude · personal', members: [OLD_FILE, STABLE], quota_account_key: 'claude-personal' }] } } as unknown as AppConfig;
    expect(mappingProblems(settings, renamed)).toEqual([]);
    const shared = { ...renamed, account_registry: { accounts: [
      { id: NEW_FILE, provider: 'claude', aliases: [STABLE] }, { id: id('oauth:claude-second.json'), provider: 'claude', aliases: [STABLE] }] } };
    expect(mappingProblems(settings, shared).map(problem => problem.problem)).toEqual(['binding Claude · personal matches no credential in the proxy inventory']);
  });

  it('names the checks an outage skipped instead of claiming every link resolves', () => {
    const settings = { accounts: [account], accounting: { account_bindings: [{ id: OLD_FILE, members: [OLD_FILE], quota_account_key: 'claude-personal' }] },
      account_browsers: [{ account_key: 'claude-personal', profile_id: 'p', cdp_http: 'http://127.0.0.1:1', remote_url: 'https://x.example.test', login_url: 'https://claude.ai/login', manage_url: 'https://claude.ai/', proxy_account_id: NEW_FILE }] } as unknown as AppConfig;
    const outage = { claude_usage: {}, account_registry: { accounts: [{ id: NEW_FILE, provider: 'claude' }], sources: [{ id: 'oauth', status: 'error' }, { id: 'configured', status: 'fresh' }] } };
    expect(mappingCheck(settings, outage)).toEqual({ problems: [], skipped: [
      'claude quota keys not checked: the snapshot carries no claude observations', 'bindings not checked: the proxy inventory is missing or incomplete',
      'account browser proxy_account_id not checked: the proxy inventory or quota observations are missing'] });
    const report = buildGuardsReport({ accounts: [], checks: [], snapshot: outage, now: 0, config: settings });
    expect(report.guards.mapping).toMatchObject({ status: 'up', message: expect.stringContaining('No drift found in what the snapshot carries (claude quota keys not checked') });
    // Only the OAuth inventory gates the binding check; a failed configured-key source does not.
    const configuredFailed = { ...renamed, account_registry: { ...renamed.account_registry, sources: [{ id: 'oauth', status: 'fresh' }, { id: 'configured', status: 'error' }] } };
    expect(mappingCheck(settings, configuredFailed).problems.map(problem => problem.problem)).toContain('binding ' + OLD_FILE + ' matches no credential in the proxy inventory');
  });

  it('judges nothing a partner snapshot does not carry', () => {
    expect(mappingProblems({ accounts: [account] } as unknown as AppConfig, { generated: 'x' })).toEqual([]);
  });
});
