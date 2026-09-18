import { describe, expect, it } from 'vitest';
import { accountWindows, buildLimitsHero } from '../src/lib/limits-hero';
import type { RegistryAccount } from '../src/lib/accounts';
import type { OverviewRecentUsage } from '../src/lib/overview';
import type { ProviderUsage } from '../src/lib/usage';

const now = Date.parse('2026-09-18T20:20:00Z');
const fetchedAt = new Date(now - 30_000).toISOString();
const claude = (key: string, email: string, session: number, weekly: number, fable: number, active: 'session' | 'weekly_all' | 'weekly_scoped' | null = 'weekly_scoped'): ProviderUsage => ({
  account: { key, provider: 'claude', label: key, email }, ok: true, status: 200, fetchedAt, sourceUrl: 'fixture',
  data: { five_hour: { utilization: session, resets_at: '2026-09-18T23:40:00Z' }, seven_day: { utilization: weekly, resets_at: '2026-09-24T17:00:00Z' }, limits: [
    { kind: 'session', percent: session, resets_at: '2026-09-18T23:40:00Z', is_active: active === 'session' },
    { kind: 'weekly_all', percent: weekly, resets_at: '2026-09-24T17:00:00Z', is_active: active === 'weekly_all' },
    { kind: 'weekly_scoped', percent: fable, resets_at: '2026-09-21T08:00:00Z', scope: { model: { display_name: 'Fable' } }, is_active: active === 'weekly_scoped' },
  ] },
});
const codex = (key: string, email: string, used: number): ProviderUsage => ({ account: { key, provider: 'codex', label: key, email }, ok: true, status: 200, fetchedAt, sourceUrl: 'fixture',
  data: { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 44122, reset_at: 1789806626 }, secondary_window: null } } as never });
const kimiError: ProviderUsage = { account: { key: 'kimi-work', provider: 'kimi', label: 'Kimi Code', email: 'kimi@example.invalid' }, ok: false, fetchedAt, sourceUrl: 'fixture', error: 'Kimi auth cookie missing' };
const cursor = (used: number): ProviderUsage => ({ account: { key: 'cursor', provider: 'cursor', label: 'Cursor', email: 'cursor@example.invalid' }, ok: true, status: 200, fetchedAt, sourceUrl: 'fixture',
  data: { billingModel: 'usd_credit', currentPeriod: { billingCycleEnd: '2026-10-01T00:00:00Z', planUsage: { limit: 70, used: used * 0.7, remaining: 70 - used * 0.7, totalPercentUsed: used } } } as never });
const registry = (id: string, provider: string, label: string, email?: string, extra: Partial<RegistryAccount> = {}): RegistryAccount => ({ id, provider, label, origin: 'oauth', billingMode: 'unknown', routingEnrolled: null,
  quota: { status: 'unknown', remaining: null, resetAt: null }, coverage: { status: 'partial', reason: '' }, observedAt: fetchedAt,
  proxyCredential: { kind: email ? 'oauth' : 'upstream-key', status: 'active', successToday: 0, failedToday: 0, ...(email ? { email } : {}), observedAt: fetchedAt }, ...extra });
const upstream = (provider: string, name: string, requests: number, failed = 0, rateLimited = 0, lastRequestAt: string | null = '2026-09-18T20:10:00Z') => ({ provider, name, requests, tokens: requests * 10, failed, rateLimited, lastRequestAt, apiEquivalentUsd: null, pricedApiEquivalentUsd: null });
const last24h: OverviewRecentUsage = { windowHours: 24, observedAt: '2026-09-18T20:15:13Z', periodStart: null, periodEnd: null, requests: null, failed: 0, rateLimited: 0, byAccount: [], byUpstream: [
  upstream('claude', 'work@example.invalid', 582, 3), upstream('claude', 'personal@example.invalid', 589, 3), upstream('codex', 'personal@example.invalid', 15), upstream('codex', 'work@example.invalid', 11),
  upstream('xai', 'work@example.invalid', 4, 2, 2), upstream('openai-compatible-openrouter', 'sk-or-v1…2253', 12), upstream('antigravity', 'personal@example.invalid', 0),
] };

describe('limits hero', () => {
  it('orders by least remaining, follows the active Claude window and keeps every window on the card', () => {
    const hero = buildLimitsHero({ usage: [claude('claude-personal', 'personal@example.invalid', 23, 17, 33), claude('claude-work', 'work@example.invalid', 7, 43, 83), codex('codex-work', 'work@example.invalid', 34), codex('codex-personal', 'personal@example.invalid', 83)], registry: [], last24h, now });
    // 17 % left twice: Claude Work first because it carried far more traffic; then 66 % before 67 %.
    expect(hero.cards.map((card) => card.id)).toEqual(['claude-work', 'codex-personal', 'codex-work', 'claude-personal']);
    const work = hero.cards[0];
    if (work.kind !== 'quota') throw new Error('expected a quota card');
    expect(work.limiting).toMatchObject({ label: 'Fable weekly', remainingPercent: 17, tone: 'warn', resetsAt: '2026-09-21T08:00:00Z' });
    expect(work.windows.map((window) => [window.label, window.remainingPercent])).toEqual([['Session', 93], ['Weekly all models', 57], ['Fable weekly', 17]]);
    expect(work.activity).toEqual({ requests: 582, ok: 579, failed: 3, rateLimited: 0, lastRequestAt: '2026-09-18T20:10:00Z' });
    expect(hero.refreshedAt).toBe('2026-09-18T20:15:13Z');
    expect(hero.recencyKnown).toBe(true);
  });
  it('drops accounts without traffic unless they are running low, and always keeps a failing quota source', () => {
    const idle = buildLimitsHero({ usage: [cursor(0.2), claude('claude-idle', 'idle@example.invalid', 0, 80, 5, null), kimiError], registry: [], last24h, now });
    expect(idle.cards.map((card) => [card.kind, card.id])).toEqual([['quota', 'claude-idle'], ['error', 'kimi-work']]);
    const low = idle.cards[0]; if (low.kind !== 'quota') throw new Error('expected quota');
    expect(low.limiting).toMatchObject({ label: 'Weekly all models', remainingPercent: 20, tone: 'warn' });
    expect(low.activity).toBeNull();
    expect(idle.cards[1]).toMatchObject({ kind: 'error', state: 'error', message: 'Kimi auth cookie missing' });
  });
  it('thresholds: bad under 10 % or exhausted, warn under 25 %', () => {
    const hero = buildLimitsHero({ usage: [claude('claude-work', 'work@example.invalid', 7, 43, 91), codex('codex-work', 'work@example.invalid', 100)], registry: [], last24h, now });
    expect(hero.cards.map((card) => [card.id, card.kind === 'quota' ? card.tone : null, card.kind === 'quota' ? card.limiting.exhausted : null])).toEqual([['codex-work', 'bad', true], ['claude-work', 'bad', false]]);
  });
  it('shows providers without a quota API as muted outcome cards, warning only on rate limits', () => {
    const hero = buildLimitsHero({ usage: [claude('claude-work', 'work@example.invalid', 7, 43, 83)], registry: [
      registry('grok', 'xai', 'x.ai · Grok', 'work@example.invalid'), registry('openrouter', 'OpenRouter', 'OpenRouter', undefined, { origin: 'configured', funds: { accountBalance: { usd: 12.5 } } as never }),
      registry('anti', 'antigravity', 'Antigravity', 'personal@example.invalid'), registry('claude-oauth', 'claude', 'Claude OAuth', 'work@example.invalid'),
    ], last24h, now });
    expect(hero.cards.map((card) => [card.kind, card.id])).toEqual([['quota', 'claude-work'], ['outcomes', 'grok'], ['outcomes', 'openrouter']]);
    expect(hero.cards[1]).toMatchObject({ tone: 'warn', activity: { requests: 4, ok: 2, failed: 0, rateLimited: 2 } });
    expect(hero.cards[2]).toMatchObject({ tone: undefined, balanceUsd: 12.5, activity: { requests: 12, ok: 12 } });
  });
  it('matches a single account of a provider by provider alone and keeps all fresh accounts when recency is unknown', () => {
    const kimi: ProviderUsage = { ...kimiError, ok: true, status: 200, data: { usages: [{ scope: 'FEATURE_CODING', detail: { limit: 1000, used: 900, remaining: 100, resetTime: '2026-09-19T00:00:00Z' }, limits: [{ duration: 300, timeUnit: 'TIME_UNIT_MINUTE', detail: { limit: 50, used: 10, remaining: 40, resetTime: null } }] }] } as never };
    const withKey = buildLimitsHero({ usage: [kimi], registry: [], last24h: { ...last24h, byUpstream: [upstream('kimi', 'sk-maest…f35c', 8)] }, now });
    expect(withKey.cards).toHaveLength(1);
    const card = withKey.cards[0]; if (card.kind !== 'quota') throw new Error('expected quota');
    expect(card.limiting).toMatchObject({ label: 'Coding quota', unit: 'requests', remaining: 100, remainingPercent: 10, tone: 'warn' });
    expect(card.windows[1]).toMatchObject({ label: '300-minute window', remaining: 40 });
    expect(card.activity?.requests).toBe(8);
    const unknownRecency = buildLimitsHero({ usage: [claude('claude-work', 'work@example.invalid', 1, 2, 3, null), cursor(0.2)], registry: [], now });
    expect(unknownRecency.recencyKnown).toBe(false);
    expect(unknownRecency.cards.map((card) => card.id)).toEqual(['claude-work', 'cursor']);
    expect(unknownRecency.refreshedAt).toBe(fetchedAt);
  });
  it('enumerates Codex windows with the blocked flag', () => {
    const blocked = codex('codex-work', 'work@example.invalid', 60);
    (blocked.data as { rate_limit: { limit_reached: boolean; secondary_window: unknown } }).rate_limit.limit_reached = true;
    (blocked.data as { rate_limit: { secondary_window: unknown } }).rate_limit.secondary_window = { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 1789806626 };
    const { windows, limiting } = accountWindows(blocked);
    expect(windows.map((window) => [window.label, window.remainingPercent, window.exhausted])).toEqual([['Weekly', 40, true], ['5h', 90, true]]);
    expect(limiting?.label).toBe('Weekly');
  });
});
