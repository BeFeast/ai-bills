import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`; });
import { buildGuardsReport } from '../src/lib/guards';
import { claudeReading, compareReadings, consistencyChecks, recordCheck, resetConsistencyChecksForTests, type QuotaReading } from '../src/lib/quota-consistency';
import type { ProviderUsage } from '../src/lib/usage';

const now = Date.parse('2026-10-01T09:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const reading = (week: number, fable = 50, state: QuotaReading['state'] = 'available'): QuotaReading => ({ state, used: { Session: 10, 'Weekly all models': week, 'Fable weekly': fable } });
const claude = (key: string, overrides: Partial<ProviderUsage> = {}): ProviderUsage => ({ account: { key, provider: 'claude', label: key, email: `${key}@example.test` }, ok: true, status: 200,
  data: { five_hour: { utilization: 10 }, seven_day: { utilization: 40 } }, fetchedAt: at(1), sourceUrl: 'fixture', ...overrides });

afterEach(() => resetConsistencyChecksForTests());

describe('consistency checker', () => {
  it('treats a used-up per-model week as normal and an account-wide one as exhausted', () => {
    expect(claudeReading({ seven_day: { utilization: 74 }, limits: [{ kind: 'weekly_scoped', percent: 100, scope: { model: { display_name: 'Fable' } } }] }).state).toBe('available');
    expect(claudeReading({ seven_day: { utilization: 100 } }).state).toBe('exhausted');
    expect(claudeReading({}).state).toBe('unknown');
  });

  it('flags more than 10 pp only on the second consecutive run', () => {
    const first = recordCheck(null, 'claude-work', 'claude', compareReadings(reading(40), reading(55)), now);
    expect(first).toMatchObject({ verdict: 'mismatch', streak: 1, flagged: false, maxDeltaPp: 15, reason: 'Weekly all models differs by 15 pp' });
    const second = recordCheck(null, 'claude-work', 'claude', compareReadings(reading(42), reading(56)), now + 30 * 60_000);
    expect(second).toMatchObject({ streak: 2, flagged: true });
  });

  it('does not flag 10 pp or a single mismatch followed by agreement', () => {
    expect(compareReadings(reading(40), reading(50)).verdict).toBe('consistent');
    recordCheck(null, 'claude-work', 'claude', compareReadings(reading(40), reading(60)), now);
    expect(recordCheck(null, 'claude-work', 'claude', compareReadings(reading(40), reading(41)), now + 30 * 60_000)).toMatchObject({ streak: 0, flagged: false });
  });

  it('catches a state mismatch and keeps tenants apart', () => {
    const result = compareReadings({ state: 'sign_in', used: {} }, reading(74, 100));
    expect(result).toMatchObject({ verdict: 'mismatch', reason: 'proxy says sign_in, website says available' });
    recordCheck('tenant-a', 'claude-work', 'claude', result, now);
    recordCheck('tenant-a', 'claude-work', 'claude', result, now + 30 * 60_000);
    expect(consistencyChecks('tenant-a')[0].flagged).toBe(true);
    expect(consistencyChecks('tenant-b')).toEqual([]);
  });

  it('does not count a run without both observations as evidence either way', () => {
    expect(compareReadings({ state: 'unknown', used: {} }, reading(40))).toMatchObject({ verdict: 'insufficient' });
    // A mismatch, a proxy back-off, then another mismatch: still two in a row.
    recordCheck(null, 'claude-work', 'claude', compareReadings(reading(40), reading(60)), now);
    expect(recordCheck(null, 'claude-work', 'claude', compareReadings({ state: 'unknown', used: {} }, reading(60)), now + 30 * 60_000)).toMatchObject({ streak: 1, flagged: false });
    expect(recordCheck(null, 'claude-work', 'claude', compareReadings(reading(40), reading(60)), now + 60 * 60_000)).toMatchObject({ streak: 2, flagged: true });
  });
});

describe('quota guards', () => {
  const probe = (minutesAgo: number, status: string, models: unknown[]) => ({ model_probe: { checked_at: at(minutesAgo), status, message: null, models } });

  it('is up when every Claude account was observed within 5 h, from any source', () => {
    const report = buildGuardsReport({ accounts: [claude('claude-work'), claude('claude-personal', { source: 'web', fetchedAt: at(3) }), claude('claude-old', { source: 'retained', fetchedAt: at(4 * 60) })], checks: [], snapshot: probe(10, 'up', []), now });
    expect(report.guards.stale).toMatchObject({ status: 'up' });
  });

  it('goes down after 5 h without a usable observation, and on a failure with nothing to show', () => {
    const report = buildGuardsReport({ accounts: [claude('claude-work', { fetchedAt: at(5 * 60 + 1) }), claude('claude-personal', { ok: false, status: 429, data: undefined })], checks: [], snapshot: {}, now });
    expect(report.guards.stale.status).toBe('down');
    expect(report.stale.map((entry) => entry.accountKey)).toEqual(['claude-work', 'claude-personal']);
    expect(report.guards.stale.message).toContain('claude-work');
  });

  it('relays a flagged cross-check and a checker that stopped running', () => {
    const result = compareReadings({ state: 'sign_in', used: {} }, reading(74));
    recordCheck(null, 'claude-personal', 'claude', result, now - 30 * 60_000);
    recordCheck(null, 'claude-personal', 'claude', result, now);
    expect(buildGuardsReport({ accounts: [], checks: consistencyChecks(null), snapshot: {}, now }).guards.consistency).toMatchObject({ status: 'down', message: expect.stringContaining('claude-personal: proxy says sign_in') });
    resetConsistencyChecksForTests();
    recordCheck(null, 'claude-work', 'claude', compareReadings(reading(40), reading(41)), now - 2 * 3600_000);
    expect(buildGuardsReport({ accounts: [], checks: consistencyChecks(null), snapshot: {}, now }).guards.consistency).toMatchObject({ status: 'down', message: expect.stringContaining('stopped') });
  });

  it('treats a rate-limited Fable as normal and an unknown model as down, with the last run time', () => {
    const fine = buildGuardsReport({ accounts: [], checks: [], now, snapshot: probe(20, 'up', [{ model: 'claude-opus-5-5', outcome: 'ok', http_status: 200 }, { model: 'claude-fable-5-1', outcome: 'rate_limited', http_status: 429 }]) });
    expect(fine.guards.probe).toMatchObject({ status: 'up', lastRunAt: at(20), message: '2 models callable (1 rate-limited)' });
    const broken = buildGuardsReport({ accounts: [], checks: [], now, snapshot: probe(20, 'down', [{ model: 'claude-fable-5-1', outcome: 'unknown_model', http_status: 400, retried: true }]) });
    expect(broken.guards.probe).toMatchObject({ status: 'down', message: 'Models failing: claude-fable-5-1 unknown_model (HTTP 400)' });
    expect(broken.probe.models[0].retried).toBe(true);
  });

  it('stays up when the probe ran out of time but every checked model passed', () => {
    const report = buildGuardsReport({ accounts: [], checks: [], now, snapshot: { model_probe: { checked_at: at(5), status: 'partial', message: '3 of 5 Claude models checked before the time budget ran out', models: [] } } });
    expect(report.guards.probe).toMatchObject({ status: 'up', message: '3 of 5 Claude models checked before the time budget ran out' });
  });

  it('goes down when the probe stopped reporting', () => {
    expect(buildGuardsReport({ accounts: [], checks: [], now, snapshot: probe(2 * 60 + 1, 'up', []) }).guards.probe).toMatchObject({ status: 'down', message: expect.stringContaining('stopped') });
    expect(buildGuardsReport({ accounts: [], checks: [], now, snapshot: {} }).guards.probe.status).toBe('down');
  });
});
