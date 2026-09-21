import type { BillingSnapshot } from './billing';

/**
 * Balance/spend history for the 30d sparklines, one sample per tenant at most every SAMPLE_INTERVAL_MS,
 * kept in history_points. Failures are reported as a diagnostic string so history can never break the billing API.
 */

export type HistoryField = 'runpod' | 'vast' | 'est_usd_today';

const SAMPLE_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_SERIES_DAYS = 30;

/**
 * Append a sample derived from the snapshot. Skips silently when the last
 * sample is fresher than SAMPLE_INTERVAL_MS. Returns null on success (or
 * throttle skip) and a diagnostic message on failure.
 */
/** Database-backed samples (tenancy phase 3); null keeps the JSONL file. */
export type HistoryStoreLike = { last(): Promise<Date | null>; append(sample: { at: Date; runpod: number | null; vast: number | null; estUsdToday: number | null }): Promise<void>; since(cutoff: Date, until: Date): Promise<{ at: Date; runpod: number | null; vast: number | null; estUsdToday: number | null }[]> } | null;

export async function recordHistory(snapshot: BillingSnapshot, options: { now?: number; store?: HistoryStoreLike } = {}): Promise<string | null> {
  const now = options.now ?? Date.now();
  if (!options.store) return 'Billing history needs the database; none is configured for this tenant';
  try {
    const lastAt = await options.store.last();
    if (lastAt && now - lastAt.getTime() < SAMPLE_INTERVAL_MS) return null;
    await options.store.append({ at: new Date(now), runpod: balanceOf(snapshot, 'runpod'), vast: balanceOf(snapshot, 'vast'),
      estUsdToday: typeof snapshot.summary.meteredSpendTodayUsd === 'number' ? snapshot.summary.meteredSpendTodayUsd : null });
    return null;
  } catch (error) {
    return `Billing history write failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Daily averages for one field over the trailing `days` window, oldest first. Days without samples are omitted; [] on any failure. */
export async function readSeries(field: HistoryField, days = DEFAULT_SERIES_DAYS, options: { now?: number; store?: HistoryStoreLike } = {}): Promise<number[]> {
  const now = options.now ?? Date.now();
  if (!options.store) return [];
  try {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const byDay = new Map<string, { sum: number; count: number }>();
    for (const row of await options.store.since(new Date(cutoff), new Date(now + 60_000))) {
      const value = field === 'runpod' ? row.runpod : field === 'vast' ? row.vast : row.estUsdToday;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const day = row.at.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { sum: 0, count: 0 };
      bucket.sum += value; bucket.count += 1; byDay.set(day, bucket);
    }
    return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, { sum, count }]) => Number((sum / count).toFixed(4)));
  } catch { return []; }
}

function balanceOf(snapshot: BillingSnapshot, match: 'runpod' | 'vast'): number | null {
  const entry = snapshot.balances.find((b) => b.provider.toLowerCase().includes(match));
  return entry && typeof entry.balanceUsd === 'number' && Number.isFinite(entry.balanceUsd) ? entry.balanceUsd : null;
}
