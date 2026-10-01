import { openRouterFunds } from './openrouter';
import { loadConfig, tenantAccounts, type AccountConfig } from './config';
import { peekUsageObservations } from './usage-observations';
import { CLAUDE_LAST_KNOWN_MS } from './usage-evidence';

type SnapshotQuota = { ok?: boolean; fetched_at?: string; source?: string };
/** `source` is set when the numbers are not the provider's direct answer (collector fallback or the website). */
type Observation = { observedAt: string; ok: boolean; source?: string };

/**
 * Claude and Codex quotas are observed by the collector, not by this process. The snapshot's own
 * observation time is therefore the source's freshness, whether or not anything in this process
 * has read it since: an instance nobody is looking at is not an instance without observations.
 */
function snapshotObservation(snapshot: unknown, account: AccountConfig): Observation | null {
  const bucket = account.provider === 'claude' ? 'claude_usage' : account.provider === 'codex' ? 'codex_usage' : null;
  if (!bucket || !snapshot || typeof snapshot !== 'object') return null;
  const rows = (snapshot as Record<string, unknown>)[bucket];
  if (!rows || typeof rows !== 'object') return null;
  const key = account.quota_snapshot_key || account.email;
  const entry = key ? (rows as Record<string, SnapshotQuota>)[key] : undefined;
  if (!entry || typeof entry.fetched_at !== 'string' || !Number.isFinite(Date.parse(entry.fetched_at))) return null;
  return { observedAt: entry.fetched_at, ok: entry.ok === true, ...(entry.source && entry.source !== 'direct' ? { source: entry.source } : {}) };
}

/** The later of two observations describes the provider now; neither is invented when both are absent. */
function newer(a: Observation | null, b: Observation | null): Observation | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.observedAt) >= Date.parse(a.observedAt) ? b : a;
}

/** No network, refresh, browser acquisition or private source payloads. */
export function sourceHealth(now = Date.now(), snapshot: unknown = {}) {
  const config = loadConfig();
  const observations = peekUsageObservations();
  const sources = tenantAccounts(config, snapshot).map(account => {
    const observation = observations.find(row => row.account.key === account.key);
    const inProcess: Observation | null = observation?.fetchedAt ? { observedAt: observation.fetchedAt, ok: observation.ok,
      ...(observation.source && observation.source !== 'direct' ? { source: observation.source } : {}) } : null;
    const chosen = newer(inProcess, snapshotObservation(snapshot, account));
    const observedAt = chosen?.observedAt ?? null;
    const time = Date.parse(observedAt || '');
    const current = Number.isFinite(time) && time <= now + 60_000 && now - time <= 600_000;
    // Claude keeps its last good numbers on screen for 5 h (a 429 is not an outage); health says so instead of degrading.
    const lastKnown = account.provider === 'claude' && chosen?.ok === true && Number.isFinite(time) && time <= now + 60_000 && now - time <= CLAUDE_LAST_KNOWN_MS;
    const status = !observedAt ? 'missing' : current && chosen!.ok && !chosen!.source ? 'fresh' : lastKnown ? 'fallback' : !current ? 'stale' : chosen!.ok ? 'fresh' : 'error';
    const browser = ['kimi', 'cursor'].includes(account.provider);
    // The browser path describes this process's own session, never a collector observation.
    const browserCurrent = Boolean(inProcess) && current;
    return { id: account.key, provider: account.provider as string, expected: true, status, observedAt, maxAgeSeconds: status === 'fallback' ? CLAUDE_LAST_KNOWN_MS / 1000 : 600,
      ...(status === 'fallback' ? { fallback: { source: chosen?.source ?? 'last_known' } } : {}),
      ...(browser ? { cdp_path: { mode: !inProcess ? 'idle' : browserCurrent ? 'observed' : 'stale', observedAt,
        ok: observation ? observation.ok : null, live: false } } : {}) };
  });
  if (config.accounting?.openrouter_account_id) {
    const funds = openRouterFunds(snapshot, now);
    for (const receipt of [funds.accountBalance.freshness, funds.keyUsage.freshness]) sources.push({
      id: receipt.id, provider: 'openrouter', expected: true, status: receipt.status,
      observedAt: receipt.observedAt, maxAgeSeconds: receipt.maxAgeSeconds,
    });
  }
  return { ok: true, service: 'ai-bills', generatedAt: new Date(now).toISOString(),
    collection: sources.every(row => row.status === 'fresh' || row.status === 'fallback') ? 'fresh' : 'degraded', sources };
}
