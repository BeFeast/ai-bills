import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProductOverviewPanel } from '../src/components/ProductOverviewPanel';
import { buildProductOverview } from '../src/lib/overview';
import type { AppConfig } from '../src/lib/config';

const config = { server: { timezone: 'UTC' }, subscriptions: [], accounts: [] } as unknown as AppConfig;
/** A month where one model is verified, one is priced only through its previous version and one has no price at all. */
const ledger = (month: Record<string, unknown>) => ({ usage_ledger: { generated: '2026-10-02T15:27:18Z', month: {
  date: '2026-10', period_start: '2026-10-01', requests: 190, tokens_total: 3_000_000, reconciliation: { status: 'observations_only' }, ...month } } });
const mixed = ledger({
  api_equivalent_usd: null, priced_api_equivalent_usd: 727.64, estimated_api_equivalent_usd: 2415.29, unpriced_requests: 2,
  unpriced: { 'claude-opus-5-5': 2_000_000, 'mystery-model': 405 },
  estimated: { 'claude-opus-5-5': { tokens: 2_000_000, usd: 2415.29, from: 'claude-opus-5' }, broken: { tokens: 'x', from: 'y' }, nosource: { tokens: 3 } },
  by_model: [
    { name: 'claude-opus-5-5', tokens: 2_000_000, requests: 5, api_equivalent_usd: null, priced_api_equivalent_usd: 0, estimated_api_equivalent_usd: 2415.29, unpriced_requests: 0, estimated_from: { 'claude-opus-5-5': 'claude-opus-5' } },
    { name: 'claude-opus-4-8', tokens: 999_595, requests: 2, api_equivalent_usd: 727.64, priced_api_equivalent_usd: 727.64, estimated_api_equivalent_usd: null, unpriced_requests: 0 },
    { name: 'mystery-model', tokens: 405, requests: 1, api_equivalent_usd: null, priced_api_equivalent_usd: 0, estimated_api_equivalent_usd: null, unpriced_requests: 1 },
    { name: 'claude-opus-4-1-20250805', tokens: 0, requests: 183, api_equivalent_usd: 0, priced_api_equivalent_usd: 0, estimated_api_equivalent_usd: null, unpriced_requests: 0 },
  ],
  by_client: [
    { name: 't3-claude', tokens: 2_999_595, requests: 7, api_equivalent_usd: null, priced_api_equivalent_usd: 727.64, estimated_api_equivalent_usd: 2415.29, unpriced_requests: 1,
      estimated_from: { 'claude-opus-5-5': 'claude-opus-5', 'gpt-6.1-sol': 'gpt-6-sol' } },
    { name: 'misc-legacy', tokens: 0, requests: 183, api_equivalent_usd: 0, priced_api_equivalent_usd: 0, unpriced_requests: 0 },
    // All of its usage is priced only through an earlier version: nothing verified at all.
    { name: 'claude-code', tokens: 1_500_000, requests: 9, api_equivalent_usd: null, priced_api_equivalent_usd: 0, estimated_api_equivalent_usd: 3068.52, unpriced_requests: 0,
      estimated_from: { 'claude-opus-5-5': 'claude-opus-5' } },
  ],
});
const render = (view: 'usage' | 'details', input: unknown) => renderToStaticMarkup(<ProductOverviewPanel data={buildProductOverview(config, input, '2026-10')} accounts={[]} view={view} onView={() => {}} />);

describe('price estimates in the overview projection', () => {
  it('parses verified, estimated and unpriced figures separately and drops malformed estimates', () => {
    const usage = buildProductOverview(config, mixed, '2026-10').usage;
    expect([usage.apiEquivalentUsd, usage.pricedApiEquivalentUsd, usage.estimatedApiEquivalentUsd]).toEqual([null, 727.64, 2415.29]);
    expect(usage.estimated).toEqual({ 'claude-opus-5-5': { tokens: 2_000_000, usd: 2415.29, from: 'claude-opus-5' } });
    expect(usage.unpriced).toEqual({ 'claude-opus-5-5': 2_000_000, 'mystery-model': 405 });
    const model = usage.byModel.find(row => row.name === 'claude-opus-5-5')!;
    expect(model).toMatchObject({ apiEquivalentUsd: null, pricedApiEquivalentUsd: 0, estimatedApiEquivalentUsd: 2415.29, unpricedRequests: 0, estimatedFrom: { 'claude-opus-5-5': 'claude-opus-5' } });
  });
  it('keeps the group shape of older snapshots: no estimate fields appear when the collector sent none', () => {
    const usage = buildProductOverview(config, ledger({ api_equivalent_usd: 1, by_client: [{ name: 'old', tokens: 5, requests: 1, api_equivalent_usd: 1, priced_api_equivalent_usd: 1 }] }), '2026-10').usage;
    expect(usage.byClient[0]).toEqual({ name: 'old', tokens: 5, requests: 1, apiEquivalentUsd: 1, pricedApiEquivalentUsd: 1 });
    expect(usage.estimatedApiEquivalentUsd).toBeNull();
    expect(usage.estimated).toEqual({});
  });
});

describe('price estimates on the usage screen', () => {
  const html = render('usage', mixed);
  it('shows the verified subtotal and the estimate side by side, never summed', () => {
    // The period and t3-claude still have requests with no price at all: the verified part is a lower bound.
    expect(html).toContain('<span class="spend__total tabular">≥ $727.64 verified</span>');
    expect(html).toContain('<strong class="spend-row__amount">≥ $727.64 verified</strong>');
    expect(html).toContain('~$2,415.29 estimated');
    expect(html).not.toContain('$3,142.93');
    expect(html).not.toMatch(/>\$727\.64</);
  });
  it('never shows a bare $0.00 for a client whose usage only has an estimate', () => {
    expect(html).toContain('9 requests</span><strong class="spend-row__amount">No verified price</strong>');
    expect(html).toContain('~$3,068.52 estimated</span> not in the verified amount');
    expect(html).not.toContain('spend-row__amount">≥ $0.00');
    expect(html).not.toContain('$0.00 verified');
    // Only the zero-token client is a real $0.00: it has no billable tokens at any price.
    expect(html.match(/spend-row__amount">\$0\.00</g)).toHaveLength(1);
    expect(html).toContain('183 requests</span><strong class="spend-row__amount">$0.00</strong>');
  });
  it('names the source model of every estimate on hover', () => {
    expect(html).toContain('title="estimated from claude-opus-5 price"');
    expect(html).toContain('title="claude-opus-5-5: estimated from claude-opus-5 price\ngpt-6.1-sol: estimated from gpt-6-sol price"');
    expect(html).toContain('5 requests · no verified price · <span class="bf-pill bf-pill--warn" title="estimated from claude-opus-5 price">~$2,415.29 estimated</span>');
    expect(html).toContain('7 requests · ≥ $727.64 verified · <span class="bf-pill bf-pill--warn"');
    expect(html).toContain(' · 1 requests unpriced');
  });
  it('reads "no billable tokens" for zero-token groups instead of a price bound', () => {
    expect(html).toContain('183 requests · no billable tokens');
    expect(html).not.toContain('≥ $0.00');
    expect(html).toContain('1 requests · API price unknown');
  });
  it('splits models without a verified price into estimated and unpriced', () => {
    expect(html).toContain('2 models have no verified API price');
    expect(html).toContain('Estimated from a previous version · 1');
    expect(html).toContain('claude-opus-5-5: 2.0M tokens · ~$2,415.29 · estimated from claude-opus-5 price');
    expect(html).toContain('No API price · 1');
    expect(html).toContain('mystery-model: 405 tokens');
    expect(html).toContain('estimated_api_equivalent_usd and estimated_from columns');
  });
  it('keeps the tile value split as well', () => {
    const details = render('details', mixed);
    // mystery-model has no price at all, so the verified part stays a lower bound.
    expect(details).toContain('≥ $727.64 + ~$2,415.29');
    expect(details).toContain('Verified prices + ~estimated from earlier versions; 1 models unpriced');
  });
  it('renders an older snapshot exactly as before', () => {
    const old = render('usage', ledger({ api_equivalent_usd: null, priced_api_equivalent_usd: 5, unpriced: { unknown: 10 },
      by_client: [{ name: 'c', tokens: 10, requests: 1, api_equivalent_usd: null, priced_api_equivalent_usd: 5 }] }));
    expect(old).toContain('≥ $5.00 at known API prices');
    expect(old).toContain('1 models have no verified API price');
    expect(old).toContain('Tokens are included in usage. Their cost is excluded from the known API subtotal.</p>');
    expect(old).not.toContain('bf-pill--warn');
    expect(old).not.toContain(' verified ·');
  });
  it('says "API price unknown" instead of "≥ $0.00" for an older snapshot client with nothing priced', () => {
    const old = render('usage', ledger({ api_equivalent_usd: null, priced_api_equivalent_usd: 5, unpriced: { unknown: 10 },
      by_client: [{ name: 'c', tokens: 10, requests: 1, api_equivalent_usd: null, priced_api_equivalent_usd: 5 },
        { name: 'z', tokens: 4, requests: 1, api_equivalent_usd: null, priced_api_equivalent_usd: 0 }] }));
    expect(old).toContain('<strong class="spend-row__amount">≥ $5.00</strong>');
    expect(old).toContain('<strong class="spend-row__amount">API price unknown</strong>');
    expect(old).not.toContain('≥ $0.00');
  });
});
