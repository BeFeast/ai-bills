import { describe, expect, it, vi } from 'vitest';
// widget.ts reaches the usage service, whose CDP module loads the operator config at import time; none of that is exercised here.
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));
import { accountWindows } from '../src/lib/limits-hero';
import { PENDING_OBSERVATION, type ProviderUsage } from '../src/lib/usage';
import type { UsageResponseBody } from '../src/lib/usage-service';
import { buildWidgetPayload, localDate } from '../src/lib/widget';

const now = Date.parse('2026-09-23T17:00:00Z');
const account = (key: string, provider: string, label: string) => ({ key, provider, label, email: `${key}@example.test`, websiteUrl: null, manageUrl: null, loginUrl: null, accountKeys: [] }) as unknown as ProviderUsage['account'];
const claude = (key: string, label: string, fiveHour: number, weekly: number, minutesAgo = 2, fable = 85): ProviderUsage => ({
  account: account(key, 'claude', label), ok: true, fetchedAt: new Date(now - minutesAgo * 60_000).toISOString(), sourceUrl: 'snapshot',
  data: { five_hour: { utilization: fiveHour, resets_at: '2026-09-23T20:00:00Z' }, seven_day: { utilization: weekly, resets_at: '2026-09-27T00:00:00Z' },
    limits: [{ kind: 'weekly_scoped', percent: fable, resets_at: '2026-09-26T12:00:00Z', is_active: true, scope: { model: { display_name: 'Fable' } } }] },
});
const usage = (accounts: ProviderUsage[]): UsageResponseBody => ({ generatedAt: new Date(now - 30_000).toISOString(), timezone: 'UTC', accounts, combined: { models: [] } as never, apiShape: {}, refreshing: false });
const ledger = (date: string) => ({ generated: new Date(now - 60_000).toISOString(), usage_ledger: { today: { date, period: 'day', by_client: [
  { name: 'slava', priced_api_equivalent_usd: 0.33, api_equivalent_usd: null, tokens: 803952, requests: 31, failed: 0, rate_limited: 0 },
  { name: 't3-claude', priced_api_equivalent_usd: 0, tokens: 289097590, requests: 1442 }] } } });

describe('widget payload', () => {
  it('reports the same windows as the Overview hero and sorts the tightest account first', () => {
    const work = claude('work', 'Work', 40, 10); const personal = claude('personal', 'Personal', 5, 3, 2, 30);
    const payload = buildWidgetPayload({ usage: usage([personal, work]), snapshot: { body: ledger('2026-09-23'), version: new Date(now - 4 * 60_000).toISOString() }, now, timezone: 'UTC' });
    expect(payload.accounts.map(row => row.key)).toEqual(['work', 'personal']);
    expect(payload.accounts[0]).toMatchObject({ state: 'fresh', message: null, limiting: { label: 'Fable weekly', remainingPercent: 15, limiting: true } });
    expect(payload.accounts[0].windows).toEqual(accountWindows(work).windows);
    expect(payload.snapshot).toMatchObject({ stale: false, reason: null, ageSeconds: 240, generatedAt: ledger('x').generated });
    expect(payload.today).toEqual({ date: '2026-09-23', byClient: [
      { name: 't3-claude', tokens: 289097590, requests: 1442, apiEquivalentUsd: null, pricedApiEquivalentUsd: 0 },
      { name: 'slava', tokens: 803952, requests: 31, apiEquivalentUsd: null, pricedApiEquivalentUsd: 0.33, failed: 0, rateLimited: 0 }] });
  });

  it('marks an old or missing snapshot stale, keeps pending and failed accounts visible at the end, and drops a yesterday ledger', () => {
    const pending: ProviderUsage = { account: account('kimi', 'kimi', 'Kimi'), ok: false, fetchedAt: '', sourceUrl: '', error: PENDING_OBSERVATION };
    const failed: ProviderUsage = { account: account('codex', 'codex', 'Codex'), ok: false, status: 403, fetchedAt: new Date(now).toISOString(), sourceUrl: '', error: 'Forbidden' };
    const stale = buildWidgetPayload({ usage: usage([pending, failed, claude('work', 'Work', 40, 10, 30)]), snapshot: { body: ledger('2026-09-22'), version: new Date(now - 20 * 60_000).toISOString() }, now, timezone: 'UTC' });
    expect(stale.snapshot).toMatchObject({ stale: true, reason: 'snapshot-age', ageSeconds: 1200 });
    expect(stale.accounts.map(row => [row.key, row.state])).toEqual([['work', 'stale'], ['codex', 'error'], ['kimi', 'pending']]);
    expect(stale.accounts[0].limiting).not.toBeNull();
    expect(stale.accounts[2]).toMatchObject({ limiting: null, windows: [], message: PENDING_OBSERVATION });
    expect(stale.today).toBeNull();
    const none = buildWidgetPayload({ usage: usage([]), snapshot: { body: {}, version: null }, now, timezone: 'UTC' });
    expect(none.snapshot).toMatchObject({ stale: true, reason: 'no-snapshot', ageSeconds: null, generatedAt: null, receivedAt: null });
    expect(none.today).toBeNull();
  });

  it('decides "today" in the instance timezone, not in UTC', () => {
    expect(localDate('UTC', new Date('2026-09-23T22:30:00Z'))).toBe('2026-09-23');
    expect(localDate('Asia/Jerusalem', new Date('2026-09-23T22:30:00Z'))).toBe('2026-09-24');
    const payload = buildWidgetPayload({ usage: usage([]), snapshot: { body: ledger('2026-09-24'), version: new Date('2026-09-23T22:30:00Z').toISOString() }, now: Date.parse('2026-09-23T22:30:00Z'), timezone: 'Asia/Jerusalem' });
    expect(payload.today?.date).toBe('2026-09-24');
  });
});
