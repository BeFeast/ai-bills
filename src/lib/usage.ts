import type { AccountConfig } from './config';

export type ClaudeLimitWindow = {
  utilization?: number | null;
  resets_at?: string | null;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
};

export type ClaudeLimitEntry = {
  kind?: string | null;
  group?: string | null;
  percent?: number | null;
  severity?: string | null;
  state?: string | null;
  status?: string | null;
  blocked?: boolean | null;
  exhausted?: boolean | null;
  resets_at?: string | null;
  scope?: string | { model?: { display_name?: string | null } | null; surface?: string | null; [key: string]: unknown } | null;
  is_active?: boolean | null;
};

export type ClaudeSpend = {
  used?: number | null;
  limit?: number | null;
  percent?: number | null;
  severity?: string | null;
  enabled?: boolean | null;
  cap?: unknown;
  balance?: unknown;
};

export type ClaudeUsagePayload = {
  five_hour?: ClaudeLimitWindow | null;
  seven_day?: ClaudeLimitWindow | null;
  limits?: ClaudeLimitEntry[] | null;
  spend?: ClaudeSpend | null;
  extra_usage?: unknown;
  member_dashboard_available?: boolean | null;
  [key: string]: unknown;
};

export type KimiQuotaDetail = {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetTime: string | null;
};

export type KimiQuotaWindow = {
  duration: number | null;
  timeUnit: string | null;
  detail: KimiQuotaDetail;
};

export type KimiUsageEntry = {
  scope: string;
  detail: KimiQuotaDetail;
  limits: KimiQuotaWindow[];
};

export type KimiUsagePayload = {
  usages: KimiUsageEntry[];
  totalQuota: Pick<KimiQuotaDetail, 'limit' | 'remaining'>;
};

export type CursorStripeInfo = {
  membershipType?: string | null;
  individualMembershipType?: string | null;
  subscriptionStatus?: string | null;
  isTeamMember?: boolean | null;
  isYearlyPlan?: boolean | null;
  isOnBillableAuto?: boolean | null;
  customerBalance?: number | null;
  pendingCancellationDate?: string | null;
  lastPaymentFailed?: boolean | null;
  trialEligible?: boolean | null;
};

export type CursorLegacyModelUsage = {
  numRequests?: number | null;
  maxRequestUsage?: number | null;
};

export type CursorPlanUsage = {
  enabled?: boolean | null;
  limit?: number | null;
  remaining?: number | null;
  used?: number | null;
  totalPercentUsed?: number | null;
  autoPercentUsed?: number | null;
  apiPercentUsed?: number | null;
  breakdown?: {
    included?: number | null;
    bonus?: number | null;
    total?: number | null;
  } | null;
};

export type CursorOnDemandUsage = {
  enabled?: boolean | null;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
};

export type CursorSpendLimit = {
  pooledLimit?: number | null;
  pooledRemaining?: number | null;
  individualLimit?: number | null;
  limitType?: string | null;
  overallLimit?: number | null;
  overallRemaining?: number | null;
};

export type CursorSpending = {
  /** Total spend in cents (plan + on-demand) */
  totalCents?: number | null;
  /** Included/plan spend in cents */
  includedCents?: number | null;
  /** On-demand spend in cents */
  onDemandCents?: number | null;
  /** On-demand budget limit in cents (null = no limit set) */
  budgetLimitCents?: number | null;
  /** Whether on-demand is enabled for this account */
  onDemandEnabled?: boolean | null;
};

export type CursorUsagePayload = {
  stripe: CursorStripeInfo | null;
  legacyUsage: {
    'gpt-4'?: CursorLegacyModelUsage | null;
    startOfMonth?: string | null;
  } | null;
  currentPeriod: {
    billingCycleStart?: string | null;
    billingCycleEnd?: string | null;
    planUsage?: CursorPlanUsage | null;
  } | null;
  spending: CursorSpending | null;
  onDemand?: CursorOnDemandUsage | null;
  spendLimit?: CursorSpendLimit | null;
  billingModel: 'request_count' | 'usd_credit' | 'unknown';
  isOnNewPricing?: boolean | null;
  isUnlimited?: boolean | null;
};

export type CursorPlanTier = 'free' | 'pro' | 'pro_plus' | 'ultra' | 'team' | 'unknown';

export type ProviderConfig = AccountConfig;

export type PublicUsageAccount = Pick<AccountConfig, 'key' | 'provider' | 'label' | 'email'> & {
  authOwner?: 'local' | 'cliproxy';
  authManagementUrl?: string;
};

export type CodexRateWindow = {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
};

export type CodexRateLimit = {
  allowed: boolean;
  limit_reached: boolean;
  primary_window: CodexRateWindow | null;
  secondary_window: CodexRateWindow | null;
};

export type CodexAdditionalRateLimit = {
  limit_name: string;
  metered_feature: string;
  rate_limit: CodexRateLimit;
};

export type CodexCredits = {
  has_credits: boolean;
  unlimited: boolean;
  overage_limit_reached: boolean;
  balance: string;
  approx_local_messages: number[];
  approx_cloud_messages: number[];
};

export type CodexSpendControl = {
  reached: boolean;
  individual_limit: number | null;
};

export type CodexUsagePayload = {
  user_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  rate_limit: CodexRateLimit;
  code_review_rate_limit: CodexRateLimit | null;
  additional_rate_limits: CodexAdditionalRateLimit[] | null;
  credits: CodexCredits;
  spend_control: CodexSpendControl;
  rate_limit_reached_type: string | null;
  promo: unknown;
  rate_limit_reset_credits: {
    available_count: number;
    applicable_available_count: number;
  };
};

/** Placeholder error until an account's first observation lands; consumers treat it as pending, not failing. */
export const PENDING_OBSERVATION = 'Waiting for the first quota observation';
export const isPendingObservation = (result: ProviderUsage) => !result.ok && result.status === undefined && result.error === PENDING_OBSERVATION;

export type ProviderUsage = {
  account: PublicUsageAccount;
  ok: boolean;
  status?: number;
  statusText?: string;
  data?: ClaudeUsagePayload | KimiUsagePayload | CodexUsagePayload | CursorUsagePayload;
  error?: string;
  fetchedAt: string;
  sourceUrl: string;
};

export function usageUrl(account: ProviderConfig): string {
  if (account.provider === 'claude') return `https://claude.ai/api/organizations/${account.claude_org_id}/usage`;
  if (account.provider === 'kimi') return 'https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages';
  if (account.provider === 'cursor') return 'https://cursor.com/api/usage-summary';
  return 'https://chatgpt.com/backend-api/wham/usage';
}

export function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function scopedModelLimits(data?: ClaudeUsagePayload): ClaudeLimitEntry[] {
  return (data?.limits ?? []).filter((limit) => limit?.kind === 'weekly_scoped');
}

export function activeWeeklyAll(data?: ClaudeUsagePayload): ClaudeLimitEntry | undefined {
  return (data?.limits ?? []).find((limit) => Boolean(limit?.is_active) && limit?.kind === 'weekly_all');
}

export function activeSession(data?: ClaudeUsagePayload): ClaudeLimitEntry | undefined {
  return (data?.limits ?? []).find((limit) => Boolean(limit?.is_active) && limit?.kind === 'session');
}

/** Prefer the limit row for a kind regardless of is_active (UI metadata / severity). */
export function claudeLimitByKind(data?: ClaudeUsagePayload, kind?: string): ClaudeLimitEntry | undefined {
  if (!kind) return undefined;
  return (data?.limits ?? []).find((limit) => limit?.kind === kind);
}

/**
 * Claude's usage API reports whole percents (0..100), never 0..1 fractions.
 * An earlier "normalize fractions" heuristic multiplied any value <= 1 by 100,
 * so a real 1 % weekly window rendered as 100 % and tripped isLimitExhausted()
 * into "No models available". Take the number as-is.
 */
export function displayPercent(value: number | null | undefined): number | null {
  return percent(value);
}

export function windowUtilization(window?: ClaudeLimitWindow | null): number | null {
  return displayPercent(window?.utilization);
}

export function limitPercent(limit?: ClaudeLimitEntry | null): number | null {
  return displayPercent(limit?.percent);
}

export type ModelAvailability = {
  state: 'all' | 'partial' | 'none';
  tone: 'ok' | 'warn' | 'danger';
  label: string;
  detail: string;
  exhaustedLimits: ClaudeLimitEntry[];
};

const BLOCKING_WORDS = /exhaust|block|limit|cap|denied|unavailable|disabled|hard_stop/i;

export function isLimitExhausted(limit?: ClaudeLimitEntry | null): boolean {
  if (!limit) return false;
  if (limit.exhausted === true || limit.blocked === true) return true;
  if (limitPercent(limit) !== null && limitPercent(limit)! >= 100) return true;
  return [limit.severity, limit.state, limit.status].some((value) => typeof value === 'string' && BLOCKING_WORDS.test(value));
}

export function scopeLabel(limit?: ClaudeLimitEntry | null): string {
  const scope = limit?.scope;
  if (scope && typeof scope === 'object') return scope.model?.display_name || scope.surface || limit?.group || 'Scoped model';
  return scope || limit?.group || 'Scoped model';
}

export type ClaudeWindow = {
  kind: 'session' | 'weekly_all' | 'weekly_scoped';
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  isActive: boolean;
  severity: string | null;
  exhausted: boolean;
};

/** Every limit window Claude reports for an account, in display order: session, weekly all models, then each scoped model. */
export function claudeWindows(data?: ClaudeUsagePayload | null): ClaudeWindow[] {
  const windows: ClaudeWindow[] = [];
  const push = (kind: ClaudeWindow['kind'], label: string, window: ClaudeLimitWindow | null | undefined, limit: ClaudeLimitEntry | undefined) => {
    const used = pickFinite(windowUtilization(window), limitPercent(limit));
    if (used === null) return;
    windows.push({ kind, label, usedPercent: used, resetsAt: window?.resets_at || limit?.resets_at || null,
      isActive: limit?.is_active === true, severity: limit?.severity ?? null, exhausted: used >= 100 || isLimitExhausted(limit) });
  };
  push('session', 'Session', data?.five_hour, claudeLimitByKind(data ?? undefined, 'session'));
  push('weekly_all', 'Weekly all models', data?.seven_day, claudeLimitByKind(data ?? undefined, 'weekly_all'));
  for (const limit of scopedModelLimits(data ?? undefined)) push('weekly_scoped', `${scopeLabel(limit)} weekly`, null, limit);
  return windows;
}

/** The window Claude marks active is the one constraining the account; otherwise the most used window. */
export function claudeLimitingWindow(data?: ClaudeUsagePayload | null): ClaudeWindow | null {
  const windows = claudeWindows(data);
  const mostUsed = (list: ClaudeWindow[]) => list.reduce<ClaudeWindow | null>((best, window) => best && best.usedPercent >= window.usedPercent ? best : window, null);
  return mostUsed(windows.filter((window) => window.isActive)) ?? mostUsed(windows);
}

function pickFinite(...values: Array<number | null | undefined>): number | null {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

export type QuotaTone = 'warn' | 'bad' | undefined;
/** Shared thresholds for every quota surface: warn under 25 % left, bad under 10 % left or exhausted. */
export function quotaTone(remainingPercent: number | null | undefined, exhausted = false): QuotaTone {
  if (exhausted) return 'bad';
  if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) return undefined;
  if (remainingPercent < 10) return 'bad';
  if (remainingPercent < 25) return 'warn';
  return undefined;
}

export function deriveModelAvailability(data?: ClaudeUsagePayload): ModelAvailability {
  const exhausted = (data?.limits ?? []).filter(isLimitExhausted);
  const globalLimit = exhausted.find((limit) => limit.kind === 'session' || limit.kind === 'weekly_all');
  if (globalLimit) {
    const name = globalLimit.kind === 'session' ? 'session' : 'weekly all-models';
    return {
      state: 'none',
      tone: 'danger',
      label: 'No models available',
      detail: `Blocked by exhausted ${name} limit (${fmtLimitPercent(globalLimit)}).`,
      exhaustedLimits: exhausted,
    };
  }
  const fableLimit = exhausted.find((limit) => limit.kind === 'weekly_scoped' && /fable/i.test(scopeLabel(limit)));
  if (fableLimit) {
    return {
      state: 'partial',
      tone: 'warn',
      label: 'Fable unavailable · other models available',
      detail: `Fable scoped limit is exhausted (${fmtLimitPercent(fableLimit)}). Session and weekly all-model limits are not exhausted.`,
      exhaustedLimits: exhausted,
    };
  }
  return {
    state: 'all',
    tone: 'ok',
    label: 'All models available',
    detail: exhausted.length
      ? `No global or Fable scoped limit is exhausted. Other exhausted scoped limits: ${exhausted.map(scopeLabel).join(', ')}.`
      : 'No session, weekly all-model, or Fable scoped limit is exhausted. Near-limit values below 100% remain available.',
    exhaustedLimits: exhausted,
  };
}

export type CodingAvailability = {
  available: boolean;
  tone: 'ok' | 'warn' | 'danger';
  label: string;
  detail: string;
};

export function parseKimiUsagePayload(input: unknown): KimiUsagePayload {
  const record = asRecord(input, 'Kimi payload');
  const usagesRaw = record.usages;
  if (!Array.isArray(usagesRaw)) throw new Error('Kimi payload missing usages array');
  const usages = usagesRaw.map(parseKimiUsageEntry);
  return {
    usages,
    totalQuota: parseQuotaDetail(asRecord(record.totalQuota, 'Kimi totalQuota'), false),
  };
}

function parseKimiUsageEntry(input: unknown): KimiUsageEntry {
  const record = asRecord(input, 'Kimi usage entry');
  const limitsRaw = record.limits;
  return {
    scope: typeof record.scope === 'string' ? record.scope : 'UNKNOWN',
    detail: parseQuotaDetail(record.detail, true),
    limits: Array.isArray(limitsRaw) ? limitsRaw.map(parseKimiQuotaWindow) : [],
  };
}

function parseKimiQuotaWindow(input: unknown): KimiQuotaWindow {
  const record = asRecord(input, 'Kimi quota window');
  const windowRecord = asRecord(record.window, 'Kimi quota window.window');
  return {
    duration: parseNumericString(windowRecord.duration),
    timeUnit: typeof windowRecord.timeUnit === 'string' ? windowRecord.timeUnit : null,
    detail: parseQuotaDetail(record.detail, true),
  };
}

function parseQuotaDetail(input: unknown, requireUsed: boolean): KimiQuotaDetail {
  const record = asRecord(input, 'Kimi quota detail');
  return {
    limit: parseNumericString(record.limit),
    used: requireUsed ? parseNumericString(record.used) : parseOptionalNumericString(record.used),
    remaining: parseNumericString(record.remaining),
    resetTime: typeof record.resetTime === 'string' ? record.resetTime : null,
  };
}

function parseNumericString(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseOptionalNumericString(value: unknown): number | null {
  return value == null ? null : parseNumericString(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${label} is not an object`);
}

export function kimiCodingUsage(data?: KimiUsagePayload | null): KimiUsageEntry | null {
  return data?.usages.find((usage) => usage.scope === 'FEATURE_CODING') ?? data?.usages[0] ?? null;
}

export function kimiWindow(data: KimiUsagePayload | null | undefined, duration: number, timeUnit: string): KimiQuotaWindow | null {
  return kimiCodingUsage(data)?.limits.find((limit) => limit.duration === duration && limit.timeUnit === timeUnit) ?? null;
}

export function kimiUsagePercent(detail?: KimiQuotaDetail | null): number | null {
  if (!detail?.limit || detail.limit <= 0 || detail.used == null) return null;
  return (detail.used / detail.limit) * 100;
}

export function codexPrimaryWindow(data?: CodexUsagePayload | null): CodexRateWindow | null {
  return data?.rate_limit?.primary_window ?? null;
}

export function codexWindowResetIso(window: CodexRateWindow | null): string | null {
  if (!window?.reset_at) return null;
  return new Date(window.reset_at * 1000).toISOString();
}

export function codexWindowDurationLabel(window: CodexRateWindow | null): string {
  if (!window?.limit_window_seconds) return 'Usage window';
  const days = Math.round(window.limit_window_seconds / 86400);
  if (days === 7) return 'Weekly usage';
  if (days === 1) return 'Daily usage';
  const hours = Math.round(window.limit_window_seconds / 3600);
  if (hours > 0) return `${hours}h usage`;
  return `${window.limit_window_seconds}s usage`;
}

export function deriveCodexAvailability(data?: CodexUsagePayload | null, status?: number | null): CodingAvailability {
  if (!data || !data.rate_limit) {
    // A 5xx is WHAM being down, not a broken token — don't send the user to re-auth.
    if (typeof status === 'number' && status >= 500) {
      return {
        available: false,
        tone: 'warn',
        label: 'Codex API unavailable',
        detail: `WHAM endpoint returned HTTP ${status}. Auth is untouched; the next refresh retries automatically.`,
      };
    }
    return {
      available: false,
      tone: 'danger',
      label: 'Codex auth required',
      detail: 'WHAM endpoint returned no rate_limit data. Run Codex device auth for this identity.',
    };
  }
  const rl = data.rate_limit;
  if (rl.limit_reached || !rl.allowed) {
    const pct = rl.primary_window?.used_percent ?? 100;
    const resetIso = codexWindowResetIso(rl.primary_window);
    return {
      available: false,
      tone: 'danger',
      label: 'Rate limit reached',
      detail: `Primary window at ${pct}%.${resetIso ? ` Resets ${resetIso}.` : ''} ${data.rate_limit_reached_type ? `Type: ${data.rate_limit_reached_type}.` : ''}`,
    };
  }
  const pct = rl.primary_window?.used_percent ?? 0;
  if (pct >= 90) {
    return {
      available: true,
      tone: 'warn',
      label: 'Near rate limit',
      detail: `Primary window at ${pct}%. Plan: ${data.plan_type}.`,
    };
  }
  return {
    available: true,
    tone: 'ok',
    label: `${capitalize(data.plan_type)} · Available`,
    detail: `Primary window at ${pct}%. Credits balance: ${data.credits?.balance ?? '0'}.`,
  };
}

function capitalize(s: string | null | undefined): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function deriveKimiAvailability(data?: KimiUsagePayload | null): CodingAvailability {
  const coding = kimiCodingUsage(data);
  if (!coding) {
    return {
      available: false,
      tone: 'danger',
      label: 'No coding models available',
      detail: 'Kimi coding quota was not returned by the API.',
    };
  }
  const overall = coding.detail;
  const pct = kimiUsagePercent(overall);
  if ((overall.remaining ?? 0) <= 0) {
    return {
      available: false,
      tone: 'danger',
      label: 'No coding models available',
      detail: 'Global coding quota is exhausted.',
    };
  }
  if (pct !== null && pct >= 90) {
    return {
      available: true,
      tone: 'warn',
      label: 'Coding available',
      detail: `Global coding quota is near limit at ${pct.toFixed(1)}%.`,
    };
  }
  return {
    available: true,
    tone: 'ok',
    label: 'Coding available',
    detail: 'Global coding quota has remaining capacity.',
  };
}

function fmtLimitPercent(limit: ClaudeLimitEntry): string {
  const pct = limitPercent(limit);
  return pct === null ? 'explicit blocking state' : `${pct.toFixed(1)}%`;
}

export function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

export function combinedOverview(results: ProviderUsage[]) {
  const ok = results.filter((r) => r.ok && r.data);
  const claude = ok.filter((r) => r.account.provider === 'claude');
  const codex = ok.filter((r) => r.account.provider === 'codex');
  const cursor = ok.filter((r) => r.account.provider === 'cursor');
  const providerStatuses = ok.map((result) => ({
    key: result.account.key,
    provider: result.account.provider,
    available: result.account.provider === 'claude'
      ? deriveModelAvailability(result.data as ClaudeUsagePayload).state !== 'none'
      : result.account.provider === 'kimi'
        ? deriveKimiAvailability(result.data as KimiUsagePayload).available
        : result.account.provider === 'cursor'
          ? deriveCursorAvailability(result.data as CursorUsagePayload).available
          : deriveCodexAvailability(result.data as CodexUsagePayload).available,
  }));
  const sessionValues = claude.map((r) => windowUtilization((r.data as ClaudeUsagePayload)?.five_hour) ?? limitPercent(activeSession(r.data as ClaudeUsagePayload)));
  const weeklyValues = claude.map((r) => windowUtilization((r.data as ClaudeUsagePayload)?.seven_day) ?? limitPercent(activeWeeklyAll(r.data as ClaudeUsagePayload)));
  const scopedValues = claude.flatMap((r) => scopedModelLimits(r.data as ClaudeUsagePayload).map(limitPercent));
  const codexValues = codex.map((r) => (r.data as CodexUsagePayload)?.rate_limit?.primary_window?.used_percent ?? null);
  const cursorValues = cursor.map((r) => cursorUsagePercent(r.data as CursorUsagePayload));
  return {
    okAccounts: ok.length,
    totalAccounts: results.length,
    availableProviders: providerStatuses.filter((item) => item.available).length,
    unavailableProviders: results.length - providerStatuses.filter((item) => item.available).length,
    averageSessionUtilization: average(sessionValues),
    averageWeeklyAllUtilization: average(weeklyValues),
    averageScopedModelUtilization: average(scopedValues),
    averageCodexUtilization: average(codexValues),
    averageCursorUtilization: average(cursorValues),
    providerStatuses,
  };
}

export function severityClass(percentValue: number | null | undefined, severity?: string | null): 'ok' | 'warn' | 'danger' | 'muted' {
  const sev = (severity ?? '').toLowerCase();
  if (sev.includes('danger') || sev.includes('error') || sev.includes('critical')) return 'danger';
  if (sev.includes('warn')) return 'warn';
  const p = typeof percentValue === 'number' ? percentValue : null;
  if (p === null) return 'muted';
  if (p >= 90) return 'danger';
  if (p >= 70) return 'warn';
  return 'ok';
}

export function detectCursorBillingModel(data?: CursorUsagePayload | null): 'request_count' | 'usd_credit' | 'unknown' {
  if (!data) return 'unknown';
  // New pricing model uses USD credits
  if (data.isOnNewPricing === true) return 'usd_credit';
  const pu = data.currentPeriod?.planUsage;
  if (pu) {
    if (pu.enabled === true
        || (typeof pu.limit === 'number' && pu.limit > 0)
        || (typeof pu.totalPercentUsed === 'number' && Number.isFinite(pu.totalPercentUsed))) {
      return 'usd_credit';
    }
  }
  const legacy = data.legacyUsage?.['gpt-4'];
  if (typeof legacy?.maxRequestUsage === 'number' && legacy.maxRequestUsage > 0
      && typeof legacy?.numRequests === 'number') {
    return 'request_count';
  }
  return 'unknown';
}

export function detectCursorTier(stripe?: CursorStripeInfo | null): CursorPlanTier {
  if (!stripe) return 'unknown';
  if (stripe.isTeamMember) return 'team';
  const m = (stripe.membershipType ?? '').toLowerCase();
  if (m === 'ultra') return 'ultra';
  if (m === 'pro_plus' || m === 'pro+') return 'pro_plus';
  if (m === 'pro') return 'pro';
  if (m === 'free' || m === '') return 'free';
  return 'unknown';
}

export function cursorTierLabel(tier: CursorPlanTier): string {
  switch (tier) {
    case 'free': return 'Free';
    case 'pro': return 'Pro';
    case 'pro_plus': return 'Pro+';
    case 'ultra': return 'Ultra';
    case 'team': return 'Team';
    case 'unknown': return 'Cursor';
  }
}

export function cursorLegacyPercent(data?: CursorUsagePayload | null): number | null {
  const model = data?.legacyUsage?.['gpt-4'];
  if (!model || typeof model.numRequests !== 'number' || typeof model.maxRequestUsage !== 'number' || model.maxRequestUsage <= 0) return null;
  return Math.min(100, (model.numRequests / model.maxRequestUsage) * 100);
}

export function cursorCreditPercent(data?: CursorUsagePayload | null): number | null {
  const pu = data?.currentPeriod?.planUsage;
  if (!pu) return null;
  if (typeof pu.totalPercentUsed === 'number' && Number.isFinite(pu.totalPercentUsed)) return pu.totalPercentUsed;
  if (typeof pu.limit === 'number' && pu.limit > 0) {
    let used = 0;
    if (typeof pu.used === 'number') used = pu.used;
    else if (typeof pu.remaining === 'number') used = pu.limit - pu.remaining;
    return Math.max(0, Math.min(100, (used / pu.limit) * 100));
  }
  return null;
}

export function cursorUsagePercent(data?: CursorUsagePayload | null): number | null {
  const billing = data?.billingModel ?? detectCursorBillingModel(data);
  if (billing === 'usd_credit') return cursorCreditPercent(data);
  if (billing === 'request_count') return cursorLegacyPercent(data);
  return cursorCreditPercent(data) ?? cursorLegacyPercent(data);
}

export function cursorCycleEnd(data?: CursorUsagePayload | null): string | null {
  if (data?.currentPeriod?.billingCycleEnd) {
    const ms = Number(data.currentPeriod.billingCycleEnd);
    if (Number.isFinite(ms) && ms > 1e12) return new Date(ms).toISOString();
    return data.currentPeriod.billingCycleEnd;
  }
  if (data?.legacyUsage?.startOfMonth) {
    const start = new Date(data.legacyUsage.startOfMonth);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth() + 1,
        start.getUTCDate(),
      ));
      return end.toISOString();
    }
  }
  return null;
}

export function deriveCursorAvailability(data?: CursorUsagePayload | null): CodingAvailability {
  if (!data || (!data.stripe && !data.legacyUsage && !data.currentPeriod)) {
    return {
      available: false,
      tone: 'danger',
      label: 'Cursor auth required',
      detail: 'No Cursor session found. Log into cursor.com in the CDP browser profile.',
    };
  }
  const tier = detectCursorTier(data.stripe);
  const tierLabel = cursorTierLabel(tier);
  const pct = cursorUsagePercent(data);
  const billing = data.billingModel ?? detectCursorBillingModel(data);

  if (data.stripe?.lastPaymentFailed) {
    return {
      available: false,
      tone: 'danger',
      label: `${tierLabel} · Payment failed`,
      detail: 'Last payment failed. Usage may be restricted.',
    };
  }

  const status = (data.stripe?.subscriptionStatus ?? '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return {
      available: false,
      tone: 'danger',
      label: `${tierLabel} · Cancelled`,
      detail: data.stripe?.pendingCancellationDate
        ? `Subscription cancelled. Access until ${data.stripe.pendingCancellationDate}.`
        : 'Subscription cancelled.',
    };
  }

  if (pct !== null && pct >= 100) {
    return {
      available: false,
      tone: 'danger',
      label: `${tierLabel} · Limit reached`,
      detail: billing === 'usd_credit'
        ? `Usage at ${pct.toFixed(1)}%. Monthly credit budget exhausted.`
        : `Requests at ${pct.toFixed(1)}%. Monthly request quota exhausted.`,
    };
  }

  if (pct !== null && pct >= 90) {
    return {
      available: true,
      tone: 'warn',
      label: `${tierLabel} · Near limit`,
      detail: billing === 'usd_credit'
        ? `Credit usage at ${pct.toFixed(1)}%.`
        : `Request usage at ${pct.toFixed(1)}%.`,
    };
  }

  return {
    available: true,
    tone: 'ok',
    label: `${tierLabel} · Available`,
    detail: pct !== null
      ? `Usage at ${pct.toFixed(1)}%.`
      : `Plan: ${tierLabel}. Status: ${status || 'active'}.`,
  };
}

export function parseCursorUsagePayload(raw: { stripe: unknown; usage: unknown; currentPeriod?: unknown; usageSummary?: unknown }): CursorUsagePayload {
  const stripe = parseCursorStripe(raw.stripe);
  const legacyUsage = parseCursorLegacyUsage(raw.usage);
  let currentPeriod = parseCursorCurrentPeriod(raw.currentPeriod);
  let spending: CursorSpending | null = null;
  let onDemand: CursorOnDemandUsage | null = null;
  let isUnlimited: boolean | null = null;

  // Prefer /api/usage-summary data when available
  if (raw.usageSummary && typeof raw.usageSummary === 'object') {
    const summary = raw.usageSummary as Record<string, unknown>;
    const indiv = summary.individualUsage as Record<string, unknown> | undefined;
    if (indiv) {
      const plan = indiv.plan as Record<string, unknown> | undefined;
      const od = indiv.onDemand as Record<string, unknown> | undefined;
      if (plan) {
        const breakdown = plan.breakdown as Record<string, unknown> | undefined;
        const planUsage: CursorPlanUsage = {
          enabled: typeof plan.enabled === 'boolean' ? plan.enabled : null,
          limit: typeof plan.limit === 'number' ? plan.limit : null,
          remaining: typeof plan.remaining === 'number' ? plan.remaining : null,
          used: typeof plan.used === 'number' ? plan.used : null,
          totalPercentUsed: typeof plan.totalPercentUsed === 'number' ? plan.totalPercentUsed : null,
          autoPercentUsed: typeof plan.autoPercentUsed === 'number' ? plan.autoPercentUsed : null,
          apiPercentUsed: typeof plan.apiPercentUsed === 'number' ? plan.apiPercentUsed : null,
          breakdown: breakdown ? {
            included: typeof breakdown.included === 'number' ? breakdown.included : null,
            bonus: typeof breakdown.bonus === 'number' ? breakdown.bonus : null,
            total: typeof breakdown.total === 'number' ? breakdown.total : null,
          } : null,
        };
        currentPeriod = {
          billingCycleStart: typeof summary.billingCycleStart === 'string' ? summary.billingCycleStart : currentPeriod?.billingCycleStart ?? null,
          billingCycleEnd: typeof summary.billingCycleEnd === 'string' ? summary.billingCycleEnd : currentPeriod?.billingCycleEnd ?? null,
          planUsage,
        };
      }
      if (od) {
        onDemand = {
          enabled: typeof od.enabled === 'boolean' ? od.enabled : null,
          used: typeof od.used === 'number' ? od.used : null,
          limit: typeof od.limit === 'number' ? od.limit : null,
          remaining: typeof od.remaining === 'number' ? od.remaining : null,
        };
      }
      // Build spending from plan + onDemand
      const planUsed = typeof (indiv.plan as any)?.used === 'number' ? (indiv.plan as any).used : 0;
      const odUsed = typeof (indiv.onDemand as any)?.used === 'number' ? (indiv.onDemand as any).used : 0;
      spending = {
        totalCents: planUsed + odUsed,
        includedCents: planUsed,
        onDemandCents: odUsed,
        budgetLimitCents: typeof (indiv.onDemand as any)?.limit === 'number' ? (indiv.onDemand as any).limit : null,
        onDemandEnabled: typeof (indiv.onDemand as any)?.enabled === 'boolean' ? (indiv.onDemand as any).enabled : null,
      };
    }
    if (typeof summary.isUnlimited === 'boolean') isUnlimited = summary.isUnlimited;
  }

  const partial: CursorUsagePayload = { stripe, legacyUsage, currentPeriod, spending, onDemand, billingModel: 'unknown', isUnlimited };
  partial.billingModel = detectCursorBillingModel(partial);
  return partial;
}

function parseCursorStripe(input: unknown): CursorStripeInfo | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  return {
    membershipType: typeof r.membershipType === 'string' ? r.membershipType : (typeof r.individualMembershipType === 'string' ? r.individualMembershipType : null),
    individualMembershipType: typeof r.individualMembershipType === 'string' ? r.individualMembershipType : null,
    subscriptionStatus: typeof r.subscriptionStatus === 'string' ? r.subscriptionStatus : null,
    isTeamMember: typeof r.isTeamMember === 'boolean' ? r.isTeamMember : null,
    isYearlyPlan: typeof r.isYearlyPlan === 'boolean' ? r.isYearlyPlan : null,
    isOnBillableAuto: typeof r.isOnBillableAuto === 'boolean' ? r.isOnBillableAuto : null,
    customerBalance: typeof r.customerBalance === 'number' ? r.customerBalance : null,
    pendingCancellationDate: typeof r.pendingCancellationDate === 'string' ? r.pendingCancellationDate : null,
    lastPaymentFailed: typeof r.lastPaymentFailed === 'boolean' ? r.lastPaymentFailed : null,
    trialEligible: typeof r.trialEligible === 'boolean' ? r.trialEligible : null,
  };
}

function parseCursorLegacyUsage(input: unknown): CursorUsagePayload['legacyUsage'] {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const gpt4 = r['gpt-4'] as Record<string, unknown> | undefined;
  return {
    'gpt-4': gpt4 ? {
      numRequests: typeof gpt4.numRequests === 'number' ? gpt4.numRequests : null,
      maxRequestUsage: typeof gpt4.maxRequestUsage === 'number' ? gpt4.maxRequestUsage : null,
    } : null,
    startOfMonth: typeof r.startOfMonth === 'string' ? r.startOfMonth : null,
  };
}

function parseCursorCurrentPeriod(input: unknown): CursorUsagePayload['currentPeriod'] {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const pu = r.planUsage as Record<string, unknown> | undefined;
  const breakdown = pu?.breakdown as Record<string, unknown> | undefined;
  return {
    billingCycleStart: typeof r.billingCycleStart === 'string' ? r.billingCycleStart : null,
    billingCycleEnd: typeof r.billingCycleEnd === 'string' ? r.billingCycleEnd : null,
    planUsage: pu ? {
      enabled: typeof pu.enabled === 'boolean' ? pu.enabled : null,
      limit: typeof pu.limit === 'number' ? pu.limit : null,
      remaining: typeof pu.remaining === 'number' ? pu.remaining : null,
      used: typeof pu.used === 'number' ? pu.used : null,
      totalPercentUsed: typeof pu.totalPercentUsed === 'number' ? pu.totalPercentUsed : null,
      autoPercentUsed: typeof pu.autoPercentUsed === 'number' ? pu.autoPercentUsed : null,
      apiPercentUsed: typeof pu.apiPercentUsed === 'number' ? pu.apiPercentUsed : null,
      breakdown: breakdown ? {
        included: typeof breakdown.included === 'number' ? breakdown.included : null,
        bonus: typeof breakdown.bonus === 'number' ? breakdown.bonus : null,
        total: typeof breakdown.total === 'number' ? breakdown.total : null,
      } : null,
    } : null,
  };
}

export function cursorTotalSpendDollars(data?: CursorUsagePayload | null): number | null {
  if (!data?.spending) return null;
  if (typeof data.spending.totalCents === 'number') return data.spending.totalCents / 100;
  return null;
}

export function cursorOnDemandSpendDollars(data?: CursorUsagePayload | null): number | null {
  if (!data?.spending) return null;
  if (typeof data.spending.onDemandCents === 'number') return data.spending.onDemandCents / 100;
  return null;
}

export function cursorIncludedSpendDollars(data?: CursorUsagePayload | null): number | null {
  if (!data?.spending) return null;
  if (typeof data.spending.includedCents === 'number') return data.spending.includedCents / 100;
  return null;
}

export function apiShapeSummary(data?: ClaudeUsagePayload | KimiUsagePayload | CodexUsagePayload | CursorUsagePayload) {
  if (!data) return [];
  return Object.keys(data).sort();
}
