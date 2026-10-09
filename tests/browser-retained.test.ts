import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));
vi.mock('../src/lib/config', () => ({ tenantAccounts: (config: { accounts: unknown[] }) => config.accounts, loadConfig: () => ({ accounts: [{ key: 'cursor', provider: 'cursor' }] }) }));
import { retainBrowserReading } from '../src/lib/usage-service';
import { usageEvidence, BROWSER_LAST_KNOWN_MS } from '../src/lib/usage-evidence';
import { sourceHealth } from '../src/lib/source-health';
import { rememberUsageObservations } from '../src/lib/usage-observations';
import type { ProviderUsage } from '../src/lib/usage';

const BUSY = 'Browser busy with another account; automatic refresh will retry';
const now = Date.parse('2026-10-09T07:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const account = { key: 'cursor', provider: 'cursor', label: 'Cursor', email: 'user@example.test' } as ProviderUsage['account'];
const good: ProviderUsage = { account, ok: true, status: 200, fetchedAt: at(15), sourceUrl: 'cursor', data: { individualUsage: { plan: { used: 10, limit: 100 } } } as unknown as ProviderUsage['data'] };
const failed = (error = BUSY, status?: number): ProviderUsage => ({ account, ok: false, status, error, fetchedAt: at(0), sourceUrl: 'cursor' });

afterEach(() => rememberUsageObservations([]));

describe('a failed browser read keeps the last good reading', () => {
  it('retains the previous answer with why the newest read failed', () => {
    expect(retainBrowserReading(good, failed(), now)).toMatchObject({ ok: true, fetchedAt: good.fetchedAt, data: good.data, source: 'retained',
      direct: { status: null, error: BUSY, attemptedAt: at(0) } });
  });

  it('keeps the original observation time through repeated failures', () => {
    const once = retainBrowserReading(good, failed(), now);
    expect(retainBrowserReading(once, failed(), now + 5 * 60_000).fetchedAt).toBe(good.fetchedAt);
  });

  it('lets a signed-out answer, a success, an old reading or another provider through', () => {
    expect(retainBrowserReading(good, failed('Unauthorized', 401), now).ok).toBe(false);
    const fresh = { ...good, fetchedAt: at(0) };
    expect(retainBrowserReading(good, fresh, now)).toBe(fresh);
    expect(retainBrowserReading({ ...good, fetchedAt: new Date(now - BROWSER_LAST_KNOWN_MS - 1).toISOString() }, failed(), now).ok).toBe(false);
    expect(retainBrowserReading(undefined, failed(), now).ok).toBe(false);
    const codex: ProviderUsage = { ...failed(), account: { ...account, provider: 'codex' } };
    expect(retainBrowserReading({ ...good, account: codex.account }, codex, now)).toBe(codex);
  });

  it('reads as last known, not as an error, and health calls it a fallback', () => {
    const retained = retainBrowserReading(good, failed(), now);
    expect(usageEvidence(retained, now)).toEqual({ state: 'stale', lastKnown: true, message: `Last known quota; the newest read failed: ${BUSY}.` });
    expect(usageEvidence(retained, Date.parse(good.fetchedAt) + BROWSER_LAST_KNOWN_MS + 1).lastKnown).toBeUndefined();
    rememberUsageObservations([retained]);
    expect(sourceHealth(now).sources[0]).toMatchObject({ status: 'fallback', fallback: { source: 'retained' }, maxAgeSeconds: BROWSER_LAST_KNOWN_MS / 1000 });
  });
});
