import { statSync } from 'node:fs';
import { fetchUsageThroughCdp } from './cdp';
import { rememberUsageObservations } from './usage-observations';
import { loadConfig } from './config';
import { publicUsageAccount } from './account-auth';
import { apiShapeSummary, combinedOverview, type ProviderUsage, PENDING_OBSERVATION } from './usage';

type UsageCache = { results: ProviderUsage[]; generatedAt: string };

let cache: UsageCache | null = null;
let refreshPromise: Promise<UsageCache> | null = null;
/** mtime of the snapshot the cached results were read from; null when nothing has been read yet. */
let cacheSnapshotMtimeMs: number | null = null;

function snapshotMtimeMs(path: string | undefined): number | null {
  if (!path) return null;
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/**
 * The collector replaces the snapshot outside this process (hosted ingest or the receiver on the
 * app host), so a cache built from an older file is out of date however recently it was built.
 * Without this an idle instance keeps serving the quota it read the last time someone looked,
 * and every card reports a stale observation while the alerts beside them are current.
 */
function snapshotReplaced(path: string | undefined): boolean {
  const current = snapshotMtimeMs(path);
  // No readable snapshot: there is nothing newer to read, so this must not force a refresh per request.
  return current !== null && current !== cacheSnapshotMtimeMs;
}

export async function refreshUsage(): Promise<UsageCache> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const config = loadConfig();
    // Read before the first observation: a snapshot that lands mid-refresh belongs to the next one.
    const snapshotMtime = snapshotMtimeMs(config.billing?.snapshot_path);
    const previous = new Map(cache?.results.map(result => [result.account.key, result]) ?? []);
    const results: ProviderUsage[] = config.accounts.map(account => previous.get(account.key) ?? ({
      account: publicUsageAccount(account, config.server.codex_proxy_management_url),
      ok: false, fetchedAt: '', sourceUrl: '', error: PENDING_OBSERVATION,
    }));
    cache = { results, generatedAt: new Date().toISOString() };
    const update = async (account: typeof config.accounts[number], index: number) => {
      results[index] = { ...await fetchUsageThroughCdp(account),
        account: publicUsageAccount(account, config.server.codex_proxy_management_url) };
      rememberUsageObservations([...results]);
    };
    const indexed = config.accounts.map((account, index) => ({ account, index }));
    const browserSources = indexed.filter(({ account }) => ['kimi', 'cursor'].includes(account.provider));
    await Promise.all([
      ...indexed.filter(({ account }) => !['kimi', 'cursor'].includes(account.provider)).map(({ account, index }) => update(account, index)),
      (async () => { for (const { account, index } of browserSources) await update(account, index); })(),
    ]);
    rememberUsageObservations(results);
    cache = { results, generatedAt: new Date().toISOString() };
    cacheSnapshotMtimeMs = snapshotMtime;
    refreshPromise = null;
    return cache;
  })().catch((error) => {
    refreshPromise = null;
    throw error;
  });
  return refreshPromise;
}

export type UsageResponseBody = {
  generatedAt: string | null;
  timezone: string;
  accounts: ProviderUsage[];
  combined: ReturnType<typeof combinedOverview>;
  apiShape: Record<string, string[]>;
  refreshing?: boolean;
};

function cacheAgeMs(entry: UsageCache | null, now = Date.now()): number {
  if (!entry?.generatedAt) return Number.POSITIVE_INFINITY;
  const then = Date.parse(entry.generatedAt);
  return Number.isFinite(then) ? Math.max(0, now - then) : Number.POSITIVE_INFINITY;
}

export async function getUsageResponse(force = false): Promise<UsageResponseBody> {
  const config = loadConfig();
  const ttlMs = Math.max(5, config.server.usage_refresh_seconds || 60) * 1000;
  // Auto-refresh used to call /api/usage without ?refresh=1, which forever returned the
  // first in-process snapshot. Honour TTL so the dashboard actually tracks live quotas.
  const stale = cacheAgeMs(cache) >= ttlMs;
  if (force || !cache || stale || snapshotReplaced(config.billing?.snapshot_path)) {
    const pending = refreshUsage();
    // Publish independently completed accounts. An unavailable browser must not
    // hold fresh API/snapshot quotas behind its connection timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
    if (timer) clearTimeout(timer);
    // The ongoing shared refresh handles its error even after this response ends.
    void pending.catch(() => undefined);
  }
  const data = cache;
  return {
    generatedAt: data?.generatedAt ?? null,
    timezone: config.server.timezone,
    accounts: data?.results ?? [],
    combined: combinedOverview(data?.results ?? []),
    apiShape: Object.fromEntries((data?.results ?? []).map((result) => [result.account.key, apiShapeSummary(result.data)])),
    refreshing: refreshPromise !== null,
  };
}

/** Test hook: drop the in-process usage cache. */
export function resetUsageCacheForTests(): void {
  cache = null;
  cacheSnapshotMtimeMs = null;
  rememberUsageObservations([]);
  refreshPromise = null;
}
