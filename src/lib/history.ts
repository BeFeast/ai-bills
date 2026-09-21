import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import type { BillingSnapshot } from './billing';

/**
 * Append-only JSONL balance/spend history, used for 30d sparklines.
 * One line per recorded sample:
 *   { "ts": "<iso>", "runpod": 12.34, "vast": 5.67, "est_usd_today": 1.23 }
 *
 * Samples are throttled to at most one per SAMPLE_INTERVAL_MS. All I/O
 * failures are swallowed and surfaced as a diagnostic string (or an empty
 * series) so history problems can never break the billing API.
 */

export type HistoryField = 'runpod' | 'vast' | 'est_usd_today';

export type HistoryEntry = {
  ts: string;
  runpod: number | null;
  vast: number | null;
  est_usd_today: number | null;
};

const SAMPLE_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_SERIES_DAYS = 30;

/**
 * Append a sample derived from the snapshot. Skips silently when the last
 * sample is fresher than SAMPLE_INTERVAL_MS. Returns null on success (or
 * throttle skip) and a diagnostic message on failure.
 */
/** Database-backed samples (tenancy phase 3); null keeps the JSONL file. */
export type HistoryStoreLike = { last(): Promise<Date | null>; append(sample: { at: Date; runpod: number | null; vast: number | null; estUsdToday: number | null }): Promise<void>; since(cutoff: Date, until: Date): Promise<{ at: Date; runpod: number | null; vast: number | null; estUsdToday: number | null }[]> } | null;

export async function recordHistory(snapshot: BillingSnapshot, options: { path?: string; now?: number; store?: HistoryStoreLike } = {}): Promise<string | null> {
  const path = options.path ?? (options.store ? '' : loadConfig().billing.history_path);
  const now = options.now ?? Date.now();
  try {
    const lastAt = options.store ? await options.store.last() : (() => null)();
    const last = options.store ? null : await lastEntry(path);
    const lastTs = options.store ? (lastAt ? lastAt.getTime() : NaN) : last ? Date.parse(last.ts) : NaN;
    if (Number.isFinite(lastTs) && now - lastTs < SAMPLE_INTERVAL_MS) return null;
    const entry: HistoryEntry = {
      ts: new Date(now).toISOString(),
      runpod: balanceOf(snapshot, 'runpod'),
      vast: balanceOf(snapshot, 'vast'),
      est_usd_today: typeof snapshot.summary.meteredSpendTodayUsd === 'number' ? snapshot.summary.meteredSpendTodayUsd : null,
    };
    if (options.store) { await options.store.append({ at: new Date(now), runpod: entry.runpod, vast: entry.vast, estUsdToday: entry.est_usd_today }); return null; }
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return null;
  } catch (error) {
    return `Billing history write failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Daily averages for one field over the trailing `days` window, oldest first.
 * Days without samples are omitted. Returns [] on any read/parse failure.
 */
export async function readSeries(field: HistoryField, days = DEFAULT_SERIES_DAYS, options: { path?: string; now?: number; store?: HistoryStoreLike } = {}): Promise<number[]> {
  const path = options.path ?? (options.store ? '' : loadConfig().billing.history_path);
  const now = options.now ?? Date.now();
  try {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const entries: HistoryEntry[] = options.store
      ? (await options.store.since(new Date(cutoff), new Date(now + 60_000))).map(row => ({ ts: row.at.toISOString(), runpod: row.runpod, vast: row.vast, est_usd_today: row.estUsdToday }))
      : parseEntries(await readFile(path, 'utf8'));
    const byDay = new Map<string, { sum: number; count: number }>();
    for (const entry of entries) {
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts) || ts < cutoff || ts > now + 60_000) continue;
      const value = entry[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const day = entry.ts.slice(0, 10);
      const bucket = byDay.get(day) ?? { sum: 0, count: 0 };
      bucket.sum += value;
      bucket.count += 1;
      byDay.set(day, bucket);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, { sum, count }]) => Number((sum / count).toFixed(4)));
  } catch {
    return [];
  }
}

function balanceOf(snapshot: BillingSnapshot, match: 'runpod' | 'vast'): number | null {
  const entry = snapshot.balances.find((b) => b.provider.toLowerCase().includes(match));
  return entry && typeof entry.balanceUsd === 'number' && Number.isFinite(entry.balanceUsd) ? entry.balanceUsd : null;
}

async function lastEntry(path: string): Promise<HistoryEntry | null> {
  try {
    const text = await readFile(path, 'utf8');
    const entries = parseEntries(text);
    return entries.length ? entries[entries.length - 1] : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseEntries(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<HistoryEntry>;
      if (typeof parsed.ts === 'string') out.push(parsed as HistoryEntry);
    } catch {
      // Skip malformed lines — history is best-effort.
    }
  }
  return out;
}
