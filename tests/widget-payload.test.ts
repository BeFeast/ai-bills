import { describe, expect, it, vi } from 'vitest';
// widget.ts reaches the usage service, whose CDP module loads the operator config at import time; none of that is exercised here.
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));
import { accountWindows } from '../src/lib/limits-hero';
import { PENDING_OBSERVATION, type ProviderUsage } from '../src/lib/usage';
import type { UsageResponseBody } from '../src/lib/usage-service';
import { buildWidgetPayload, localDate, modelTone } from '../src/lib/widget';

const now = Date.parse('2026-09-23T17:00:00Z');
const account = (key: string, provider: string, label: string) => ({ key, provider, label, email: `${key}@example.test`, websiteUrl: null, manageUrl: null, loginUrl: null, accountKeys: [] }) as unknown as ProviderUsage['account'];
const one = 'Claude · one@example.test'; const two = 'Claude · two@example.test';
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
    const work = claude('work', one, 40, 10); const personal = claude('personal', two, 5, 3, 2, 30);
    const payload = buildWidgetPayload({ usage: usage([personal, work]), snapshot: { body: ledger('2026-09-23'), version: new Date(now - 4 * 60_000).toISOString() }, now, timezone: 'UTC' });
    // The bar leads with the account-wide window (Work: Weekly all models 90 % vs Personal: Session 95 %), so Work is tighter.
    expect(payload.accounts.map(row => row.key)).toEqual(['work', 'personal']);
    expect(payload.accounts[0]).toMatchObject({ state: 'fresh', message: null,
      limiting: { label: 'Fable weekly', remainingPercent: 15, limiting: true, scoped: true },
      headline: { label: 'Session', remainingPercent: 60, scoped: false } });
    // Account-wide windows first, tightest first; the model-scoped allowance last, however tight it is.
    expect(payload.accounts[0].windows.map(w => [w.label, w.scoped])).toEqual([['Session', false], ['Weekly all models', false], ['Fable weekly', true]]);
    expect(payload.accounts[0].windows.map(({ scoped: _scoped, ...rest }) => rest).sort((a, b) => a.label.localeCompare(b.label))).toEqual([...accountWindows(work).windows].sort((a, b) => a.label.localeCompare(b.label)));
    expect(payload.accounts[1].headline).toMatchObject({ label: 'Session', remainingPercent: 95 });
    // The pool view: the model's best account first, the same numbers as the account rows.
    expect(payload.models).toEqual([{ provider: 'claude', label: 'Fable weekly', model: 'Fable', usable: true, tone: undefined, nextResetAt: '2026-09-26T12:00:00Z',
      best: { key: 'personal', label: two, state: 'fresh', remainingPercent: 70, tone: undefined, exhausted: false, resetsAt: '2026-09-26T12:00:00Z', observedAt: null },
      accounts: [
        { key: 'personal', label: two, state: 'fresh', remainingPercent: 70, tone: undefined, exhausted: false, resetsAt: '2026-09-26T12:00:00Z', observedAt: null },
        { key: 'work', label: one, state: 'fresh', remainingPercent: 15, tone: 'warn', exhausted: false, resetsAt: '2026-09-26T12:00:00Z', observedAt: null }] }]);
    expect(payload.snapshot).toMatchObject({ stale: false, reason: null, ageSeconds: 240, generatedAt: ledger('x').generated });
    expect(payload.today).toEqual({ date: '2026-09-23', byClient: [
      { name: 't3-claude', tokens: 289097590, requests: 1442, apiEquivalentUsd: null, pricedApiEquivalentUsd: 0 },
      { name: 'slava', tokens: 803952, requests: 31, apiEquivalentUsd: null, pricedApiEquivalentUsd: 0.33, failed: 0, rateLimited: 0 }] });
  });

  it('marks an old or missing snapshot stale, keeps pending and failed accounts visible at the end, and drops a yesterday ledger', () => {
    const pending: ProviderUsage = { account: account('kimi', 'kimi', 'Kimi'), ok: false, fetchedAt: '', sourceUrl: '', error: PENDING_OBSERVATION };
    const failed: ProviderUsage = { account: account('codex', 'codex', 'Codex'), ok: false, status: 403, fetchedAt: new Date(now).toISOString(), sourceUrl: '', error: 'Forbidden' };
    const stale = buildWidgetPayload({ usage: usage([pending, failed, claude('work', one, 40, 10, 30)]), snapshot: { body: ledger('2026-09-22'), version: new Date(now - 20 * 60_000).toISOString() }, now, timezone: 'UTC' });
    expect(stale.snapshot).toMatchObject({ stale: true, reason: 'snapshot-age', ageSeconds: 1200 });
    expect(stale.accounts.map(row => [row.key, row.state])).toEqual([['work', 'stale'], ['codex', 'error'], ['kimi', 'pending']]);
    expect(stale.accounts[0].limiting).not.toBeNull();
    expect(stale.accounts[2]).toMatchObject({ limiting: null, headline: null, windows: [], message: PENDING_OBSERVATION });
    // A Claude account that only reports a scoped window leads with it rather than with nothing.
    const onlyScoped: ProviderUsage = { account: account('solo', 'claude', 'Solo'), ok: true, fetchedAt: new Date(now).toISOString(), sourceUrl: 'snapshot',
      data: { limits: [{ kind: 'weekly_scoped', percent: 50, resets_at: '2026-09-26T12:00:00Z', is_active: true, scope: { model: { display_name: 'Fable' } } }] } };
    expect(buildWidgetPayload({ usage: usage([onlyScoped]), snapshot: { body: {}, version: null }, now, timezone: 'UTC' }).accounts[0].headline).toMatchObject({ label: 'Fable weekly', scoped: true, remainingPercent: 50 });
    // A header fallback keeps the account-wide windows fresh and the carried Fable window second, with its own time.
    const carried: ProviderUsage = { account: account('work', 'claude', one), ok: true, fetchedAt: new Date(now).toISOString(), sourceUrl: 'snapshot', source: 'proxy_headers',
      data: { five_hour: { utilization: 20, resets_at: '2026-09-23T20:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-09-27T00:00:00Z' },
        limits: [{ kind: 'weekly_scoped', percent: 100, resets_at: '2026-09-26T12:00:00Z', is_active: true, scope: { model: { display_name: 'Fable' } }, observed_at: '2026-09-23T16:40:00Z' }] } };
    const row = buildWidgetPayload({ usage: usage([carried]), snapshot: { body: {}, version: null }, now, timezone: 'UTC' }).accounts[0];
    expect(row.headline).toMatchObject({ label: 'Weekly all models', remainingPercent: 60, scoped: false });
    expect(row.windows.map(w => [w.label, w.scoped, w.observedAt ?? null])).toEqual([['Weekly all models', false, null], ['Session', false, null], ['Fable weekly', true, '2026-09-23T16:40:00Z']]);
    expect(stale.today).toBeNull();
    const none = buildWidgetPayload({ usage: usage([]), snapshot: { body: {}, version: null }, now, timezone: 'UTC' });
    expect(none.snapshot).toMatchObject({ stale: true, reason: 'no-snapshot', ageSeconds: null, generatedAt: null, receivedAt: null });
    expect(none.today).toBeNull();
  });

  it('aggregates a model-scoped allowance across the pool: the best account decides whether the model is usable', () => {
    const build = (accounts: ProviderUsage[]) => buildWidgetPayload({ usage: usage(accounts), snapshot: { body: {}, version: null }, now, timezone: 'UTC' }).models;
    // One account out, the other at 10 %: the pool still answers, and the reader sees which account does.
    const split = build([claude('alpha', one, 40, 10, 2, 100), claude('beta', two, 40, 10, 2, 90)]);
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({ label: 'Fable weekly', model: 'Fable', usable: true, tone: 'warn', best: { key: 'beta', remainingPercent: 10 } });
    expect(split[0].accounts.map(row => [row.key, row.remainingPercent, row.tone, row.exhausted])).toEqual([['beta', 10, 'warn', false], ['alpha', 0, 'bad', true]]);
    // Both out: nothing is usable, and the nearest reset says when the pool may answer again.
    const alphaOut: ProviderUsage = { ...claude('alpha', one, 40, 10, 2, 100), data: { ...claude('alpha', one, 40, 10, 2, 100).data as object,
      limits: [{ kind: 'weekly_scoped', percent: 100, resets_at: '2026-09-25T08:00:00Z', is_active: true, scope: { model: { display_name: 'Fable' } } }] } };
    const out = build([claude('beta', two, 40, 10, 2, 100), alphaOut]);
    expect(out[0]).toMatchObject({ usable: false, tone: 'bad', nextResetAt: '2026-09-25T08:00:00Z', best: { key: 'alpha', remainingPercent: 0, exhausted: true } });
    expect(out[0].accounts.map(row => row.key)).toEqual(['alpha', 'beta']);
    // An account whose fallback carried no scoped window is listed as unknown, last; the other account decides.
    const noWindow: ProviderUsage = { account: account('beta', 'claude', two), ok: true, fetchedAt: new Date(now).toISOString(), sourceUrl: 'snapshot', source: 'proxy_headers',
      data: { five_hour: { utilization: 20, resets_at: '2026-09-23T20:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-09-27T00:00:00Z' }, limits: [] } };
    const partial = build([noWindow, claude('alpha', one, 40, 10, 2, 100)]);
    expect(partial[0]).toMatchObject({ usable: false, best: { key: 'alpha', remainingPercent: 0 } });
    expect(partial[0].accounts[1]).toEqual({ key: 'beta', label: two, state: 'fresh', remainingPercent: null, tone: null, exhausted: false, resetsAt: null, observedAt: null });
    // A carried window keeps its own observation time on the account's entry.
    const carried: ProviderUsage = { ...noWindow, data: { ...noWindow.data as object, limits: [{ kind: 'weekly_scoped', percent: 60, resets_at: '2026-09-26T12:00:00Z', is_active: true, scope: { model: { display_name: 'Fable' } }, observed_at: '2026-09-23T16:40:00Z' }] } };
    expect(build([carried])[0]).toMatchObject({ usable: true, tone: undefined, best: { key: 'beta', remainingPercent: 40, observedAt: '2026-09-23T16:40:00Z' } });
    // A pending account of the same provider is listed as unknown; another provider's account is not; without any scoped window there is no model at all.
    const pending: ProviderUsage = { account: account('claude-new', 'claude', 'Claude · three@example.test'), ok: false, fetchedAt: '', sourceUrl: '', error: PENDING_OBSERVATION };
    const codex: ProviderUsage = { account: account('codex', 'codex', 'Codex'), ok: true, fetchedAt: new Date(now).toISOString(), sourceUrl: 'snapshot', data: { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 3600 } } } };
    const mixed = build([codex, pending, claude('alpha', one, 40, 10, 2, 50)]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0].accounts.map(row => [row.key, row.state, row.remainingPercent])).toEqual([['alpha', 'fresh', 50], ['claude-new', 'pending', null]]);
    expect(build([codex])).toEqual([]);
    // The pool tone: only nothing left is bad, under 25 % is a warning, 5 % still answers.
    expect([modelTone(0, false), modelTone(5, false), modelTone(24, false), modelTone(25, false), modelTone(50, true), modelTone(null, false)]).toEqual(['bad', 'warn', 'warn', undefined, 'bad', undefined]);
  });

  it('decides "today" in the instance timezone, not in UTC', () => {
    expect(localDate('UTC', new Date('2026-09-23T22:30:00Z'))).toBe('2026-09-23');
    expect(localDate('Asia/Jerusalem', new Date('2026-09-23T22:30:00Z'))).toBe('2026-09-24');
    const payload = buildWidgetPayload({ usage: usage([]), snapshot: { body: ledger('2026-09-24'), version: new Date('2026-09-23T22:30:00Z').toISOString() }, now: Date.parse('2026-09-23T22:30:00Z'), timezone: 'Asia/Jerusalem' });
    expect(payload.today?.date).toBe('2026-09-24');
  });
});
