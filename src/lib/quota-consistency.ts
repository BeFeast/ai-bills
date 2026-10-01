import { claudeWindows, type ClaudeUsagePayload, type ProviderUsage } from './usage';

/**
 * Cross-checks two independent quota observations of one account and remembers the verdicts per
 * tenant and account. The framework is provider-agnostic: a provider contributes a `QuotaReading`
 * projection of its payload; only Claude has a second source today.
 *
 * One differing run is not a finding (the two sources are read minutes apart and a session window
 * moves quickly), so an account is flagged only after FLAG_AFTER consecutive mismatching runs.
 */
export const CHECK_INTERVAL_MS = 30 * 60_000;
export const DELTA_LIMIT_PP = 10;
export const FLAG_AFTER = 2;
/** Numbers are compared only when the proxy observation is this close to the website read: a busy session window
 * moves several points in half an hour, which would read as disagreement. The collector runs every 5 minutes. */
const PROXY_MAX_AGE_MS = 10 * 60_000;

export type QuotaState = 'sign_in' | 'available' | 'exhausted' | 'unknown';
/** Used percent per window label, plus the account state the windows imply. */
export type QuotaReading = { state: QuotaState; used: Record<string, number> };
export type CheckVerdict = 'consistent' | 'mismatch' | 'insufficient';
export type CheckResult = { verdict: CheckVerdict; reason: string; proxy: QuotaReading; second: QuotaReading; maxDeltaPp: number | null };
export type AccountCheck = CheckResult & { accountKey: string; provider: string; checkedAt: string; streak: number; flagged: boolean };

/** Session, weekly and every per-model weekly window of a Claude payload. Exhausted means an account-wide window is
 * used up; a used-up per-model allowance (Fable) is normal and compared only by its percentage. */
export function claudeReading(data: ClaudeUsagePayload | undefined): QuotaReading {
  const used: Record<string, number> = {};
  for (const window of claudeWindows(data)) used[window.label] = window.usedPercent;
  if (!Object.keys(used).length) return { state: 'unknown', used };
  const accountWide = claudeWindows(data).filter((window) => window.kind !== 'weekly_scoped');
  return { state: accountWide.some((window) => window.usedPercent >= 100) ? 'exhausted' : 'available', used };
}

/** What the proxy knows about the account: its credential state first, then a recent direct or header observation. */
export function proxyClaudeReading(proxy: ProviderUsage, now: number): QuotaReading {
  if (proxy.proxyAuth?.state === 'expired') return { state: 'sign_in', used: {} };
  const observed = Date.parse(proxy.fetchedAt);
  const derived = proxy.source === undefined || proxy.source === 'direct' || proxy.source === 'proxy_headers';
  if (!proxy.ok || !derived || !Number.isFinite(observed) || now - observed > PROXY_MAX_AGE_MS) return { state: 'unknown', used: {} };
  return claudeReading(proxy.data as ClaudeUsagePayload | undefined);
}

/** The website's own answer: signed out (401/403), or its windows. */
export function webClaudeReading(web: ProviderUsage): QuotaReading {
  if (!web.ok) return { state: web.status === 401 || web.status === 403 ? 'sign_in' : 'unknown', used: {} };
  return claudeReading(web.data as ClaudeUsagePayload | undefined);
}

export function compareReadings(proxy: QuotaReading, second: QuotaReading): CheckResult {
  if (proxy.state === 'unknown' || second.state === 'unknown') {
    return { verdict: 'insufficient', reason: `${proxy.state === 'unknown' ? 'proxy' : 'second source'} has no current observation`, proxy, second, maxDeltaPp: null };
  }
  if (proxy.state !== second.state) return { verdict: 'mismatch', reason: `proxy says ${proxy.state}, website says ${second.state}`, proxy, second, maxDeltaPp: null };
  const deltas = Object.keys(proxy.used).filter((label) => label in second.used).map((label) => ({ label, delta: Math.abs(proxy.used[label] - second.used[label]) }));
  const worst = deltas.sort((a, b) => b.delta - a.delta)[0];
  const maxDeltaPp = worst ? Math.round(worst.delta * 10) / 10 : null;
  if (worst && worst.delta > DELTA_LIMIT_PP) return { verdict: 'mismatch', reason: `${worst.label} differs by ${maxDeltaPp} pp`, proxy, second, maxDeltaPp };
  return { verdict: 'consistent', reason: worst ? `largest difference ${maxDeltaPp} pp (${worst.label})` : 'states agree', proxy, second, maxDeltaPp };
}

const checks = new Map<string, AccountCheck>();
const slot = (scope: string | null, accountKey: string) => `${scope ?? ''}\u0000${accountKey}`;

/** Whether the account is due for its next cross-check. */
export function checkDue(scope: string | null, accountKey: string, now = Date.now()): boolean {
  const last = checks.get(slot(scope, accountKey));
  return !last || now - Date.parse(last.checkedAt) >= CHECK_INTERVAL_MS;
}

/** Records one run. A mismatch extends the streak, agreement ends it; an insufficient run is no evidence either way and
 * leaves the streak as it was (a long proxy back-off must not hide a disagreement on either side of it). */
export function recordCheck(scope: string | null, accountKey: string, provider: string, result: CheckResult, now = Date.now()): AccountCheck {
  const previous = checks.get(slot(scope, accountKey));
  const streak = result.verdict === 'mismatch' ? (previous?.streak ?? 0) + 1 : result.verdict === 'insufficient' ? previous?.streak ?? 0 : 0;
  const check: AccountCheck = { ...result, accountKey, provider, checkedAt: new Date(now).toISOString(), streak,
    flagged: streak >= FLAG_AFTER && (result.verdict === 'mismatch' || previous?.flagged === true) };
  checks.set(slot(scope, accountKey), check);
  return check;
}

export function consistencyChecks(scope: string | null): AccountCheck[] {
  const prefix = `${scope ?? ''}\u0000`;
  return [...checks.entries()].filter(([key]) => key.startsWith(prefix)).map(([, check]) => check).sort((a, b) => a.accountKey.localeCompare(b.accountKey));
}

/** Test hook. */
export function resetConsistencyChecksForTests(): void { checks.clear(); }
