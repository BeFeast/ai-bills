import { fetchUsageThroughCdp } from './cdp';
import { rememberUsageObservations } from './usage-observations';
import { loadConfig } from './config';
import { apiShapeSummary, combinedOverview, type ProviderUsage } from './usage';

type UsageCache = { results: ProviderUsage[]; generatedAt: string };

let cache: UsageCache | null = null;
let refreshPromise: Promise<UsageCache> | null = null;

export async function refreshUsage(): Promise<UsageCache> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const results = await Promise.all(loadConfig().accounts.map((account) => fetchUsageThroughCdp(account)));
    rememberUsageObservations(results);
    cache = { results, generatedAt: new Date().toISOString() };
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
  const data = force || !cache || stale ? await refreshUsage() : cache;
  return {
    generatedAt: data?.generatedAt ?? null,
    timezone: config.server.timezone,
    accounts: data?.results ?? [],
    combined: combinedOverview(data?.results ?? []),
    apiShape: Object.fromEntries((data?.results ?? []).map((result) => [result.account.key, apiShapeSummary(result.data)])),
  };
}

/** Test hook: drop the in-process usage cache. */
export function resetUsageCacheForTests(): void {
  cache = null;
  rememberUsageObservations([]);
  refreshPromise = null;
}
