import { fetchUsageThroughCdp } from './cdp';
import { rememberUsageObservations } from './usage-observations';
import { loadConfig, tenantAccounts } from './config';
import { publicUsageAccount } from './account-auth';
import { creditHistoryStoreFor, readSnapshot, type Scope } from './storage';
import { CREDIT_RATE_MIN_SPAN_MS, CREDIT_RATE_WINDOW_MS, creditDrain, type CreditSample } from './codex-credits';
import { apiShapeSummary, combinedOverview, type ProviderUsage, PENDING_OBSERVATION } from './usage';

type UsageCache = { results: ProviderUsage[]; generatedAt: string };
/** One cache per tenant (tenancy phase 3); the file-backed instance has exactly one, keyed by the null tenant. */
type Slot = { cache: UsageCache | null; refreshPromise: Promise<UsageCache> | null; version: string | null };
const slots = new Map<string | null, Slot>();
const slotFor = (scope?: Scope): Slot => { const key = scope?.id ?? null; let slot = slots.get(key); if (!slot) { slot = { cache: null, refreshPromise: null, version: null }; slots.set(key, slot); } return slot; };

/**
 * The collector replaces the snapshot outside this process (hosted ingest, the receiver on the app
 * host, or a new row for the tenant), so a cache built from an older snapshot is out of date however
 * recently it was built. Without this an idle instance keeps serving the quota it read the last time
 * someone looked, and every card reports a stale observation while the alerts beside them are current.
 * No readable snapshot: there is nothing newer to read, so this must not force a refresh per request.
 */
const snapshotReplaced = (slot: Slot, version: string | null): boolean => version !== null && version !== slot.version;

/** Earlier Codex credit balances for the burn rate. The rate refines a card; a failed read must never hold or fail the quota itself. */
async function creditSamples(scope?: Scope): Promise<CreditSample[]> {
  const store = creditHistoryStoreFor(scope);
  if (!store) return [];
  // An observation can be one collector tick older than now, so look a little further back than the rate window.
  return store.since(new Date(Date.now() - CREDIT_RATE_WINDOW_MS - CREDIT_RATE_MIN_SPAN_MS)).catch(() => []);
}

export async function refreshUsage(scope?: Scope): Promise<UsageCache> {
  const slot = slotFor(scope);
  if (slot.refreshPromise) return slot.refreshPromise;
  slot.refreshPromise = (async () => {
    const config = loadConfig();
    // Read before the first observation: a snapshot that lands mid-refresh belongs to the next one.
    const snapshot = await readSnapshot(config, scope);
    const cache = slot.cache;
    const accounts = tenantAccounts(config, snapshot.body);
    const previous = new Map(cache?.results.map(result => [result.account.key, result]) ?? []);
    const results: ProviderUsage[] = accounts.map(account => previous.get(account.key) ?? ({
      account: publicUsageAccount(account, config.server.codex_proxy_management_url),
      ok: false, fetchedAt: '', sourceUrl: '', error: PENDING_OBSERVATION,
    }));
    slot.cache = { results, generatedAt: new Date().toISOString() };
    let credits: Promise<CreditSample[]> | null = null;
    const update = async (account: typeof accounts[number], index: number) => {
      const result: ProviderUsage = { ...await fetchUsageThroughCdp(account, { snapshot: snapshot.body, scope: scope?.id ?? null, accounts }),
        account: publicUsageAccount(account, config.server.codex_proxy_management_url) };
      // Only an account that pays from credits needs the history; read it once per refresh.
      const drain = creditDrain(result, []) ? creditDrain(result, await (credits ??= creditSamples(scope))) : null;
      results[index] = drain ? { ...result, creditDrain: drain } : result;
      rememberUsageObservations([...results]);
    };
    const indexed = accounts.map((account, index) => ({ account, index }));
    const browserSources = indexed.filter(({ account }) => ['kimi', 'cursor'].includes(account.provider));
    await Promise.all([
      ...indexed.filter(({ account }) => !['kimi', 'cursor'].includes(account.provider)).map(({ account, index }) => update(account, index)),
      (async () => { for (const { account, index } of browserSources) await update(account, index); })(),
    ]);
    rememberUsageObservations(results);
    slot.cache = { results, generatedAt: new Date().toISOString() };
    slot.version = snapshot.version;
    slot.refreshPromise = null;
    return slot.cache;
  })().catch((error) => {
    slot.refreshPromise = null;
    throw error;
  });
  return slot.refreshPromise;
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

export async function getUsageResponse(force = false, scope?: Scope): Promise<UsageResponseBody> {
  const config = loadConfig();
  const slot = slotFor(scope);
  const ttlMs = Math.max(5, config.server.usage_refresh_seconds || 60) * 1000;
  // Auto-refresh used to call /api/usage without ?refresh=1, which forever returned the
  // first in-process snapshot. Honour TTL so the dashboard actually tracks live quotas.
  const stale = cacheAgeMs(slot.cache) >= ttlMs;
  if (force || !slot.cache || stale || snapshotReplaced(slot, (await readSnapshot(config, scope)).version)) {
    const pending = refreshUsage(scope);
    // Publish independently completed accounts. An unavailable browser must not
    // hold fresh API/snapshot quotas behind its connection timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
    if (timer) clearTimeout(timer);
    // The ongoing shared refresh handles its error even after this response ends.
    void pending.catch(() => undefined);
  }
  const data = slot.cache;
  return {
    generatedAt: data?.generatedAt ?? null,
    timezone: config.server.timezone,
    accounts: data?.results ?? [],
    combined: combinedOverview(data?.results ?? []),
    apiShape: Object.fromEntries((data?.results ?? []).map((result) => [result.account.key, apiShapeSummary(result.data)])),
    refreshing: slot.refreshPromise !== null,
  };
}

/** Test hook: drop the in-process usage caches. */
export function resetUsageCacheForTests(): void {
  slots.clear();
  rememberUsageObservations([]);
}
