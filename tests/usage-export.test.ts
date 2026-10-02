import { describe, expect, it } from 'vitest';
import { csvCell, usageCsv } from '@/lib/usage-export';

const month = { period: 'month', date: '2026-09', period_start: '2026-09-01', period_end: '2026-09-19',
  reconciliation: { status: 'partial', unreconciled_native_observations: 12, unreconciled_native_token_observations: 3400 },
  by_project: [
    { name: 'app', requests: 10, failed: 1, rate_limited: 0, tokens: 5000, api_equivalent_usd: 1.5, priced_api_equivalent_usd: 1.5 },
    { name: 'unassigned', requests: 3, failed: 0, rate_limited: 1, tokens: 800, api_equivalent_usd: null, priced_api_equivalent_usd: 0.2 },
    { name: '=cmd()', requests: 1, failed: 0, rate_limited: 0, tokens: 1, api_equivalent_usd: null, priced_api_equivalent_usd: 0 },
  ],
  by_upstream: [{ name: 'a@example.com', provider: 'claude', requests: 4, tokens: 9, api_equivalent_usd: 0.1, priced_api_equivalent_usd: 0.1 }] };

describe('csvCell', () => {
  it('quotes and escapes, and neutralises formula-looking cells but not negative numbers', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(null)).toBe('');
  });
});

describe('usageCsv', () => {
  it('writes one row per group with pricing state and the period on each, plus the unreconciled tail', () => {
    const { filename, csv, rows } = usageCsv(month, 'project');
    expect(filename).toBe('zecori-usage-month-2026-09-by-project.csv');
    expect(rows).toBe(3);
    const lines = csv.split('\r\n').filter(Boolean);
    // Estimate columns are appended, so every earlier column keeps its position.
    expect(lines[0]).toBe('project,requests,failed,rate_limited,tokens,api_equivalent_usd,priced_api_equivalent_usd,pricing,period,period_start,period_end,evidence,estimated_api_equivalent_usd,estimated_from');
    expect(lines[1]).toBe('app,10,1,0,5000,1.500000,1.500000,complete,month,2026-09-01,2026-09-19,partial: unreconciled native observations excluded,,');
    expect(lines[2]).toContain('unassigned,3,0,1,800,,0.200000,partial (unpriced models excluded)');
    expect(lines[3].startsWith("'=cmd(),")).toBe(true);
    expect(lines[4]).toContain('(unreconciled native observations),12,,,3400,,,not priced');
    expect(lines[4].split(',')).toHaveLength(14);
  });
  it('puts estimates from an earlier version in their own columns, never in the verified USD columns', () => {
    const period = { ...month, reconciliation: {}, by_model: [
      { name: 'claude-opus-5-5', requests: 4, tokens: 2000, api_equivalent_usd: null, priced_api_equivalent_usd: 0, estimated_api_equivalent_usd: 30, unpriced_requests: 0, estimated_from: { 'claude-opus-5-5': 'claude-opus-5' } },
      { name: 'verified', requests: 1, tokens: 10, api_equivalent_usd: 1, priced_api_equivalent_usd: 1, estimated_api_equivalent_usd: null, unpriced_requests: 0 },
      { name: 'mystery', requests: 1, tokens: 10, api_equivalent_usd: null, priced_api_equivalent_usd: 0, estimated_api_equivalent_usd: null, unpriced_requests: 1 },
    ], by_client: [
      { name: 'mixed', requests: 6, tokens: 3000, api_equivalent_usd: null, priced_api_equivalent_usd: 1, estimated_api_equivalent_usd: 30.5, unpriced_requests: 1,
        estimated_from: { 'claude-opus-5-5': 'claude-opus-5', 'gpt-6.1-sol': 'gpt-6-sol', ignored: 7 } },
    ] };
    const models = usageCsv(period, 'model').csv.split('\r\n').filter(Boolean);
    expect(models[1]).toBe('claude-opus-5-5,4,0,0,2000,,0.000000,includes estimates,month,2026-09-01,2026-09-19,confirmed observations,30.000000,claude-opus-5-5 from claude-opus-5');
    expect(models[2]).toBe('verified,1,0,0,10,1.000000,1.000000,complete,month,2026-09-01,2026-09-19,confirmed observations,,');
    expect(models[3]).toBe('mystery,1,0,0,10,,0.000000,unpriced,month,2026-09-01,2026-09-19,confirmed observations,,');
    const clients = usageCsv(period, 'client').csv.split('\r\n').filter(Boolean);
    expect(clients[1]).toBe('mixed,6,0,0,3000,,1.000000,partial (includes estimates; unpriced models excluded),month,2026-09-01,2026-09-19,confirmed observations,30.500000,claude-opus-5-5 from claude-opus-5; gpt-6.1-sol from gpt-6-sol');
  });
  it('adds the provider column for upstreams and names a rolling window by its end', () => {
    const rolling = { ...month, period: 'rolling_24h', period_start: '2026-09-18T10:00:00+00:00', period_end: '2026-09-19T10:00:00+00:00', reconciliation: {} };
    const { filename, csv } = usageCsv(rolling, 'upstream');
    expect(filename).toBe('zecori-usage-rolling-24h-2026-09-1910-by-upstream.csv');
    expect(csv.split('\r\n')[0].startsWith('upstream,provider,')).toBe(true);
    expect(csv.split('\r\n')[1]).toContain('a@example.com,claude,4,');
    expect(csv).not.toContain('unreconciled native');
  });
  it('yields only a header for a missing dimension or malformed period', () => {
    expect(usageCsv({}, 'client').rows).toBe(0);
    expect(usageCsv(null, 'model').csv.split('\r\n').filter(Boolean)).toHaveLength(1);
  });
});
