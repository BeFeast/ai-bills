import type { RegistryAccount } from './accounts';
import type { OverviewRecentUsage, OverviewUpstreamActivity } from './overview';
import { claudeWindows, isPendingObservation, codexPrimaryWindow, codexWindowDurationLabel, codexWindowResetIso, cursorCycleEnd, cursorUsagePercent, kimiCodingUsage, kimiUsagePercent, quotaTone,
  type ClaudeUsagePayload, type CodexRateWindow, type CodexUsagePayload, type CursorUsagePayload, type KimiQuotaDetail, type KimiUsagePayload, type ProviderUsage, type QuotaTone, type UsageFallbackSource } from './usage';
import { usageEvidence, type UsageEvidence } from './usage-evidence';

/** One limit window of an account as the hero shows it. `remaining` is in `unit`; `remainingPercent` drives tone and order. */
export type HeroWindow = { label: string; remaining: number | null; remainingPercent: number | null; unit: 'percent' | 'requests'; resetsAt: string | null; limiting: boolean; exhausted: boolean; tone: QuotaTone;
  /** Present only when this window was carried over from an earlier observation than the account's (Claude per-model allowance during a header fallback). */
  observedAt?: string };
/** Proxy request outcomes for the account in the rolling window. `failed` excludes rate-limited requests. */
export type HeroActivity = { requests: number; ok: number; failed: number; rateLimited: number; lastRequestAt: string | null };
export type HeroIdentity = { key: string; provider: string; label: string; email: string };
/** The direct quota request failed; `windows` come from the proxy's header-observed quota or the last successful observation. */
export type HeroFallback = { kind: UsageFallbackSource; status: number | null; error: string };
export type LimitsHeroCard =
  | { kind: 'quota'; id: string; account: HeroIdentity; windows: HeroWindow[]; limiting: HeroWindow; tone: QuotaTone; activity: HeroActivity | null; observedAt: string; fallback: HeroFallback | null }
  | { kind: 'error'; id: string; account: HeroIdentity; state: Exclude<UsageEvidence['state'], 'fresh'>; message: string; status: number | null; activity: HeroActivity | null; observedAt: string;
      /** A stale observation still had windows: the last known limiting one stays visible, labelled as such. */
      lastKnown: HeroWindow | null }
  | { kind: 'outcomes'; id: string; provider: string; label: string; email: string | null; websiteUrl: string | null; balanceUsd: number | null; credentialStatus: string | null; activity: HeroActivity; tone: QuotaTone };
export type LimitsHero = { refreshedAt: string | null; windowHours: number; recencyKnown: boolean; loading: boolean; pending: number; cards: LimitsHeroCard[] };

export const LOW_REMAINING_PERCENT = 25;
/** Providers the app observes through a quota source; their registry rows are never reduced to request outcomes. */
const QUOTA_PROVIDERS = new Set(['claude', 'codex', 'kimi', 'cursor']);
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Ledger providers for upstream keys are logged as `openai-compatible-<name>`; the registry knows them by `<name>`. */
const upstreamProvider = (value: string) => normalize(value.replace(/^openai-compatible-/i, ''));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

function window(label: string, usedPercent: number | null, resetsAt: string | null, exhausted = false, observedAt?: string): HeroWindow | null {
  if (usedPercent === null) return null;
  const remaining = clampPercent(100 - usedPercent);
  return { label, remaining, remainingPercent: remaining, unit: 'percent', resetsAt, limiting: false, exhausted: exhausted || remaining === 0, tone: quotaTone(remaining, exhausted || remaining === 0), ...(observedAt ? { observedAt } : {}) };
}
function requestWindow(label: string, detail: KimiQuotaDetail | null | undefined): HeroWindow | null {
  if (!finite(detail?.remaining)) return null;
  const used = kimiUsagePercent(detail);
  const remainingPercent = used === null ? null : clampPercent(100 - used);
  const exhausted = detail.remaining <= 0;
  return { label, remaining: detail.remaining, remainingPercent, unit: 'requests', resetsAt: detail.resetTime || null, limiting: false, exhausted, tone: quotaTone(remainingPercent, exhausted) };
}
const kimiUnit: Record<string, string> = { TIME_UNIT_MINUTE: 'minute', TIME_UNIT_HOUR: 'hour', TIME_UNIT_DAY: 'day' };
function codexLabel(rateWindow: CodexRateWindow | null, fallback: string) {
  return rateWindow ? codexWindowDurationLabel(rateWindow).replace(/ usage$/, '') : fallback;
}

/** All windows of an account plus which one limits it: Claude's `is_active` flag, otherwise the least remaining. */
export function accountWindows(result: ProviderUsage): { windows: HeroWindow[]; limiting: HeroWindow | null } {
  const windows: HeroWindow[] = []; const active: HeroWindow[] = [];
  const provider = result.account.provider;
  if (provider === 'claude') {
    for (const item of claudeWindows(result.data as ClaudeUsagePayload | undefined)) {
      const entry = window(item.label, item.usedPercent, item.resetsAt, item.exhausted, item.observedAt);
      if (!entry) continue;
      windows.push(entry); if (item.isActive) active.push(entry);
    }
  } else if (provider === 'codex') {
    const data = result.data as CodexUsagePayload | undefined;
    const blocked = data?.rate_limit?.limit_reached === true || data?.rate_limit?.allowed === false;
    const primary = codexPrimaryWindow(data); const secondary = data?.rate_limit?.secondary_window ?? null;
    for (const [rateWindow, fallback] of [[primary, 'Usage window'], [secondary, 'Secondary window']] as const) {
      if (!rateWindow || !finite(rateWindow.used_percent)) continue;
      const entry = window(codexLabel(rateWindow, fallback), rateWindow.used_percent, codexWindowResetIso(rateWindow), blocked);
      if (entry) windows.push(entry);
    }
  } else if (provider === 'cursor') {
    const data = result.data as CursorUsagePayload | undefined;
    const entry = window(data?.billingModel === 'request_count' ? 'Monthly requests' : 'Monthly credits', cursorUsagePercent(data), cursorCycleEnd(data));
    if (entry) windows.push(entry);
  } else if (provider === 'kimi') {
    const coding = kimiCodingUsage(result.data as KimiUsagePayload | undefined);
    const overall = requestWindow('Coding quota', coding?.detail);
    if (overall) windows.push(overall);
    for (const limit of coding?.limits ?? []) {
      const entry = requestWindow(`${limit.duration ?? '?'}-${kimiUnit[limit.timeUnit ?? ''] ?? 'unit'} window`, limit.detail);
      if (entry) windows.push(entry);
    }
  }
  const least = (list: HeroWindow[]) => list.reduce<HeroWindow | null>((best, item) => {
    if (item.remainingPercent === null) return best;
    return best === null || (best.remainingPercent ?? 101) > item.remainingPercent ? item : best;
  }, null);
  const limiting = least(active) ?? least(windows) ?? windows[0] ?? null;
  if (limiting) limiting.limiting = true;
  return { windows, limiting };
}

function sumActivity(rows: OverviewUpstreamActivity[]): HeroActivity | null {
  if (!rows.length) return null;
  const requests = rows.reduce((total, row) => total + row.requests, 0);
  const failedAll = rows.reduce((total, row) => total + (row.failed ?? 0), 0);
  const rateLimited = rows.reduce((total, row) => total + (row.rateLimited ?? 0), 0);
  const lastRequestAt = rows.map((row) => row.lastRequestAt ?? null).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
  return { requests, ok: Math.max(0, requests - failedAll), failed: Math.max(0, failedAll - rateLimited), rateLimited, lastRequestAt };
}

/** Claude and Codex rows carry the account email; upstream-key providers (Kimi via key, OpenRouter, Ollama) only match by provider. */
function usageActivity(result: ProviderUsage, upstreams: OverviewUpstreamActivity[], providerAccounts: number): HeroActivity | null {
  const provider = normalize(result.account.provider);
  const rows = upstreams.filter((row) => upstreamProvider(row.provider) === provider);
  const exact = rows.filter((row) => row.name === result.account.email);
  // Rows logged under a key (no email) can only belong to the provider's single configured account; another email never does.
  const keyed = rows.filter((row) => !row.name.includes('@'));
  return sumActivity(exact.length ? exact : providerAccounts === 1 ? keyed : []);
}

function identity(result: ProviderUsage): HeroIdentity {
  return { key: result.account.key, provider: result.account.provider, label: result.account.label, email: result.account.email };
}

export function buildLimitsHero({ usage, registry, last24h, now }: { usage: ProviderUsage[]; registry: RegistryAccount[]; last24h?: OverviewRecentUsage; now: number }): LimitsHero {
  const upstreams = last24h?.byUpstream ?? [];
  const recencyKnown = Boolean(last24h);
  const quota: Extract<LimitsHeroCard, { kind: 'quota' }>[] = []; const errors: Extract<LimitsHeroCard, { kind: 'error' }>[] = []; const outcomes: Extract<LimitsHeroCard, { kind: 'outcomes' }>[] = [];
  const providerCounts = new Map<string, number>();
  for (const result of usage) providerCounts.set(result.account.provider, (providerCounts.get(result.account.provider) ?? 0) + 1);
  const observed = usage.filter((result) => !isPendingObservation(result));
  for (const result of observed) {
    const activity = usageActivity(result, upstreams, providerCounts.get(result.account.provider) ?? 0);
    const used = !recencyKnown || (activity?.requests ?? 0) > 0;
    const evidence = usageEvidence(result, now);
    if (evidence.state !== 'fresh') {
      // A failing quota source cannot rule out a low remaining allowance, so it stays visible; stale or empty data only matters for accounts in use.
      if (evidence.state === 'error' || used) errors.push({ kind: 'error', id: result.account.key, account: identity(result), state: evidence.state, message: evidence.message, status: result.status ?? null, activity, observedAt: result.fetchedAt,
        lastKnown: evidence.state === 'stale' ? accountWindows(result).limiting : null });
      continue;
    }
    const { windows, limiting } = accountWindows(result);
    if (!limiting) continue;
    const low = limiting.remainingPercent !== null && limiting.remainingPercent < LOW_REMAINING_PERCENT;
    if (!used && !low && !limiting.exhausted) continue;
    const fallback: HeroFallback | null = result.source === 'proxy_headers' || result.source === 'retained'
      ? { kind: result.source, status: result.direct?.status ?? null, error: result.direct?.error ?? 'The direct quota request failed' } : null;
    quota.push({ kind: 'quota', id: result.account.key, account: identity(result), windows, limiting, tone: limiting.tone, activity, observedAt: result.fetchedAt, fallback });
  }
  const covered = new Set([...QUOTA_PROVIDERS, ...usage.map((result) => normalize(result.account.provider))]);
  for (const row of registry) {
    const provider = normalize(row.provider);
    if (covered.has(provider) || (!row.proxyCredential && !row.funds)) continue;
    const rows = upstreams.filter((entry) => upstreamProvider(entry.provider) === provider && (!row.proxyCredential?.email || entry.name === row.proxyCredential.email));
    const activity = sumActivity(rows);
    if (!activity || !activity.requests) continue;
    outcomes.push({ kind: 'outcomes', id: row.id, provider: row.provider, label: row.label, email: row.proxyCredential?.email ?? null, websiteUrl: row.websiteUrl ?? null,
      balanceUsd: row.funds?.accountBalance.usd ?? null, credentialStatus: row.proxyCredential?.status ?? null, activity, tone: activity.rateLimited > 0 ? 'warn' : undefined });
  }
  const requests = (card: { activity: HeroActivity | null }) => card.activity?.requests ?? 0;
  quota.sort((a, b) => (a.limiting.remainingPercent ?? 101) - (b.limiting.remainingPercent ?? 101) || requests(b) - requests(a) || a.account.label.localeCompare(b.account.label));
  errors.sort((a, b) => requests(b) - requests(a) || a.account.label.localeCompare(b.account.label));
  outcomes.sort((a, b) => b.activity.rateLimited - a.activity.rateLimited || b.activity.requests - a.activity.requests || a.label.localeCompare(b.label));
  const latestObservation = usage.map((result) => result.fetchedAt).filter((value) => Number.isFinite(Date.parse(value))).sort().pop() ?? null;
  return { refreshedAt: last24h?.observedAt ?? latestObservation, windowHours: last24h?.windowHours ?? 24, recencyKnown, loading: usage.length === 0, pending: usage.length - observed.length, cards: [...quota, ...errors, ...outcomes] };
}
