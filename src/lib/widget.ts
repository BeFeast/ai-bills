import { loadConfig } from './config';
import { accountWindows, type HeroWindow } from './limits-hero';
import { groups, type OverviewUsageGroup } from './overview';
import { readSnapshot, type Scope } from './storage';
import { isPendingObservation, type ProviderUsage } from './usage';
import { usageEvidence, type UsageEvidence } from './usage-evidence';
import { getUsageResponse, type UsageResponseBody } from './usage-service';

/**
 * The compact answer a desktop widget polls: every account of the tenant with its limit windows (the
 * same `accountWindows` the Overview hero draws, so the numbers agree), today's spend by client label
 * from the collector's ledger, and how old the evidence is. Read-only; nothing here refreshes a source
 * on its own beyond what any dashboard reader triggers.
 */
export type WidgetAccountState = UsageEvidence['state'] | 'pending';
export type WidgetAccount = {
  key: string; provider: string; label: string; email: string;
  state: WidgetAccountState; message: string | null; observedAt: string | null;
  /** The window that stops the next request first; null while pending or when the source failed without a last answer. */
  limiting: HeroWindow | null; windows: HeroWindow[];
};
export type WidgetPayload = {
  now: string;
  snapshot: { generatedAt: string | null; receivedAt: string | null; ageSeconds: number | null; stale: boolean; reason: 'no-snapshot' | 'snapshot-age' | null };
  usage: { refreshedAt: string | null; refreshing: boolean; timezone: string };
  accounts: WidgetAccount[];
  /** Today's ledger by client label, or null when the stored ledger is not for today in the instance's timezone. */
  today: { date: string; byClient: OverviewUsageGroup[] } | null;
};

/** A snapshot older than this is shown as stale: the collector ticks every five minutes, so three missed ticks is a real gap. */
export const WIDGET_STALE_AFTER_SECONDS = 15 * 60;

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function localDate(timezone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const part = (type: string) => parts.find(entry => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const stateOrder: Record<WidgetAccountState, number> = { fresh: 0, stale: 1, unknown: 2, error: 3, pending: 4 };

function widgetAccount(result: ProviderUsage, now: number): WidgetAccount {
  const base = { key: result.account.key, provider: result.account.provider, label: result.account.label, email: result.account.email };
  if (isPendingObservation(result)) return { ...base, state: 'pending', message: 'Waiting for the first quota observation', observedAt: null, limiting: null, windows: [] };
  const evidence = usageEvidence(result, now);
  const { windows, limiting } = accountWindows(result);
  return { ...base, state: evidence.state, message: evidence.state === 'fresh' ? null : evidence.message, observedAt: result.fetchedAt || null, limiting, windows };
}

export function buildWidgetPayload({ usage, snapshot, now, timezone, staleAfterSeconds = WIDGET_STALE_AFTER_SECONDS }: {
  usage: UsageResponseBody; snapshot: { body: unknown; version: string | null }; now: number; timezone: string; staleAfterSeconds?: number;
}): WidgetPayload {
  const body = row(snapshot.body);
  const receivedMs = snapshot.version ? Date.parse(snapshot.version) : NaN;
  const ageSeconds = Number.isFinite(receivedMs) ? Math.max(0, Math.round((now - receivedMs) / 1000)) : null;
  const reason = ageSeconds === null ? 'no-snapshot' : ageSeconds > staleAfterSeconds ? 'snapshot-age' : null;
  const accounts = usage.accounts.map(result => widgetAccount(result, now)).sort((a, b) => {
    const order = stateOrder[a.state] - stateOrder[b.state];
    if (order !== 0) return order;
    return (a.limiting?.remainingPercent ?? 101) - (b.limiting?.remainingPercent ?? 101) || a.label.localeCompare(b.label);
  });
  const today = row(row(body.usage_ledger).today);
  const date = text(today.date);
  return {
    now: new Date(now).toISOString(),
    snapshot: { generatedAt: text(body.generated) || null, receivedAt: snapshot.version, ageSeconds, stale: reason !== null, reason },
    usage: { refreshedAt: usage.generatedAt, refreshing: usage.refreshing === true, timezone },
    accounts,
    // A snapshot that outlived midnight carries yesterday's "today"; never relabel it as the current day.
    today: date && date === localDate(timezone, new Date(now)) && text(today.period) === 'day' ? { date, byClient: groups(today.by_client) } : null,
  };
}

export async function widgetPayload(scope: Scope, now = Date.now()): Promise<WidgetPayload> {
  const config = loadConfig();
  const [usage, snapshot] = await Promise.all([getUsageResponse(false, scope), readSnapshot(config, scope)]);
  return buildWidgetPayload({ usage, snapshot, now, timezone: config.server.timezone });
}
