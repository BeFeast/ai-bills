import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`; });
import { fetchClaude, resetClaudeWebReadsForTests } from '../src/lib/cdp';
import { consistencyChecks, resetConsistencyChecksForTests } from '../src/lib/quota-consistency';
import type { AccountConfig } from '../src/lib/config';
import type { ClaudeUsagePayload, ProviderUsage } from '../src/lib/usage';

const now = Date.parse('2026-10-01T09:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const account: AccountConfig = { key: 'claude-personal', provider: 'claude', label: 'Claude · personal', email: 'personal@example.test',
  claude_org_id: '00000000-0000-4000-8000-000000000000', cdp_http: 'http://127.0.0.1:18811', cdp_profile_id: 'ai-bills-claude-personal', claude_web_quota: true };
const payload = (session: number, week: number, fable: number): ClaudeUsagePayload => ({
  five_hour: { utilization: session, resets_at: '2026-10-01T12:00:00Z' }, seven_day: { utilization: week, resets_at: '2026-10-01T17:00:00Z' },
  limits: [{ kind: 'session', percent: session }, { kind: 'weekly_all', percent: week }, { kind: 'weekly_scoped', percent: fable, resets_at: '2026-10-01T17:00:00Z', scope: { model: { display_name: 'Fable' } }, is_active: true }] });
const web = (data: ClaudeUsagePayload, minutesAgo = 0): ProviderUsage => ({ account, ok: true, status: 200, data, fetchedAt: at(minutesAgo), sourceUrl: 'claude.ai usage (account browser)', source: 'web' });
const signedOut = (): ProviderUsage => ({ account, ok: false, status: 401, error: 'claude.ai is signed out in the account browser', fetchedAt: at(0), sourceUrl: 'claude.ai', source: 'web' });
const snapshot = (entry: unknown) => ({ claude_usage: { 'personal@example.test': entry } });
const rejected429 = { ok: false, status: 429, error: 'Proxy quota request rejected (HTTP 429)', fetched_at: at(1) };
const expired = { ...rejected429, error: 'Proxy OAuth expired — re-login proxy', proxy_auth: { state: 'expired', message: 'invalid grant (retrying)', observed_at: at(1) } };

afterEach(() => { resetClaudeWebReadsForTests(); resetConsistencyChecksForTests(); });

describe('claude.ai as the second Claude quota source', () => {
  it('fills a failed proxy observation with session, week and Fable from the website, naming both', async () => {
    const readWeb = vi.fn(async () => web(payload(0, 74, 100)));
    const result = await fetchClaude(account, { snapshot: snapshot(expired) }, readWeb, now);
    expect(result).toMatchObject({ ok: true, source: 'web', direct: { status: 429, error: 'Proxy OAuth expired — re-login proxy' }, proxyAuth: { state: 'expired', message: 'invalid grant (retrying)' } });
    const data = result.data as ClaudeUsagePayload;
    expect(data.five_hour?.utilization).toBe(0);
    expect(data.seven_day).toMatchObject({ utilization: 74, resets_at: '2026-10-01T17:00:00Z' });
    expect(data.limits?.find((limit) => limit.kind === 'weekly_scoped')).toMatchObject({ percent: 100, resets_at: '2026-10-01T17:00:00Z' });
  });

  it('keeps the current proxy answer and reads the website only for the checker', async () => {
    const readWeb = vi.fn(async () => web(payload(11, 60, 79)));
    const entry = { ok: true, status: 200, source: 'direct', fetched_at: at(2), data: payload(11, 60, 79) };
    const first = await fetchClaude(account, { snapshot: snapshot(entry) }, readWeb, now);
    expect(first.source).toBeUndefined();
    expect(readWeb).toHaveBeenCalledTimes(1);
    // Inside the 30-minute check interval the healthy proxy needs no second read.
    await fetchClaude(account, { snapshot: snapshot(entry) }, readWeb, now + 5 * 60_000);
    expect(readWeb).toHaveBeenCalledTimes(1);
    expect(consistencyChecks(null)).toMatchObject([{ accountKey: 'claude-personal', verdict: 'consistent', flagged: false }]);
  });

  it('reads the website at most every 5 minutes while the proxy keeps failing', async () => {
    const readWeb = vi.fn(async () => web(payload(0, 74, 100)));
    await fetchClaude(account, { snapshot: snapshot(rejected429) }, readWeb, now);
    await fetchClaude(account, { snapshot: snapshot(rejected429) }, readWeb, now + 60_000);
    expect(readWeb).toHaveBeenCalledTimes(1);
    await fetchClaude(account, { snapshot: snapshot(rejected429) }, readWeb, now + 5 * 60_000);
    expect(readWeb).toHaveBeenCalledTimes(2);
  });

  it('prefers a newer collector fallback over an older website read and never uses a website read older than 5 h', async () => {
    const readWeb = vi.fn(async () => web(payload(0, 74, 100), 20));
    const retained = { ok: true, status: null, source: 'retained', fetched_at: at(10), data: payload(5, 70, 100), direct: { status: 429, error: 'Proxy quota request rejected (HTTP 429)' } };
    expect((await fetchClaude(account, { snapshot: snapshot(retained) }, readWeb, now)).source).toBe('retained');
    resetClaudeWebReadsForTests(); resetConsistencyChecksForTests();
    const old = vi.fn(async () => web(payload(0, 74, 100), 5 * 60 + 1));
    expect(await fetchClaude(account, { snapshot: snapshot(rejected429) }, old, now)).toMatchObject({ ok: false, status: 429 });
  });

  it('returns the proxy failure unchanged when the website is signed out', async () => {
    const result = await fetchClaude(account, { snapshot: snapshot(expired) }, vi.fn(async () => signedOut()), now);
    expect(result).toMatchObject({ ok: false, status: 429, proxyAuth: { state: 'expired' } });
  });

  it('leaves accounts without claude_web_quota exactly as before', async () => {
    const readWeb = vi.fn(async () => web(payload(0, 74, 100)));
    const result = await fetchClaude({ ...account, claude_web_quota: undefined }, { snapshot: snapshot(rejected429) }, readWeb, now);
    expect(readWeb).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, status: 429, error: 'Proxy quota request rejected (HTTP 429)' });
  });

  it('flags a proxy that says sign-in while the website says available after two consecutive checks', async () => {
    const readWeb = vi.fn(async () => web(payload(0, 74, 100)));
    await fetchClaude(account, { snapshot: snapshot(expired) }, readWeb, now);
    expect(consistencyChecks(null)[0]).toMatchObject({ verdict: 'mismatch', streak: 1, flagged: false, reason: 'proxy says sign_in, website says available' });
    await fetchClaude(account, { snapshot: snapshot(expired) }, readWeb, now + 30 * 60_000);
    expect(consistencyChecks(null)[0]).toMatchObject({ verdict: 'mismatch', streak: 2, flagged: true });
  });
});
