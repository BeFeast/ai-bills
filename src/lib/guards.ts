import { loadConfig } from './config';
import { consistencyChecks, CHECK_INTERVAL_MS, type AccountCheck } from './quota-consistency';
import { readSnapshot, type Scope } from './storage';
import { CLAUDE_LAST_KNOWN_MS } from './usage-evidence';
import { getUsageResponse } from './usage-service';
import { isPendingObservation, type ProviderUsage } from './usage';

/**
 * Three guards against a quota display that silently stops telling the truth. Each one is a plain up/down with a
 * message, so an external push monitor can relay it and deduplicate transitions:
 * - stale: an account had no usable quota observation from any source for longer than one Claude session window;
 * - consistency: the proxy and the website disagreed on consecutive cross-checks (see quota-consistency);
 * - probe: the collector's hourly synthetic call found a catalogued model that cannot be called.
 */
export type GuardStatus = 'up' | 'down';
export type Guard = { status: GuardStatus; message: string; lastRunAt: string | null };
export type ProbeModel = { model: string; outcome: string; http_status: number | null; retried?: boolean; message?: string };
export type GuardsReport = {
  generatedAt: string;
  guards: { stale: Guard; consistency: Guard; probe: Guard };
  stale: { accountKey: string; label: string; lastObservedAt: string | null }[];
  checks: AccountCheck[];
  probe: { checkedAt: string | null; status: string | null; message: string | null; models: ProbeModel[] };
};

/** The probe runs hourly; two missed runs mean it stopped. */
const PROBE_MAX_AGE_MS = 2 * 3600_000;
/** A check older than three intervals means the checker stopped running for the account. */
const CHECK_MAX_AGE_MS = 3 * CHECK_INTERVAL_MS;

const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const time = (value: string | null | undefined) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };
const clock = (value: string | null) => value ? new Date(value).toISOString().slice(11, 16) + ' UTC' : 'never';

function staleGuard(accounts: ProviderUsage[], now: number): { guard: Guard; stale: GuardsReport['stale'] } {
  const claude = accounts.filter((result) => result.account.provider === 'claude' && !isPendingObservation(result));
  const stale = claude.filter((result) => {
    const observed = time(result.fetchedAt);
    return !result.ok || observed === null || now - observed > CLAUDE_LAST_KNOWN_MS;
  }).map((result) => ({ accountKey: result.account.key, label: result.account.label, lastObservedAt: result.ok ? result.fetchedAt || null : null }));
  const message = stale.length
    ? `No usable quota for more than 5 h: ${stale.map((entry) => `${entry.accountKey} (last ${clock(entry.lastObservedAt)})`).join(', ')}`
    : claude.length ? `All ${claude.length} Claude account${claude.length === 1 ? '' : 's'} observed within 5 h` : 'No Claude account configured';
  return { guard: { status: stale.length ? 'down' : 'up', message, lastRunAt: new Date(now).toISOString() }, stale };
}

function consistencyGuard(checks: AccountCheck[], now: number): Guard {
  const lastRunAt = checks.map((check) => check.checkedAt).sort().pop() ?? null;
  if (!checks.length) return { status: 'up', message: 'No account has a second quota source to cross-check', lastRunAt };
  const flagged = checks.filter((check) => check.flagged);
  if (flagged.length) return { status: 'down', message: `Quota sources disagree: ${flagged.map((check) => `${check.accountKey}: ${check.reason}`).join('; ')}`, lastRunAt };
  const silent = checks.filter((check) => now - (time(check.checkedAt) ?? 0) > CHECK_MAX_AGE_MS);
  if (silent.length) return { status: 'down', message: `Cross-check stopped running for ${silent.map((check) => check.accountKey).join(', ')} (last ${clock(silent[0].checkedAt)})`, lastRunAt };
  return { status: 'up', message: checks.map((check) => `${check.accountKey}: ${check.verdict}${check.streak ? ` (${check.streak}×)` : ''}`).join('; '), lastRunAt };
}

function probeGuard(snapshot: unknown, now: number): { guard: Guard; probe: GuardsReport['probe'] } {
  const raw = row(row(snapshot).model_probe);
  const checkedAt = text(raw.checked_at);
  const models = Array.isArray(raw.models) ? raw.models.map(row).filter((model) => text(model.model)).map((model) => ({
    model: text(model.model)!, outcome: text(model.outcome) ?? 'unknown', http_status: typeof model.http_status === 'number' ? model.http_status : null,
    retried: model.retried === true, message: text(model.message)?.slice(0, 200) ?? undefined })) : [];
  const probe = { checkedAt, status: text(raw.status), message: text(raw.message), models };
  const checked = time(checkedAt);
  if (checked === null) return { probe, guard: { status: 'down', message: 'No model probe result in the latest snapshot', lastRunAt: null } };
  if (now - checked > PROBE_MAX_AGE_MS) return { probe, guard: { status: 'down', message: `Model probe stopped: last run ${clock(checkedAt)}`, lastRunAt: checkedAt } };
  if (probe.status !== 'up') {
    const failing = models.filter((model) => !['ok', 'rate_limited'].includes(model.outcome));
    return { probe, guard: { status: 'down', message: failing.length ? `Models failing: ${failing.map((model) => `${model.model} ${model.outcome}${model.http_status ? ` (HTTP ${model.http_status})` : ''}`).join(', ')}` : probe.message ?? 'Model probe failed', lastRunAt: checkedAt } };
  }
  return { probe, guard: { status: 'up', message: `${models.length} model${models.length === 1 ? '' : 's'} callable (${models.filter((model) => model.outcome === 'rate_limited').length} rate-limited)`, lastRunAt: checkedAt } };
}

export function buildGuardsReport({ accounts, checks, snapshot, now }: { accounts: ProviderUsage[]; checks: AccountCheck[]; snapshot: unknown; now: number }): GuardsReport {
  const { guard: stale, stale: staleAccounts } = staleGuard(accounts, now);
  const { guard: probe, probe: probeReport } = probeGuard(snapshot, now);
  return { generatedAt: new Date(now).toISOString(), guards: { stale, consistency: consistencyGuard(checks, now), probe }, stale: staleAccounts, checks, probe: probeReport };
}

export async function guardsReport(scope: Scope, now = Date.now()): Promise<GuardsReport> {
  const config = loadConfig();
  const [usage, snapshot] = await Promise.all([getUsageResponse(false, scope), readSnapshot(config, scope)]);
  return buildGuardsReport({ accounts: usage.accounts, checks: consistencyChecks(scope?.id ?? null), snapshot: snapshot.body, now });
}
