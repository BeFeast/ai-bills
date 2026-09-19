import { readFileSync } from 'node:fs';
import { openRouterFunds } from './openrouter';
import { loadConfig, type AccountConfig } from './config';
import { peekUsageObservations } from './usage-observations';

type SnapshotQuota = { ok?: boolean; fetched_at?: string };
type Observation = { observedAt: string; ok: boolean };

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
  const key = (account.provider === 'codex' ? account.quota_snapshot_key : undefined) || account.email;
  const entry = key ? (rows as Record<string, SnapshotQuota>)[key] : undefined;
  if (!entry || typeof entry.fetched_at !== 'string' || !Number.isFinite(Date.parse(entry.fetched_at))) return null;
  return { observedAt: entry.fetched_at, ok: entry.ok === true };
}

/** The later of two observations describes the provider now; neither is invented when both are absent. */
function newer(a: Observation | null, b: Observation | null): Observation | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.observedAt) >= Date.parse(a.observedAt) ? b : a;
}

/** No network, refresh, browser acquisition or private source payloads. */
export function sourceHealth(now = Date.now()) {
  const config = loadConfig();
  const observations = peekUsageObservations();
  const collected = config.accounts.some(account => ['claude', 'codex'].includes(account.provider));
  let snapshot: unknown = {};
  if (collected || config.accounting?.openrouter_account_id) {
    try { snapshot = JSON.parse(readFileSync(config.billing?.snapshot_path ?? '', 'utf8')); } catch { /* Sources fall back to in-process observations. */ }
  }
  const sources = config.accounts.map(account => {
    const observation = observations.find(row => row.account.key === account.key);
    const inProcess: Observation | null = observation?.fetchedAt ? { observedAt: observation.fetchedAt, ok: observation.ok } : null;
    const chosen = newer(inProcess, snapshotObservation(snapshot, account));
    const observedAt = chosen?.observedAt ?? null;
    const time = Date.parse(observedAt || '');
    const current = Number.isFinite(time) && time <= now + 60_000 && now - time <= 600_000;
    const status = !observedAt ? 'missing' : !current ? 'stale' : chosen!.ok ? 'fresh' : 'error';
    const browser = ['kimi', 'cursor'].includes(account.provider);
    // The browser path describes this process's own session, never a collector observation.
    const browserCurrent = Boolean(inProcess) && current;
    return { id: account.key, provider: account.provider as string, expected: true, status, observedAt, maxAgeSeconds: 600,
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
    collection: sources.every(row => row.status === 'fresh') ? 'fresh' : 'degraded', sources };
}
