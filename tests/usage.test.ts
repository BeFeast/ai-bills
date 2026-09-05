import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  codexPrimaryWindow,
  codexWindowDurationLabel,
  codexWindowResetIso,
  combinedOverview,
  cursorCreditPercent,
  cursorCycleEnd,
  cursorIncludedSpendDollars,
  cursorLegacyPercent,
  cursorOnDemandSpendDollars,
  cursorTierLabel,
  cursorTotalSpendDollars,
  cursorUsagePercent,
  claudeLimitByKind,
  isLimitExhausted,
  limitPercent,
  deriveCursorAvailability,
  deriveCodexAvailability,
  deriveKimiAvailability,
  deriveModelAvailability,
  detectCursorBillingModel,
  detectCursorTier,
  kimiUsagePercent,
  kimiWindow,
  parseCursorUsagePayload,
  parseKimiUsagePayload,
  scopedModelLimits,
  severityClass,
  windowUtilization,
  type CodexUsagePayload,
  type CursorUsagePayload,
  type ProviderUsage,
} from '../src/lib/usage';
import { loadConfig, resetConfigCache, type AccountConfig } from '../src/lib/config';

const CONFIG_PATH = fileURLToPath(new URL('./fixtures/accounts.toml', import.meta.url));
process.env.AI_BILLS_CONFIG = CONFIG_PATH;
resetConfigCache();

const account = (key: string): AccountConfig => loadConfig().accounts.find((item) => item.key === key)!;

describe('usage helpers', () => {
  test('takes utilization as whole percents, without fraction rescaling', () => {
    expect(windowUtilization({ utilization: 42 })).toBe(42);
    // Regression: 1 % used to be rescaled to 100 % by the fraction heuristic.
    expect(windowUtilization({ utilization: 1 })).toBe(1);
    expect(windowUtilization({ utilization: 0.42 })).toBe(0.42);
    expect(windowUtilization({ utilization: 0 })).toBe(0);
  });

  test('regression: a 1% weekly_all limit is neither exhausted nor blocking', () => {
    // Real claude-work payload shape, 2026-07-27: whole percents, 1 % weekly.
    const data = { limits: [
      { kind: 'session', group: 'session', percent: 4, severity: 'normal', is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 1, severity: 'normal', is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 2, severity: 'normal', scope: { model: { display_name: 'Fable' } }, is_active: false },
    ] };
    expect(limitPercent(claudeLimitByKind(data, 'weekly_all'))).toBe(1);
    expect(isLimitExhausted(claudeLimitByKind(data, 'weekly_all'))).toBe(false);
    const availability = deriveModelAvailability(data);
    expect(availability.state).toBe('all');
    expect(availability.label).toBe('All models available');
  });

  test('returns all scoped model limits, including inactive ones', () => {
    const scoped = scopedModelLimits({ limits: [
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 12, is_active: true },
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Old' } }, percent: 99, is_active: false },
      { kind: 'weekly_all', percent: 20, is_active: true },
    ] });
    expect(scoped).toHaveLength(2);
  });

  test('regression: inactive Fable at 97% is returned and included in scoped average', () => {
    const results: ProviderUsage[] = [
      { account: account('claude-personal'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: { limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 97, is_active: false }] } },
    ];
    expect(scopedModelLimits(results[0].data as any)).toHaveLength(1);
    expect(combinedOverview(results).averageScopedModelUtilization).toBe(97);
  });

  test('combines live provider payloads while keeping Claude averages separate', () => {
    const results: ProviderUsage[] = [
      { account: account('claude-personal'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: { five_hour: { utilization: 50 }, seven_day: { utilization: 25 }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 70, is_active: true }] } },
      { account: account('claude-work'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: { five_hour: { utilization: 70 }, seven_day: { utilization: 75 }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 90, is_active: true }] } },
      { account: account('kimi-work'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: parseKimiUsagePayload({ usages: [{ scope: 'FEATURE_CODING', detail: { limit: '100', used: '4', remaining: '96', resetTime: '2026-07-24T11:43:41.062583Z' }, limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '18', remaining: '82', resetTime: '2026-07-17T16:43:41.062583Z' } }] }], totalQuota: { limit: '100', remaining: '100' } }) },
    ];
    const combined = combinedOverview(results);
    expect(combined.averageSessionUtilization).toBe(60);
    expect(combined.averageWeeklyAllUtilization).toBe(50);
    expect(combined.averageScopedModelUtilization).toBe(80);
    expect(combined.availableProviders).toBe(3);
    expect(combined.unavailableProviders).toBe(0);
  });

  test('severity class honors API severity and numeric thresholds', () => {
    expect(severityClass(95)).toBe('danger');
    expect(severityClass(75)).toBe('warn');
    expect(severityClass(20)).toBe('ok');
    expect(severityClass(20, 'warning')).toBe('warn');
  });

  test('model availability: session 100 means no models available', () => {
    const availability = deriveModelAvailability({ limits: [{ kind: 'session', percent: 100, is_active: true }] });
    expect(availability.state).toBe('none');
  });

  test('model availability: weekly_all 100 means no models available', () => {
    const availability = deriveModelAvailability({ limits: [{ kind: 'weekly_all', percent: 100, is_active: true }] });
    expect(availability.state).toBe('none');
  });

  test('model availability: Fable 100 only means Fable unavailable, others available', () => {
    const availability = deriveModelAvailability({ limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 100, is_active: false }] });
    expect(availability.state).toBe('partial');
  });

  test('model availability: Fable 97 remains all models available with warning context elsewhere', () => {
    const availability = deriveModelAvailability({ limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 97, severity: 'warning', is_active: false }] });
    expect(availability.state).toBe('all');
  });

  test('kimi parser and availability handle numeric strings and 300-minute window', () => {
    const payload = parseKimiUsagePayload({
      usages: [{
        scope: 'FEATURE_CODING',
        detail: { limit: '100', used: '4', remaining: '96', resetTime: '2026-07-24T11:43:41.062583Z' },
        limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '18', remaining: '82', resetTime: '2026-07-17T16:43:41.062583Z' } }],
      }],
      totalQuota: { limit: '100', remaining: '100' },
    });
    expect(payload.usages[0].detail.used).toBe(4);
    expect(kimiUsagePercent(payload.usages[0].detail)).toBe(4);
    expect(kimiWindow(payload, 300, 'TIME_UNIT_MINUTE')?.detail.used).toBe(18);
    expect(deriveKimiAvailability(payload).label).toBe('Coding available');
  });

  test('codex availability: rate limit OK → available with plan label', () => {
    const data = codexFixture({ plan_type: 'plus', used_percent: 42 });
    const avail = deriveCodexAvailability(data);
    expect(avail.available).toBe(true);
    expect(avail.tone).toBe('ok');
    expect(avail.label).toContain('Plus');
  });

  test('codex availability: rate limit reached → unavailable', () => {
    const data = codexFixture({ plan_type: 'pro', used_percent: 100, limit_reached: true });
    const avail = deriveCodexAvailability(data);
    expect(avail.available).toBe(false);
    expect(avail.tone).toBe('danger');
    expect(avail.label).toBe('Rate limit reached');
  });

  test('codex availability: near limit at 92% → warn', () => {
    const data = codexFixture({ plan_type: 'pro', used_percent: 92 });
    const avail = deriveCodexAvailability(data);
    expect(avail.available).toBe(true);
    expect(avail.tone).toBe('warn');
  });

  test('codex availability: null data → auth required', () => {
    expect(deriveCodexAvailability(null).tone).toBe('danger');
    expect(deriveCodexAvailability(undefined).tone).toBe('danger');
  });

  test('codex availability: upstream 5xx is not reported as an auth problem', () => {
    const avail = deriveCodexAvailability(null, 503);
    expect(avail.tone).toBe('warn');
    expect(avail.label).toBe('Codex API unavailable');
    expect(avail.detail).toContain('503');
  });

  test('codex availability: 401 still asks for re-auth', () => {
    expect(deriveCodexAvailability(null, 401).label).toBe('Codex auth required');
  });

  test('codexPrimaryWindow extracts primary window', () => {
    const data = codexFixture({ used_percent: 75 });
    const win = codexPrimaryWindow(data);
    expect(win?.used_percent).toBe(75);
  });

  test('codexWindowDurationLabel: 7 days', () => {
    const data = codexFixture({ used_percent: 50, limit_window_seconds: 604800 });
    expect(codexWindowDurationLabel(codexPrimaryWindow(data))).toBe('Weekly usage');
  });

  test('codexWindowResetIso: converts unix timestamp to ISO', () => {
    const data = codexFixture({ used_percent: 50, reset_at: 1784838842 });
    const iso = codexWindowResetIso(codexPrimaryWindow(data));
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('kimi availability reports no coding when remaining is zero', () => {
    const payload = parseKimiUsagePayload({
      usages: [{ scope: 'FEATURE_CODING', detail: { limit: '100', used: '100', remaining: '0', resetTime: '2026-07-24T11:43:41.062583Z' }, limits: [] }],
      totalQuota: { limit: '100', remaining: '0' },
    });
    expect(deriveKimiAvailability(payload).label).toBe('No coding models available');
  });

  test('combinedOverview includes averageCodexUtilization', () => {
    const codexPersonal = codexFixture({ plan_type: 'plus', used_percent: 60 });
    const codexWork = codexFixture({ plan_type: 'pro', used_percent: 80 });
    const results: ProviderUsage[] = [
      { account: account('codex-personal'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: codexPersonal },
      { account: account('codex-work'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: codexWork },
    ];
    const combined = combinedOverview(results);
    expect(combined.averageCodexUtilization).toBe(70);
  });
});

describe('cursor provider', () => {
  test('parseCursorUsagePayload handles complete stripe + legacy usage', () => {
    const payload = parseCursorUsagePayload({
      stripe: {
        membershipType: 'pro',
        subscriptionStatus: 'active',
        isTeamMember: false,
        isYearlyPlan: false,
        customerBalance: 0,
        pendingCancellationDate: null,
        lastPaymentFailed: false,
      },
      usage: {
        'gpt-4': { numRequests: 150, maxRequestUsage: 500 },
        startOfMonth: '2026-07-01T00:00:00.000Z',
      },
    });
    expect(payload.stripe?.membershipType).toBe('pro');
    expect(payload.stripe?.subscriptionStatus).toBe('active');
    expect(payload.legacyUsage?.['gpt-4']?.numRequests).toBe(150);
    expect(payload.legacyUsage?.['gpt-4']?.maxRequestUsage).toBe(500);
    expect(payload.billingModel).toBe('request_count');
  });

  test('parseCursorUsagePayload handles USD credit model with currentPeriod', () => {
    const payload = parseCursorUsagePayload({
      stripe: {
        membershipType: 'pro',
        subscriptionStatus: 'active',
      },
      usage: {
        'gpt-4': { numRequests: 0, maxRequestUsage: null },
        startOfMonth: '2026-07-01T00:00:00.000Z',
      },
      currentPeriod: {
        billingCycleStart: '1719792000000',
        billingCycleEnd: '1722470400000',
        planUsage: {
          limit: 2000,
          remaining: 1500,
          used: 500,
          totalPercentUsed: 25.0,
          autoPercentUsed: 10.0,
          apiPercentUsed: 15.0,
        },
      },
    });
    expect(payload.billingModel).toBe('usd_credit');
    expect(payload.currentPeriod?.planUsage?.limit).toBe(2000);
    expect(payload.currentPeriod?.planUsage?.totalPercentUsed).toBe(25);
  });

  test('parseCursorUsagePayload handles null/missing data gracefully', () => {
    const payload = parseCursorUsagePayload({ stripe: null, usage: null });
    expect(payload.stripe).toBeNull();
    expect(payload.legacyUsage).toBeNull();
    expect(payload.currentPeriod).toBeNull();
    expect(payload.billingModel).toBe('unknown');
  });

  test('detectCursorTier correctly identifies plan tiers', () => {
    expect(detectCursorTier({ membershipType: 'pro' })).toBe('pro');
    expect(detectCursorTier({ membershipType: 'pro_plus' })).toBe('pro_plus');
    expect(detectCursorTier({ membershipType: 'ultra' })).toBe('ultra');
    expect(detectCursorTier({ membershipType: 'free' })).toBe('free');
    expect(detectCursorTier({ isTeamMember: true })).toBe('team');
    expect(detectCursorTier(null)).toBe('unknown');
    expect(detectCursorTier(undefined)).toBe('unknown');
  });

  test('cursorTierLabel returns human labels', () => {
    expect(cursorTierLabel('pro')).toBe('Pro');
    expect(cursorTierLabel('pro_plus')).toBe('Pro+');
    expect(cursorTierLabel('ultra')).toBe('Ultra');
    expect(cursorTierLabel('team')).toBe('Team');
    expect(cursorTierLabel('unknown')).toBe('Cursor');
  });

  test('detectCursorBillingModel: request_count when legacy gpt-4 has maxRequestUsage', () => {
    expect(detectCursorBillingModel(cursorFixture({ billing: 'request_count' }))).toBe('request_count');
  });

  test('detectCursorBillingModel: usd_credit when currentPeriod has planUsage', () => {
    expect(detectCursorBillingModel(cursorFixture({ billing: 'usd_credit' }))).toBe('usd_credit');
  });

  test('detectCursorBillingModel: unknown when no data', () => {
    expect(detectCursorBillingModel(null)).toBe('unknown');
    expect(detectCursorBillingModel(undefined)).toBe('unknown');
  });

  test('cursorLegacyPercent computes request usage percentage', () => {
    const data = cursorFixture({ billing: 'request_count', numRequests: 250, maxRequestUsage: 500 });
    expect(cursorLegacyPercent(data)).toBe(50);
  });

  test('cursorLegacyPercent returns null when no legacy data', () => {
    expect(cursorLegacyPercent(cursorFixture({ billing: 'usd_credit' }))).toBeNull();
  });

  test('cursorCreditPercent uses totalPercentUsed when available', () => {
    const data = cursorFixture({ billing: 'usd_credit', totalPercentUsed: 42.5 });
    expect(cursorCreditPercent(data)).toBe(42.5);
  });

  test('cursorCreditPercent computes from limit/remaining when no totalPercentUsed', () => {
    const data = cursorFixture({ billing: 'usd_credit', limitCents: 2000, remainingCents: 1000, totalPercentUsed: undefined });
    expect(cursorCreditPercent(data)).toBe(50);
  });

  test('cursorUsagePercent selects correct billing model metric', () => {
    expect(cursorUsagePercent(cursorFixture({ billing: 'usd_credit', totalPercentUsed: 30 }))).toBe(30);
    expect(cursorUsagePercent(cursorFixture({ billing: 'request_count', numRequests: 300, maxRequestUsage: 500 }))).toBe(60);
  });

  test('cursorCycleEnd extracts reset from currentPeriod billingCycleEnd (ms timestamp)', () => {
    const data = cursorFixture({ billing: 'usd_credit' });
    data.currentPeriod = { billingCycleEnd: '1722470400000' };
    const end = cursorCycleEnd(data);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('cursorCycleEnd falls back to legacy startOfMonth + 1 month', () => {
    const data = cursorFixture({ billing: 'request_count' });
    data.currentPeriod = null;
    data.legacyUsage = { 'gpt-4': null, startOfMonth: '2026-07-01T00:00:00.000Z' };
    const end = cursorCycleEnd(data);
    expect(end).toContain('2026-08-01');
  });

  test('deriveCursorAvailability: null data → auth required', () => {
    const avail = deriveCursorAvailability(null);
    expect(avail.available).toBe(false);
    expect(avail.tone).toBe('danger');
    expect(avail.label).toContain('auth required');
  });

  test('deriveCursorAvailability: active pro at 50% → available', () => {
    const avail = deriveCursorAvailability(cursorFixture({ billing: 'usd_credit', totalPercentUsed: 50, tier: 'pro' }));
    expect(avail.available).toBe(true);
    expect(avail.tone).toBe('ok');
    expect(avail.label).toContain('Pro');
  });

  test('deriveCursorAvailability: at 95% → warn', () => {
    const avail = deriveCursorAvailability(cursorFixture({ billing: 'usd_credit', totalPercentUsed: 95, tier: 'pro' }));
    expect(avail.available).toBe(true);
    expect(avail.tone).toBe('warn');
  });

  test('deriveCursorAvailability: at 100% → limit reached', () => {
    const avail = deriveCursorAvailability(cursorFixture({ billing: 'usd_credit', totalPercentUsed: 100, tier: 'pro' }));
    expect(avail.available).toBe(false);
    expect(avail.tone).toBe('danger');
    expect(avail.label).toContain('Limit reached');
  });

  test('deriveCursorAvailability: cancelled subscription', () => {
    const data = cursorFixture({ billing: 'usd_credit', totalPercentUsed: 20, tier: 'pro' });
    data.stripe = { ...data.stripe!, subscriptionStatus: 'cancelled' };
    const avail = deriveCursorAvailability(data);
    expect(avail.available).toBe(false);
    expect(avail.label).toContain('Cancelled');
  });

  test('deriveCursorAvailability: payment failed', () => {
    const data = cursorFixture({ billing: 'usd_credit', totalPercentUsed: 20, tier: 'pro' });
    data.stripe = { ...data.stripe!, lastPaymentFailed: true };
    const avail = deriveCursorAvailability(data);
    expect(avail.available).toBe(false);
    expect(avail.label).toContain('Payment failed');
  });

  test('combinedOverview includes averageCursorUtilization', () => {
    const cursorAccount = account('cursor');
    const cursorAccount2 = { ...cursorAccount, key: 'cursor-extra', label: 'Cursor · Extra' };
    const results: ProviderUsage[] = [
      { account: cursorAccount, ok: true, fetchedAt: 'now', sourceUrl: 'u', data: cursorFixture({ billing: 'usd_credit', totalPercentUsed: 40 }) },
      { account: cursorAccount2, ok: true, fetchedAt: 'now', sourceUrl: 'u', data: cursorFixture({ billing: 'usd_credit', totalPercentUsed: 60 }) },
    ];
    const combined = combinedOverview(results);
    expect(combined.averageCursorUtilization).toBe(50);
    expect(combined.availableProviders).toBe(2);
  });

  test('combinedOverview: cursor with auth-required state does not count as available', () => {
    const authRequired: CursorUsagePayload = { stripe: null, legacyUsage: null, currentPeriod: null, spending: null, billingModel: 'unknown' };
    const results: ProviderUsage[] = [
      { account: account('cursor'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: authRequired },
    ];
    const combined = combinedOverview(results);
    expect(combined.availableProviders).toBe(0);
  });

  test('parseCursorUsagePayload includes spending from usageSummary', () => {
    const payload = parseCursorUsagePayload({
      stripe: { membershipType: 'pro', subscriptionStatus: 'active' },
      usage: null,
      usageSummary: {
        billingCycleStart: '2026-07-07T09:45:44.409Z',
        billingCycleEnd: '2026-08-07T09:45:44.409Z',
        membershipType: 'pro',
        isUnlimited: false,
        individualUsage: {
          plan: {
            enabled: true,
            used: 1200,
            limit: 2000,
            remaining: 800,
            breakdown: { included: 1000, bonus: 200, total: 1200 },
            autoPercentUsed: 40,
            apiPercentUsed: 20,
            totalPercentUsed: 60,
          },
          onDemand: {
            enabled: true,
            used: 500,
            limit: 5000,
            remaining: 4500,
          },
        },
      },
    });
    expect(payload.spending).not.toBeNull();
    expect(payload.spending?.totalCents).toBe(1700);
    expect(payload.spending?.includedCents).toBe(1200);
    expect(payload.spending?.onDemandCents).toBe(500);
    expect(payload.spending?.budgetLimitCents).toBe(5000);
    expect(payload.spending?.onDemandEnabled).toBe(true);
    expect(payload.currentPeriod?.planUsage?.totalPercentUsed).toBe(60);
    expect(payload.currentPeriod?.planUsage?.breakdown?.included).toBe(1000);
    expect(payload.onDemand?.enabled).toBe(true);
    expect(payload.onDemand?.used).toBe(500);
    expect(payload.isUnlimited).toBe(false);
  });

  test('parseCursorUsagePayload spending null when no usageSummary', () => {
    const payload = parseCursorUsagePayload({
      stripe: null,
      usage: null,
    });
    expect(payload.spending).toBeNull();
  });

  test('cursorTotalSpendDollars converts cents to dollars', () => {
    const data: CursorUsagePayload = {
      ...cursorFixture({ billing: 'usd_credit', totalPercentUsed: 50 }),
      spending: { totalCents: 1250, includedCents: 1000, onDemandCents: 250, budgetLimitCents: 5000, onDemandEnabled: true },
    };
    expect(cursorTotalSpendDollars(data)).toBe(12.5);
    expect(cursorIncludedSpendDollars(data)).toBe(10);
    expect(cursorOnDemandSpendDollars(data)).toBe(2.5);
  });

  test('cursorTotalSpendDollars returns null when no spending', () => {
    expect(cursorTotalSpendDollars(null)).toBeNull();
    expect(cursorTotalSpendDollars(cursorFixture({ billing: 'usd_credit' }))).toBeNull();
  });

  test('parseCursorUsagePayload billingCycle from usageSummary populates currentPeriod', () => {
    const payload = parseCursorUsagePayload({
      stripe: { membershipType: 'free', subscriptionStatus: 'canceled' },
      usage: { 'gpt-4': { numRequests: 0, maxRequestUsage: null }, startOfMonth: '2026-07-07T09:45:44.409Z' },
      usageSummary: {
        billingCycleStart: '2026-07-07T09:45:44.409Z',
        billingCycleEnd: '2026-08-07T09:45:44.409Z',
        membershipType: 'free',
        isUnlimited: false,
        individualUsage: {
          plan: { enabled: true, used: 0, limit: 0, remaining: 0, breakdown: { included: 0, bonus: 0, total: 0 }, autoPercentUsed: 0, apiPercentUsed: 0, totalPercentUsed: 0 },
          onDemand: { enabled: false, used: 0, limit: null, remaining: null },
        },
      },
    });
    expect(payload.currentPeriod?.billingCycleStart).toBe('2026-07-07T09:45:44.409Z');
    expect(payload.currentPeriod?.billingCycleEnd).toBe('2026-08-07T09:45:44.409Z');
    expect(payload.currentPeriod?.planUsage?.enabled).toBe(true);
    expect(payload.spending?.totalCents).toBe(0);
    expect(payload.spending?.onDemandEnabled).toBe(false);
    expect(payload.billingModel).toBe('usd_credit');
  });

  test('multiple cursor accounts work independently in combinedOverview', () => {
    const cursorAccount = account('cursor');
    const cursorAccount2 = { ...cursorAccount, key: 'cursor-extra', label: 'Cursor · Extra' };
    const results: ProviderUsage[] = [
      { account: cursorAccount, ok: true, fetchedAt: 'now', sourceUrl: 'u', data: cursorFixture({ billing: 'usd_credit', totalPercentUsed: 30 }) },
      { account: cursorAccount2, ok: false, error: 'Not authenticated', fetchedAt: 'now', sourceUrl: 'u' },
      { account: account('claude-personal'), ok: true, fetchedAt: 'now', sourceUrl: 'u', data: { five_hour: { utilization: 50 } } },
    ];
    const combined = combinedOverview(results);
    expect(combined.okAccounts).toBe(2);
    expect(combined.totalAccounts).toBe(3);
    expect(combined.averageCursorUtilization).toBe(30);
    expect(combined.averageSessionUtilization).toBe(50);
  });
});

function codexFixture(opts: {
  plan_type?: string;
  used_percent?: number;
  limit_reached?: boolean;
  allowed?: boolean;
  limit_window_seconds?: number;
  reset_at?: number;
}): CodexUsagePayload {
  return {
    user_id: 'user-test',
    account_id: 'user-test',
    email: 'test@example.com',
    plan_type: opts.plan_type ?? 'plus',
    rate_limit: {
      allowed: opts.allowed ?? !opts.limit_reached,
      limit_reached: opts.limit_reached ?? false,
      primary_window: {
        used_percent: opts.used_percent ?? 0,
        limit_window_seconds: opts.limit_window_seconds ?? 604800,
        reset_after_seconds: 500000,
        reset_at: opts.reset_at ?? 1784838842,
      },
      secondary_window: null,
    },
    code_review_rate_limit: null,
    additional_rate_limits: null,
    credits: {
      has_credits: false,
      unlimited: false,
      overage_limit_reached: false,
      balance: '0',
      approx_local_messages: [0],
      approx_cloud_messages: [0],
    },
    spend_control: { reached: false, individual_limit: null },
    rate_limit_reached_type: null,
    promo: null,
    rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 },
  };
}

function cursorFixture(opts: {
  billing?: 'request_count' | 'usd_credit';
  tier?: 'free' | 'pro' | 'pro_plus' | 'ultra' | 'team';
  numRequests?: number;
  maxRequestUsage?: number;
  limitCents?: number;
  remainingCents?: number;
  totalPercentUsed?: number;
}): CursorUsagePayload {
  const tier = opts.tier ?? 'pro';
  const billing = opts.billing ?? 'unknown';
  if (billing === 'request_count') {
    return {
      stripe: { membershipType: tier, subscriptionStatus: 'active' },
      legacyUsage: {
        'gpt-4': {
          numRequests: opts.numRequests ?? 150,
          maxRequestUsage: opts.maxRequestUsage ?? 500,
        },
        startOfMonth: '2026-07-01T00:00:00.000Z',
      },
      currentPeriod: null,
      spending: null,
      billingModel: 'request_count',
    };
  }
  if (billing === 'usd_credit') {
    const limit = opts.limitCents ?? 2000;
    const hasPct = 'totalPercentUsed' in opts && opts.totalPercentUsed !== undefined;
    const pct = hasPct ? opts.totalPercentUsed! : 25;
    const used = 'remainingCents' in opts ? (limit - (opts.remainingCents ?? 0)) : Math.round((limit * pct) / 100);
    const remaining = opts.remainingCents ?? (limit - used);
    return {
      stripe: { membershipType: tier, subscriptionStatus: 'active' },
      legacyUsage: null,
      currentPeriod: {
        billingCycleStart: '1719792000000',
        billingCycleEnd: '1722470400000',
        planUsage: {
          limit,
          remaining,
          used,
          totalPercentUsed: opts.totalPercentUsed,
          autoPercentUsed: undefined,
          apiPercentUsed: undefined,
        },
      },
      spending: null,
      billingModel: 'usd_credit',
    };
  }
  return {
    stripe: { membershipType: tier, subscriptionStatus: 'active' },
    legacyUsage: null,
    currentPeriod: null,
    spending: null,
    billingModel: 'unknown',
  };
}
