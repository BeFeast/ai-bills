import { describe, expect, it } from 'vitest';
import { buildProductOverview } from '../src/lib/overview';
import type { AppConfig } from '../src/lib/config';
const config = { server: { timezone: 'Asia/Jerusalem' }, subscriptions: [] } as unknown as AppConfig;
describe('product overview', () => {
  it('exposes the configured management URL and partial accounting without inventing totals', () => {
    const result = buildProductOverview({ ...config, server: { ...config.server,
      codex_proxy_management_url: 'https://proxy.example.test/management.html' } }, { usage_ledger: {
      generated: '2026-09-10T10:00:00Z', month: { date: '2026-09', tokens_total: null, requests: null,
        by_account: [{ name: 'example', tokens: 130, requests: 2 }],
        reconciliation: { status: 'partial', confirmed_tokens: 130, confirmed_requests: 2,
          unreconciled_native_observations: 3 } },
    } }, '2026-09');
    expect(result.links?.proxyManagementUrl).toBe('https://proxy.example.test/management.html');
    expect(result.usage.tokens).toBeNull();
    expect(result.usage.byAccount?.[0].name).toBe('example');
    expect(result.usage.reconciliation).toEqual({ status: 'partial', confirmedTokens: 130,
      confirmedRequests: 2, nativeObservations: 3 });
  });
  it('uses only explicitly linked account emails for subscription labels', () => {
    const result = buildProductOverview({ ...config,
      accounts: [{ key: 'linked', provider: 'claude', label: 'Personal', email: 'owner@example.com' }, { key: 'unlinked', provider: 'claude', label: 'Work', email: 'other@example.com' }],
      subscriptions: [
        { id: 'one', provider: 'Anthropic', label: 'Claude Personal', plan: 'Pro', account_keys: ['linked'] },
        { id: 'two', provider: 'Anthropic', label: 'Claude Work', plan: 'Pro', account_keys: ['missing'] },
      ],
    }, {}, '2026-09');
    expect(result.subscriptions.map(value => value.label)).toEqual(['owner@example.com', 'Anthropic · email not recorded']);
    expect(result.subscriptions[0].accountKeys).toEqual(['linked']);
  });
  it('does not report a missing inventory as a confirmed zero subscriptions', () => {
    const result = buildProductOverview(config, {}, '2026-09');
    expect(result.summary.subscriptionCountComplete).toBe(false);
  });
  it('counts explicit commercial plans instead of credential/provider rows and avoids aggregate duplication', () => {
    const result = buildProductOverview({ ...config, subscriptions: ['personal', 'work'].map(id => ({ id, provider: 'Fixture AI', plan: 'Pro', status: 'active', amount: 200, period: 'month', account_keys: [id] })) }, {
      account_registry: Array.from({ length: 29 }, () => ({ provider: 'Fixture AI' })),
      providers: [{ provider: 'Fixture AI', billing: 'subscription', status: 'active', cost_usd_month: '200' }],
    }, '2026-09');
    expect(result.summary.activeSubscriptionCount).toBe(2);
    expect(result.summary.knownMonthlyCosts).toEqual([{ currency: 'USD', amount: 400 }]);
    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscriptions.every(value => value.renewsAt === null)).toBe(true);
  });
  it('retains unknown grouped subscription count and separates annual currencies', () => {
    const result = buildProductOverview({ ...config, subscriptions: [{ id: 'annual', provider: 'Annual', plan: 'Team', status: 'active', amount: 120, currency: 'EUR', period: 'year' }] }, {
      providers: [{ provider: 'Tool A + Tool B', plan: 'Two tools', billing: 'subscription', status: 'active', cost_usd_month: '~45' }, { provider: 'GPU', billing: 'payg', status: 'active', cost_usd_month: '400' }],
    }, '2026-09');
    expect(result.summary.activeSubscriptionCount).toBe(1);
    expect(result.summary.subscriptionCountComplete).toBe(false);
    expect(result.summary.knownMonthlyCosts).toContainEqual({ currency: 'EUR', amount: 10 });
    expect(result.subscriptions.find(value => value.provider === 'Tool A + Tool B')?.quantity).toBeNull();
  });
  it('never substitutes today for missing current month data', () => {
    const result = buildProductOverview(config, { usage_ledger: { today: { api_equivalent_usd: 50 }, month: { date: '2026-08', api_equivalent_usd: 900 } } }, '2026-09');
    expect(result.usage.apiEquivalentUsd).toBeNull();
    expect(result.usage.byClient).toEqual([]);
    expect(result.usage.observedAt).toBeNull();
  });
  it('exposes known month subtotal alongside unknown full equivalent and token rankings', () => {
    const result = buildProductOverview(config, { usage_ledger: { generated: '2026-09-07T10:00:00Z', month: { date: '2026-09', api_equivalent_usd: null, priced_api_equivalent_usd: 23.5, requests: 10, tokens_total: 1000, unpriced: { unknown: 500 }, by_client: [{ name: 'small', tokens: 50, requests: 1, api_equivalent_usd: 1 }, { name: 'big', tokens: 950, requests: 9, api_equivalent_usd: null }] } } }, '2026-09');
    expect(result.usage.apiEquivalentUsd).toBeNull();
    expect(result.usage.pricedApiEquivalentUsd).toBe(23.5);
    expect(result.usage.byClient[0].name).toBe('big');
    expect(result.usage.unpriced).toEqual({ unknown: 500 });
  });
  it('exposes the rolling 24h window only when the collector labels it as such, and masks keys', () => {
    const rolling = { period: 'rolling_24h', window_hours: 24, period_start: '2026-09-17T20:00:00+00:00', period_end: '2026-09-18T20:00:00+00:00', requests: null, failed: 3, rate_limited: 2,
      by_upstream: [
        { name: 'owner@example.com', provider: 'claude', tokens: 900, requests: 40, failed: 2, rate_limited: 2, last_request_at: '2026-09-18T19:59:00+00:00' },
        { name: 'sk-or-v1-0123456789abcdef0123456789abcdef', provider: 'openai-compatible-openrouter', tokens: 10, requests: 1, failed: 0, rate_limited: 0, last_request_at: null },
        { name: '', provider: 'codex', tokens: 1, requests: 1 },
      ],
      by_account: [{ name: 'owner@example.com', tokens: 900, requests: 40, failed: 2, rate_limited: 2, last_request_at: '2026-09-18T19:59:00+00:00' }] };
    const result = buildProductOverview(config, { usage_ledger: { generated: '2026-09-18T20:00:05Z', last_24h: rolling } }, '2026-09');
    expect(result.usage.last24h).toMatchObject({ windowHours: 24, observedAt: '2026-09-18T20:00:05Z', requests: null, failed: 3, rateLimited: 2 });
    expect(result.usage.last24h?.byUpstream.map((row) => [row.provider, row.name, row.requests, row.rateLimited, row.lastRequestAt])).toEqual([
      ['claude', 'owner@example.com', 40, 2, '2026-09-18T19:59:00+00:00'], ['openai-compatible-openrouter', 'sk-or-v1…cdef', 1, 0, undefined],
    ]);
    expect(result.usage.last24h?.byAccount[0].lastRequestAt).toBe('2026-09-18T19:59:00+00:00');
    expect(result.usage.tokens).toBeNull();
    // A calendar day is not a rolling window.
    expect(buildProductOverview(config, { usage_ledger: { last_24h: { ...rolling, period: 'day' } } }, '2026-09').usage.last24h).toBeUndefined();
    expect(buildProductOverview(config, { usage_ledger: { today: rolling } }, '2026-09').usage.last24h).toBeUndefined();
    const month = buildProductOverview(config, { usage_ledger: { month: { date: '2026-09', by_account: [{ name: 'sk-maestro-abcdefghijklmnopqrstuvwxyz0123456789', tokens: 5, requests: 1 }] } } }, '2026-09');
    expect(month.usage.byAccount?.[0].name).toBe('sk-maest…6789');
  });
  it('never treats quota reset timestamps as subscription renewal dates', () => {
    const result = buildProductOverview(config, { providers: [{ provider: 'OpenAI', plan: 'Pro', status: 'active', billing: 'subscription', cost_usd_month: '200' }], codex_usage: { account: { data: { rate_limit: { reset_at: 1789379829 } } } } }, '2026-09');
    expect(result.subscriptions[0].renewsAt).toBeNull();
    expect(result.subscriptions[0].manageUrl).toContain('chatgpt.com');
  });
  it('reports whether the retired routing service is configured without inventing totals', () => {
    expect(buildProductOverview(config, {}, '2026-09', {}, { routing: true }).features.routing).toBe(true);
    expect(buildProductOverview(config, {}, '2026-09', {}, { routing: false }).features.routing).toBe(false);
    expect(buildProductOverview(config, {}, '2026-09').usage.tokens).toBeNull();
  });
});
