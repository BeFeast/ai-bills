import { describe, expect, it } from 'vitest';
import { buildProductOverview } from '../src/lib/overview';
import type { AppConfig } from '../src/lib/config';
const config = { server: { timezone: 'Asia/Jerusalem' }, subscriptions: [] } as unknown as AppConfig;
describe('product overview', () => {
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
  it('never treats quota reset timestamps as subscription renewal dates', () => {
    const result = buildProductOverview(config, { providers: [{ provider: 'OpenAI', plan: 'Pro', status: 'active', billing: 'subscription', cost_usd_month: '200' }], codex_usage: { account: { data: { rate_limit: { reset_at: 1789379829 } } } } }, '2026-09');
    expect(result.subscriptions[0].renewsAt).toBeNull();
    expect(result.subscriptions[0].manageUrl).toContain('chatgpt.com');
  });
});
