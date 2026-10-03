import { loadConfig, tenantAccounts, type AppConfig } from './config';
import { quotaEntry } from './snapshot-keys';
import { consistencyChecks, CHECK_INTERVAL_MS, type AccountCheck } from './quota-consistency';
import { readSnapshot, type Scope } from './storage';
import { CLAUDE_LAST_KNOWN_MS, usageEvidence } from './usage-evidence';
import { getUsageResponse } from './usage-service';
import { isPendingObservation, type CodexUsagePayload, type ProviderUsage } from './usage';
import { accountWindows } from './limits-hero';
import { codexUsedUp, compactCredits, spendingCredits } from './codex-credits';

/**
 * Five guards against a quota display that silently stops telling the truth, or money spent that need not be. Each one
 * is a plain up/down with a message, so an external push monitor can relay it and deduplicate transitions:
 * - stale: an account had no usable quota observation from any source for longer than one Claude session window;
 * - consistency: the proxy and the website disagreed on consecutive cross-checks (see quota-consistency);
 * - probe: the collector's hourly synthetic call found a catalogued model that cannot be called;
 * - mapping: a configured link to a collector observation (quota_snapshot_key, a browser's proxy_account_id, a quota
 *   binding's members) names something the snapshot no longer has, e.g. after the proxy renamed a credential file.
 *   The card may still look right through the e-mail fallback; the configuration has drifted all the same.
 * - credits: a Codex account pays from its credit balance (window used up, balance falling) while another Codex account
 *   still has room. Codex answers instead of refusing, so the proxy never fails over on its own. Spending when every
 *   account is out is the expected fallback: the card says so and the guard stays up.
 */
export type GuardStatus = 'up' | 'down';
export type Guard = { status: GuardStatus; message: string; lastRunAt: string | null };
export type ProbeModel = { model: string; outcome: string; http_status: number | null; retried?: boolean; message?: string };
export type GuardsReport = {
  generatedAt: string;
  guards: { stale: Guard; consistency: Guard; probe: Guard; mapping: Guard; credits: Guard };
  /** Codex accounts paying from credits right now, with the burn rate when earlier balances were stored. */
  credits: { accountKey: string; balance: number | null; perHour: number | null; manualResets: number }[];
  mapping: { subject: string; problem: string }[];
  /** Mapping checks that could not run because the snapshot did not carry their evidence (an outage, not drift). */
  mappingSkipped: string[];
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
  // `partial`: the run ran out of time before every model; what it did check passed, and the next collect continues.
  if (probe.status !== 'up' && probe.status !== 'partial') {
    const failing = models.filter((model) => !['ok', 'rate_limited', 'retired', 'skipped'].includes(model.outcome));
    return { probe, guard: { status: 'down', message: failing.length ? `Models failing: ${failing.map((model) => `${model.model} ${model.outcome}${model.http_status ? ` (HTTP ${model.http_status})` : ''}`).join(', ')}` : probe.message ?? 'Model probe failed', lastRunAt: checkedAt } };
  }
  if (probe.status === 'partial') return { probe, guard: { status: 'up', message: probe.message ?? 'Model probe ran out of time; checked models are callable', lastRunAt: checkedAt } };
  const retired = models.filter((model) => model.outcome === 'retired').length;
  const callable = models.length - retired;
  return { probe, guard: { status: 'up', message: `${callable} model${callable === 1 ? '' : 's'} callable (${models.filter((model) => model.outcome === 'rate_limited').length} rate-limited${retired ? `, ${retired} retired upstream` : ''})`, lastRunAt: checkedAt } };
}

const keysOf = (value: unknown) => new Set(Object.keys(row(value)));

/** Collector-observed providers: their links point at collector keys. Kimi/Cursor bindings are declared, not observed. */
const COLLECTED = new Set(['claude', 'codex']);
const COLLECTOR_ID = /^[a-f0-9]{24}$/;

/**
 * Configured links into the snapshot that point at nothing. Only what the snapshot actually carries is judged: an
 * empty quota bucket or a failed OAuth inventory is a collector outage, not drift, and is listed under `skipped` so
 * the guard never claims a link resolved when it was not checked.
 */
export function mappingCheck(config: Pick<AppConfig, 'accounts' | 'account_browsers' | 'accounting'>, snapshot: unknown): { problems: GuardsReport['mapping']; skipped: string[] } {
  const body = row(snapshot);
  const problems: GuardsReport['mapping'] = [];
  const skipped: string[] = [];
  const carried = (value: unknown) => keysOf(value).size > 0;
  const usage = { claude: body.claude_usage, codex: body.codex_usage } as Record<string, unknown>;
  const registry = row(body.account_registry);
  const inventory = Array.isArray(registry.accounts) ? registry.accounts.map(row) : [];
  // The OAuth inventory feeds the credential ids; the configured-key source is unrelated to these links.
  const sources = (Array.isArray(registry.sources) ? registry.sources : []).map(row).filter((source) => ['oauth', 'inventory'].includes(text(source.id) ?? ''));
  const inventoryComplete = inventory.length > 0 && sources.every((source) => source.status === 'fresh');
  // An alias two credentials carry identifies neither (the binding rule in accounts.ts); it is no evidence of a match.
  const aliasCount = new Map<string, number>();
  for (const entry of inventory) for (const alias of new Set((Array.isArray(entry.aliases) ? entry.aliases : []).map(text))) if (alias) aliasCount.set(alias, (aliasCount.get(alias) ?? 0) + 1);
  const registered = inventoryComplete ? new Set(inventory.flatMap((entry) => [text(entry.id), ...(Array.isArray(entry.aliases) ? entry.aliases.map(text).filter((alias) => alias && aliasCount.get(alias) === 1) : [])]).filter((id): id is string => Boolean(id))) : null;
  const accounts = tenantAccounts(config as AppConfig, snapshot);
  const provider = new Map(accounts.map((account) => [account.key, account.provider as string]));
  for (const name of ['claude', 'codex']) {
    if (accounts.some((account) => account.provider === name && account.quota_snapshot_key) && !carried(usage[name])) skipped.push(`${name} quota keys not checked: the snapshot carries no ${name} observations`);
  }
  if (!registered && (config.accounting?.account_bindings ?? []).some((binding) => COLLECTED.has(provider.get(binding.quota_account_key ?? '') ?? ''))) skipped.push('bindings not checked: the proxy inventory is missing or incomplete');
  for (const account of accounts) {
    const bucket = usage[account.provider];
    if (!account.quota_snapshot_key || !COLLECTED.has(account.provider) || !carried(bucket)) continue;
    const keys = keysOf(bucket);
    if (keys.has(account.quota_snapshot_key)) continue;
    // Say what the card does, by the card's own rule.
    const fallback = quotaEntry(bucket as Record<string, unknown>, account, accounts).viaEmailFallback;
    const meanwhile = fallback ? 'the card uses the e-mail key meanwhile' : account.provider === 'claude' && account.claude_web_quota ? 'the card shows only the website reading' : 'the card has no proxy observation';
    problems.push({ subject: account.key, problem: `quota_snapshot_key is not in the snapshot; ${meanwhile}` });
  }
  // proxy_account_id is the routing policy's account id. It is judged only where it has the shape of a collector id
  // (the deployed configs use one) and is not the id of a binding, which the binding check below covers.
  const bindingIds = new Set((config.accounting?.account_bindings ?? []).map((binding) => binding.id));
  const observed = new Set([...keysOf(usage.claude), ...keysOf(usage.codex), ...(registered ?? [])]);
  const judged = (config.account_browsers ?? []).filter((binding) => binding.proxy_account_id && COLLECTOR_ID.test(binding.proxy_account_id)
    && !bindingIds.has(binding.proxy_account_id) && COLLECTED.has(provider.get(binding.account_key) ?? ''));
  if ((carried(usage.claude) || carried(usage.codex)) && registered) {
    for (const binding of judged) {
      if (!observed.has(binding.proxy_account_id!)) problems.push({ subject: binding.account_key, problem: 'the account browser\'s proxy_account_id is not in the snapshot' });
    }
  } else if (judged.length) skipped.push('account browser proxy_account_id not checked: the proxy inventory or quota observations are missing');
  if (registered) {
    for (const binding of config.accounting?.account_bindings ?? []) {
      if (!binding.quota_account_key || !COLLECTED.has(provider.get(binding.quota_account_key) ?? '')) continue;
      if (![binding.id, ...(binding.members ?? [])].some((member) => registered.has(member))) problems.push({ subject: binding.quota_account_key, problem: `binding ${binding.label ?? binding.id} matches no credential in the proxy inventory` });
    }
  }
  return { problems, skipped };
}

export const mappingProblems = (config: Pick<AppConfig, 'accounts' | 'account_browsers' | 'accounting'>, snapshot: unknown) => mappingCheck(config, snapshot).problems;

function mappingGuard(problems: GuardsReport['mapping'], skipped: string[], now: number): Guard {
  const unchecked = skipped.length ? ` (${skipped.join('; ')})` : '';
  return { status: problems.length ? 'down' : 'up', lastRunAt: new Date(now).toISOString(),
    message: problems.length ? `Configuration no longer matches the collector: ${problems.map((entry) => `${entry.subject}: ${entry.problem}`).join('; ')}${unchecked}`
      : skipped.length ? `No drift found in what the snapshot carries${unchecked}` : 'Every configured quota link resolves in the snapshot' };
}

function creditsGuard(accounts: ProviderUsage[], now: number): { guard: Guard; credits: GuardsReport['credits'] } {
  const lastRunAt = new Date(now).toISOString();
  const all = accounts.filter((result) => result.account.provider === 'codex' && !isPendingObservation(result));
  // An old observation can neither prove spending nor prove room; say which accounts were left out rather than vouch for them.
  const codex = all.filter((result) => usageEvidence(result, now).state === 'fresh');
  const unjudged = all.filter((result) => !codex.includes(result)).map((result) => result.account.key);
  const note = unjudged.length ? ` (not judged, no fresh observation: ${unjudged.join(', ')})` : '';
  const credits = codex.filter((result) => result.creditDrain).map((result) => ({ accountKey: result.account.key, balance: result.creditDrain!.balance, perHour: result.creditDrain!.perHour, manualResets: result.creditDrain!.manualResets }));
  const spending = codex.filter((result) => spendingCredits(result.creditDrain));
  if (!spending.length) {
    // An unknown rate is not a zero one: the account may be spending while the history cannot show it yet.
    const unmeasured = credits.filter((entry) => entry.perHour === null).map((entry) => entry.accountKey);
    const idle = credits.filter((entry) => entry.perHour === 0).map((entry) => entry.accountKey);
    const parts = [unmeasured.length ? `Used up with credits on hand, spend not measured yet: ${unmeasured.join(', ')}` : '', idle.length ? `Used up with credits on hand, none spent lately: ${idle.join(', ')}` : ''].filter(Boolean);
    const message = parts.length ? parts.join('; ') : codex.length ? `No Codex account is paying from credits (${codex.length} observed)` : all.length ? 'No fresh Codex observation to judge' : 'No Codex account configured';
    return { credits, guard: { status: 'up', message: message + (codex.length ? note : ''), lastRunAt } };
  }
  // One login, possibly configured twice, is no alternative to itself. The provider's account id is the workspace; two seats in it are two logins.
  const identity = (result: ProviderUsage) => { const data = result.data as CodexUsagePayload | undefined; return [data?.account_id, data?.user_id].filter(Boolean).join(':') || result.account.email || result.account.key; };
  const room = codex.filter((result) => !codexUsedUp(result.data as CodexUsagePayload | undefined))
    .map((result) => ({ result, left: accountWindows(result).limiting?.remainingPercent ?? null }))
    .filter((entry): entry is { result: ProviderUsage; left: number } => entry.left !== null && entry.left > 0)
    .sort((a, b) => b.left - a.left);
  const spend = (result: ProviderUsage) => `${result.account.key} pays from credits (−${compactCredits(result.creditDrain!.perHour!)} credits/h)`;
  const wasted = spending.map((result) => ({ result, other: room.find((entry) => identity(entry.result) !== identity(result)) })).filter((entry) => entry.other);
  if (wasted.length) return { credits, guard: { status: 'down', lastRunAt,
    message: `Credits spent while another Codex account has room: ${wasted.map(({ result, other }) => `${spend(result)} while ${other!.result.account.key} has ${Number(other!.left.toFixed(1))} % left`).join('; ')}${note}` } };
  return { credits, guard: { status: 'up', lastRunAt, message: `${spending.map(spend).join('; ')}; no other Codex account has room${note}` } };
}

export function buildGuardsReport({ accounts, checks, snapshot, now, config }: { accounts: ProviderUsage[]; checks: AccountCheck[]; snapshot: unknown; now: number; config?: Pick<AppConfig, 'accounts' | 'account_browsers' | 'accounting'> }): GuardsReport {
  const { guard: stale, stale: staleAccounts } = staleGuard(accounts, now);
  const { guard: probe, probe: probeReport } = probeGuard(snapshot, now);
  const { problems: mapping, skipped: mappingSkipped } = config ? mappingCheck(config, snapshot) : { problems: [], skipped: [] };
  const { guard: credits, credits: creditAccounts } = creditsGuard(accounts, now);
  return { generatedAt: new Date(now).toISOString(), guards: { stale, consistency: consistencyGuard(checks, now), probe, mapping: mappingGuard(mapping, mappingSkipped, now), credits }, stale: staleAccounts, checks, probe: probeReport, mapping, mappingSkipped, credits: creditAccounts };
}

export async function guardsReport(scope: Scope, now = Date.now()): Promise<GuardsReport> {
  const config = loadConfig();
  const [usage, snapshot] = await Promise.all([getUsageResponse(false, scope), readSnapshot(config, scope)]);
  return buildGuardsReport({ accounts: usage.accounts, checks: consistencyChecks(scope?.id ?? null), snapshot: snapshot.body, now, config });
}
