import { freshness, type Freshness } from './accounting';

type Observation = { freshness: Freshness; usd: number | null };
export type OpenRouterFunds = {
  accountBalance: Observation;
  accountSpentUsd: number | null;
  keyUsage: Observation;
  keyLimitUsd: number | null;
  keyLimitKnown: boolean;
  keyRemainingUsd: number | null;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function openRouterFunds(snapshot: unknown, now = Date.now()): OpenRouterFunds {
  const data = object(object(snapshot).openrouter); const credits = object(data.credits); const key = object(data.key);
  const observation = (name: string, row: Record<string, unknown>, field: string): Observation => {
    const receipt = freshness(name, typeof row.observedAt === 'string' ? row.observedAt : null, 600, now);
    const usd = amount(row[field]);
    if (row.ok !== true || usd === null) { receipt.status = 'error'; receipt.message = 'OpenRouter automatic source unavailable'; }
    return { freshness: receipt, usd: receipt.status === 'fresh' ? usd : null };
  };
  const accountBalance = observation('openrouter-account-credits', credits, 'balanceUsd');
  const keyUsage = observation('openrouter-key-usage', key, 'usageUsd');
  return { accountBalance, accountSpentUsd: accountBalance.freshness.status === 'fresh' ? amount(credits.totalUsageUsd) : null,
    keyUsage, keyLimitUsd: keyUsage.freshness.status === 'fresh' ? amount(key.limitUsd) : null,
    keyLimitKnown: keyUsage.freshness.status === 'fresh' && (key.limitUsd === null || amount(key.limitUsd) !== null),
    keyRemainingUsd: keyUsage.freshness.status === 'fresh' ? amount(key.remainingUsd) : null };
}
