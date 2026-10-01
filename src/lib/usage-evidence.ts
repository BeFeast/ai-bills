import { codexPrimaryWindow, cursorUsagePercent, kimiCodingUsage, type ClaudeUsagePayload, type CodexUsagePayload, type CursorUsagePayload, type KimiUsagePayload, type ProviderUsage } from './usage';

/** `lastKnown`: a stale observation that is still recent enough to show its numbers, labelled with their age. */
export type UsageEvidence = { state: 'fresh' | 'stale' | 'error' | 'unknown'; message: string; lastKnown?: true };

export const FRESH_MS = 600_000;
/** Claude: the last good observation from any source stays on screen for one session window (5 h), then it is an error. */
export const CLAUDE_LAST_KNOWN_MS = 5 * 3600_000;

export function usageEvidence(result: ProviderUsage, now: number, maxAgeSeconds = FRESH_MS / 1000): UsageEvidence {
  if (!result.ok || (result.status !== undefined && result.status >= 400)) return { state: 'error', message: result.error || `Provider request failed (HTTP ${result.status ?? 'unknown'}). Quota and availability are unknown.` };
  const observed = Date.parse(result.fetchedAt);
  if (!now || !Number.isFinite(observed) || observed > now + 60_000) return { state: 'unknown', message: 'No valid provider observation time. Current quota and availability are unknown.' };
  if (now - observed > maxAgeSeconds * 1000 && result.account.provider === 'claude') {
    if (now - observed > CLAUDE_LAST_KNOWN_MS) return { state: 'error', message: 'No fresh Claude quota from any source for more than 5 hours. Current quota and availability are unknown.' };
    const data = result.data as ClaudeUsagePayload | undefined;
    if (data && (data.five_hour || data.seven_day || data.limits?.length)) return { state: 'stale', lastKnown: true, message: `Showing the last known quota; the newest refresh failed: ${result.direct?.error ?? 'no newer observation'}.` };
  }
  if (now - observed > maxAgeSeconds * 1000) return { state: 'stale', message: 'The last provider observation is stale. Current quota and availability are unknown.' };
  if (!result.data || !Object.keys(result.data).length) return { state: 'unknown', message: 'The provider returned no quota data. Availability is unknown.' };
  if (result.account.provider === 'claude') {
    const data = result.data as ClaudeUsagePayload;
    if (!data.five_hour && !data.seven_day && !data.limits?.length) return { state: 'unknown', message: 'Claude returned no quota windows. Model availability is unknown.' };
  }
  if (result.account.provider === 'codex' && !codexPrimaryWindow(result.data as CodexUsagePayload)) return { state: 'unknown', message: 'Codex returned no primary quota window. Availability is unknown.' };
  if (result.account.provider === 'kimi' && kimiCodingUsage(result.data as KimiUsagePayload)?.detail.remaining == null) return { state: 'unknown', message: 'Kimi did not report remaining coding quota. Availability is unknown.' };
  if (result.account.provider === 'cursor' && cursorUsagePercent(result.data as CursorUsagePayload) === null) return { state: 'unknown', message: 'Cursor did not report current usage. Availability is unknown.' };
  return { state: 'fresh', message: 'Recent provider observation' };
}
