import type { CodexUsagePayload, ProviderUsage } from './usage';

/**
 * Codex does not refuse requests once a rate-limit window is used up while the account has credits: it answers and
 * charges the credit balance. No 429 means the proxy neither cools the account down nor fails over, so a used-up
 * account can keep spending while another account of the pool still has room. A bare "0 % left" hides all of that,
 * so every surface (card, Overview hero, widget, guards) names the state through this module. Pure: the earlier
 * balances come in as samples (usage-service reads them from the stored quota observations).
 */
export type CreditDrain = {
  /** Credits left as the provider reports them; null when the balance is not a number. */
  balance: number | null;
  /** Credits spent per hour since `since`; null without an earlier observation to measure from (or after a top-up), 0 when nothing was spent. */
  perHour: number | null;
  /** The earlier observation of the same account the rate is measured from. */
  since: string | null;
  /** Manual resets the provider would apply now; each restores the window without spending credits. */
  manualResets: number;
};
/**
 * One earlier credit balance of a Codex account, as stored with its quota observation. `canPay` is that observation's
 * own verdict (credits on hand, no overage or spend cap reached), null when it carried no credits block.
 */
export type CreditSample = { accountKey: string; accountId: string | null; userId: string | null; observedAt: string; balance: string | null; canPay: boolean | null };

/** How far back the burn rate looks, and the shortest span it is measured over (two collector ticks). */
export const CREDIT_RATE_WINDOW_MS = 60 * 60_000;
export const CREDIT_RATE_MIN_SPAN_MS = 10 * 60_000;
/** The words the widget appends to a used-up window's label, so clients that predate `creditDrain` still say it. */
export const PAYING_FROM_CREDITS = 'paying from credits';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The provider sends the balance as a decimal string. */
export function creditBalance(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : finite(value) ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** A Codex window is used up: the provider says the limit is reached (or the request is not allowed), or a window reports 100 % used. */
export function codexUsedUp(data?: CodexUsagePayload | null): boolean {
  const limits = data?.rate_limit;
  if (!limits) return false;
  if (limits.limit_reached === true || limits.allowed === false) return true;
  return [limits.primary_window, limits.secondary_window].some((window) => { const used = window?.used_percent; return finite(used) && used >= 100; });
}

/** Used up, yet the next request is still served and charged to the credits: credits on hand, no overage or spend cap reached. */
export function codexPaysFromCredits(data?: CodexUsagePayload | null): boolean {
  return codexUsedUp(data) && data?.credits?.has_credits === true && data.credits.overage_limit_reached !== true && data.spend_control?.reached !== true;
}

/**
 * Whether a Codex result may be paying from credits and needs its history read. A header fallback (the direct quota
 * request failed, the proxy's rate-limit headers stood in) says the window is used up but carries no credits block;
 * only the stored observations can then tell whether the account still pays.
 */
export function creditDrainCandidate(result: ProviderUsage): boolean {
  if (result.account.provider !== 'codex' || !result.ok) return false;
  const data = result.data as CodexUsagePayload | undefined;
  if (!data || !codexUsedUp(data)) return false;
  return data.credits ? codexPaysFromCredits(data) : true;
}

/**
 * The drain of one Codex result, or null unless it pays from credits. The rate runs from the earliest balance of the
 * same login in the last hour to the current one, at least ten minutes apart. A balance that rose on the way (a
 * top-up or the plan's renewal) says nothing about the spend before it, so the rate starts after the last rise; when
 * that leaves too short a span, the rate is unknown rather than zero. Without a credits block in the payload (a header
 * fallback) the newest stored observation of the last hour stands in: it decides whether the account can still pay,
 * and its balance is the current one.
 */
export function creditDrain(result: ProviderUsage, samples: CreditSample[]): CreditDrain | null {
  if (!creditDrainCandidate(result)) return null;
  const data = result.data as CodexUsagePayload;
  const reported = Boolean(data.credits);
  const applicable = data.rate_limit_reset_credits?.applicable_available_count;
  const manualResets = finite(applicable) ? Math.max(0, applicable) : 0;
  const observed = Date.parse(result.fetchedAt);
  const balance = reported ? creditBalance(data.credits.balance) : null;
  if (!Number.isFinite(observed)) return reported ? { balance, perHour: null, since: null, manualResets } : null;
  // One login: the provider's account id is the workspace, the user id the member in it; old rows without ids fall back to the e-mail key.
  const id = data.account_id || null; const user = data.user_id || null;
  const emails = new Set([data.email, result.account.email].filter(Boolean).map((email) => email.toLowerCase()));
  const sameLogin = (sample: CreditSample) => id && sample.accountId ? sample.accountId === id && (!user || !sample.userId || sample.userId === user) : emails.has(sample.accountKey.toLowerCase());
  const points = samples.filter(sameLogin)
    .map((sample) => ({ at: Date.parse(sample.observedAt), balance: creditBalance(sample.balance), observedAt: sample.observedAt, canPay: sample.canPay }))
    .filter((point): point is { at: number; balance: number; observedAt: string; canPay: boolean | null } => Number.isFinite(point.at) && point.balance !== null && point.at >= observed - CREDIT_RATE_WINDOW_MS && point.at < observed)
    .sort((a, b) => a.at - b.at);
  if (reported) {
    if (balance === null) return { balance, perHour: null, since: null, manualResets };
    points.push({ at: observed, balance, observedAt: result.fetchedAt, canPay: true });
  } else {
    // Nothing stored in the last hour, or the newest stored observation could no longer pay (credits gone, a cap reached): not paying as far as is known.
    const newest = points[points.length - 1];
    if (!newest || newest.canPay !== true || newest.balance <= 0) return null;
  }
  let start = 0;
  for (let index = 1; index < points.length; index++) if (points[index].balance > points[index - 1].balance) start = index;
  const base = points[start]; const current = points[points.length - 1];
  if (current.at - base.at < CREDIT_RATE_MIN_SPAN_MS) return { balance: current.balance, perHour: null, since: null, manualResets };
  return { balance: current.balance, perHour: Math.round((base.balance - current.balance) / ((current.at - base.at) / 3_600_000)), since: base.observedAt, manualResets };
}

/** 8765 → "8.8k", 1250000 → "1.3M". */
export function compactCredits(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${Number((value / 1e6).toFixed(1))}M`;
  if (abs >= 1e3) return `${Number((value / 1e3).toFixed(1))}k`;
  return String(Math.round(value));
}

/** True when the balance is measurably falling: the evidence that the account is being used and paid for, not just eligible. */
export const spendingCredits = (drain: CreditDrain | null | undefined): boolean => (drain?.perHour ?? 0) > 0;

/** "paying from credits · −8.8k credits/h · 2 manual resets available": the short form for hero and widget lines. */
export function creditDrainSummary(drain: CreditDrain): string {
  const parts = [PAYING_FROM_CREDITS];
  if (drain.perHour !== null) parts.push(drain.perHour > 0 ? `−${compactCredits(drain.perHour)} credits/h` : 'no credits spent lately');
  if (drain.manualResets > 0) parts.push(`${drain.manualResets} manual reset${drain.manualResets === 1 ? '' : 's'} available`);
  return parts.join(' · ');
}

/** The full sentence for the account card and the availability tooltip. */
export function creditDrainSentence(drain: CreditDrain | null): string {
  const facts = [drain?.balance !== null && drain?.balance !== undefined ? `${Math.round(drain.balance).toLocaleString('en-US')} left` : null,
    drain && drain.perHour !== null ? drain.perHour > 0 ? `−${compactCredits(drain.perHour)} credits/h` : 'no credits spent lately' : null].filter(Boolean);
  const resets = drain?.manualResets ? ` A manual reset restores the window without spending credits (${drain.manualResets} available).` : '';
  return `The rate limit is used up, but Codex still answers: each request is charged to the credit balance${facts.length ? ` (${facts.join(', ')})` : ''}.${resets}`;
}
