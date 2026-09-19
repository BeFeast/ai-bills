import { describe, expect, it } from 'vitest';
import { providerKey, reconcileMonth } from '@/lib/reconciliation';
import type { FinancialRecord } from '@/lib/accounting';

const rec = (over: Partial<FinancialRecord>): FinancialRecord => ({ id: 'x', sourceId: 's', sourceRecordId: 'r', accountId: 'a', provider: 'openai', kind: 'accrual', amount: 100, currency: 'USD', date: '2026-09-05', observedAt: '2026-09-19T00:00:00Z', ...over });
const ledger = { period: 'month', period_start: '2026-09-01', period_end: '2026-09-30', by_upstream: [
  { provider: 'openai', name: 'k1', requests: 10, api_equivalent_usd: 98 },
  { provider: 'openai', name: 'k2', requests: 5, api_equivalent_usd: null },
  { provider: 'openai-compatible-openrouter', name: 'k3', requests: 7, api_equivalent_usd: 3 },
  { provider: 'claude', name: 'e', requests: 40, api_equivalent_usd: 200 },
] };

describe('providerKey', () => {
  it('normalises names so both sides meet', () => {
    expect(providerKey('OpenAI')).toBe('openai');
    expect(providerKey('openai-compatible-openrouter')).toBe('openrouter');
    expect(providerKey(' Anthropic Console ')).toBe('anthropic-console');
    expect(providerKey(null)).toBe('unknown');
  });
});

describe('reconcileMonth', () => {
  it('matches within tolerance, flags partial differences, and names missing sides', () => {
    const rows = reconcileMonth([rec({}), rec({ provider: 'openrouter', kind: 'payment', amount: 20, id: 'y' })], ledger, '2026-09').rows;
    expect(rows.map(r => [r.provider, r.status, r.invoicedUsd, r.usageUsd, r.differenceUsd])).toEqual([
      ['claude', 'no-invoice', null, 200, null],
      ['openai', 'matched', 100, 98, 2],
      ['openrouter', 'partial', 20, 3, 17],
    ]);
    expect(rows[1].unpricedRequests).toBe(5);
    expect(rows[1].note).toContain('5 unpriced');
    expect(rows[2].invoiceBasis).toBe('payment');
  });
  it('prefers accruals over payments as the invoice basis and keeps foreign currency out with a note', () => {
    const rows = reconcileMonth([rec({ kind: 'payment', amount: 500 }), rec({ id: 'b', amount: 95 }), rec({ id: 'c', currency: 'EUR', amount: 5 })], ledger, '2026-09').rows;
    const openai = rows.find(r => r.provider === 'openai')!;
    // 95 vs 98 is within max($1, 5%); the 500 payment is ignored because accruals exist.
    expect(openai).toMatchObject({ invoiceBasis: 'accrual', invoicedUsd: 95, invoiceRecords: 3, status: 'matched' });
    expect(openai.note).toContain('EUR records excluded');
    // With a declared rate the EUR record joins the statement figure instead.
    const withRate = reconcileMonth([rec({ id: 'b', amount: 90 }), rec({ id: 'c', currency: 'EUR', amount: 5 })], ledger, '2026-09', { rates: new Map([['EUR', { currency: 'EUR', rate_to_usd: 1.2, as_of: '2026-09-01' }]]) }).rows.find(r => r.provider === 'openai')!;
    expect(withRate.invoicedUsd).toBeCloseTo(96, 6);
    expect(withRate.note).toContain('EUR converted at declared rates');
    // A hand-built map with a bad rate is treated as undeclared, not applied.
    const bad = reconcileMonth([rec({ id: 'c', currency: 'EUR', amount: 5 })], ledger, '2026-09', { rates: new Map([['EUR', { currency: 'EUR', rate_to_usd: -1, as_of: '2026-09-01' }]]) }).rows.find(r => r.provider === 'openai')!;
    expect(bad).toMatchObject({ invoicedUsd: null, status: 'no-invoice' });
    expect(bad.note).toContain('EUR records excluded');
  });
  it('reports no usage evidence when the ledger rollup is for another month or absent', () => {
    expect(reconcileMonth([rec({ date: '2026-08-05' })], ledger, '2026-08').rows[0]).toMatchObject({ status: 'no-usage-evidence', note: expect.stringContaining('not for this month') });
    expect(reconcileMonth([rec({})], null, '2026-09').rows[0]).toMatchObject({ status: 'no-usage-evidence' });
    expect(reconcileMonth([rec({ date: '2026-08-05' })], ledger, '2026-09').rows.map(r => r.provider)).toEqual(['claude', 'openai', 'openrouter']);
    expect(reconcileMonth([rec({ date: '2026-08-05' })], ledger, '2026-09').rows[1].status).toBe('no-invoice');
  });
  it('ignores records of other kinds and treats an all-unpriced provider as unevidenced', () => {
    const only = { ...ledger, by_upstream: [{ provider: 'xai', requests: 3, api_equivalent_usd: null }] };
    const rows = reconcileMonth([rec({ provider: 'xai', kind: 'api-equivalent' }), rec({ provider: 'xai', id: 'z', amount: 10 })], only, '2026-09').rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'xai', invoicedUsd: 10, usageUsd: null, status: 'no-usage-evidence', note: expect.stringContaining('none are priced') });
    expect(rows[0].note).toContain('1 balance/subscription/estimate record not counted');
    // A provider with only balance/subscription rows is explained, not silently shown as uninvoiced.
    const onlyBalance = reconcileMonth([rec({ kind: 'balance', amount: 40 }), rec({ id: 'q', kind: 'subscription', amount: 20 })], ledger, '2026-09').rows.find(r => r.provider === 'openai')!;
    expect(onlyBalance).toMatchObject({ status: 'no-invoice', invoicedUsd: null, invoiceRecords: 0 });
    expect(onlyBalance.note).toContain('no statement charges');
    expect(onlyBalance.note).toContain('2 balance/subscription/estimate records not counted');
  });
});
