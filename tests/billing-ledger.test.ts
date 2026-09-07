import { describe, expect, test } from 'vitest';
import { normalizeMaestroSnapshot } from '../src/lib/billing';

const rollup = {
  today: {
    date: '2026-07-25',
    requests: 1490,
    failed: 3,
    counts: { in_uncached: 4449, cache_read: 330547876, cache_write: 12044841, out_total: 985372 },
    tokens_total: 343582538,
    api_equivalent_usd: 265.210814,
    marginal_usd: 0,
    by_client: [{ name: 'example-host:claude-desktop', api_equivalent_usd: 265.18, marginal_usd: 0, tokens: 343578734, requests: 1457 }],
    by_model: [{ name: 'claude-opus-5', api_equivalent_usd: 265.18, marginal_usd: 0, tokens: 343578734, requests: 1465 }],
    by_via: [{ name: 'direct', api_equivalent_usd: 265.18, marginal_usd: 0, tokens: 343578734, requests: 1472 }],
    unpriced: { 'gpt-5.5': 12345 },
  },
  trend: [
    { date: '2026-07-24', api_equivalent_usd: 833.6, marginal_usd: 1.2, tokens: 900000000 },
    { date: '2026-07-25', api_equivalent_usd: 265.21, marginal_usd: 0, tokens: 343582538 },
  ],
};

describe('usage ledger parsing', () => {
  test('maps the rollup payload onto the billing snapshot', () => {
    const snap = normalizeMaestroSnapshot({ generated: '2026-07-25T14:38:33Z', usage_ledger: rollup });
    const l = snap.ledger!;
    expect(l.date).toBe('2026-07-25');
    expect(l.tokensTotal).toBe(343582538);
    expect(l.apiEquivalentUsd).toBeCloseTo(265.21, 2);
    expect(l.marginalUsd).toBe(0);
    expect(l.tokens.cacheRead).toBe(330547876);
    expect(l.byClient[0].name).toBe('example-host:claude-desktop');
    expect(l.byVia[0].requests).toBe(1472);
    expect(l.trend).toHaveLength(2);
    expect(l.trend[0].apiEquivalentUsd).toBeCloseTo(833.6, 1);
  });

  test('unpriced models are surfaced, never folded into $0', () => {
    const snap = normalizeMaestroSnapshot({ usage_ledger: rollup });
    expect(snap.ledger!.unpriced).toEqual({ 'gpt-5.5': 12345 });
  });

  test('a snapshot with no ledger yields null rather than zeroes', () => {
    const snap = normalizeMaestroSnapshot({ generated: '2026-07-25T14:38:33Z' });
    expect(snap.ledger).toBeNull();
  });

  test('a malformed ledger is rejected instead of half-parsed', () => {
    expect(normalizeMaestroSnapshot({ usage_ledger: { trend: [] } }).ledger).toBeNull();
    expect(normalizeMaestroSnapshot({ usage_ledger: 'nope' }).ledger).toBeNull();
  });
});


describe('payment currency evidence', () => {
  test('does not treat foreign-currency payments as USD without an explicit conversion', () => {
    const snap = normalizeMaestroSnapshot({ generated: '2026-07-25T14:38:33Z', payments: [
      { date: '2026-07-10', provider: 'Example', currency: 'EUR', amount: 9 },
      { date: '2026-07-11', provider: 'Example', currency: 'USD', amount: 3 },
      { date: '2026-07-12', provider: 'Example', currency: 'EUR', amount: 5, amountUsd: 6 },
    ] });
    expect(snap.payments.map(row => row.amountUsd)).toEqual([null, 3, 6]);
    expect(snap.summary.paymentsThisMonthUsd).toBe(9);
  });
});
