// Client-side formatting helpers. Mirror the legacy dashboard.ts formatters 1:1
// so displayed values stay identical after the React port.

export const DEFAULT_TZ = 'Asia/Jerusalem';

export function fmtPct(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : 'n/a';
}

export function fmtMoney(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : 'n/a';
}

/** Token counts run to hundreds of millions a day — spell those compactly. */
export function fmtTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

export function fmtNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : 'n/a';
}

export function fmtDate(value: string | null | undefined, tz: string = DEFAULT_TZ): string {
  const d = new Date(value || '');
  return Number.isNaN(d.getTime())
    ? 'n/a'
    : d.toLocaleString('en-IL', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
}

/** Compact duration: days once past 24 hours ("1d 3h 14m"), no zero hours below one hour ("5m"). */
export function duration(ms: number): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function countdown(value: string | null | undefined, now: number): string {
  if (!value) return 'n/a';
  const ms = new Date(value).getTime() - now;
  if (!Number.isFinite(ms)) return 'n/a';
  return ms >= 0 ? `${duration(ms)} left` : `${duration(ms)} ago`;
}

/** Wording for a limit window: what happens (refill) and when, or that it is overdue. */
export function refillLabel(value: string | null | undefined, now: number): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  return ms >= 0 ? `refills in ${duration(ms)}` : `refill was due ${duration(ms)} ago`;
}

export function resetLabel(value: string | null | undefined, now: number, tz: string): string {
  return value ? `${fmtDate(value, tz)} · ${countdown(value, now)}` : 'n/a';
}

export function pickPct(...values: unknown[]): number | null {
  for (const value of values) {
    const n = normalizePct(value);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Provider usage APIs report whole percents (0..100), never 0..1 fractions.
 * The old "rescale anything <= 1" heuristic turned a real 1 % weekly window into
 * 100 % — a full red bar plus a bogus "No models available" pill. Take it as-is.
 */
export function normalizePct(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function barWidth(pct: number | null | undefined): string {
  return `${Math.max(0, Math.min(100, pct ?? 0))}%`;
}
