import { dirname, join } from 'node:path';
import type { AppConfig } from './config';
import type { ProductOverview, ProductSubscription } from './overview';
export type SubscriptionOverride = Partial<Pick<ProductSubscription, 'amount' | 'currency' | 'period' | 'renewsAt' | 'endsAt' | 'status'>> & { updatedAt: string; costEvidence?: ProductSubscription['costEvidence'] };
export class SubscriptionInputError extends Error {}
export class SubscriptionBusyError extends Error {}
/** No store for this tenant (no database): a configuration state, not something to retry. */
export class SubscriptionStoreError extends Error {}
/** Where the pre-database file lived; read once by the boot import, never written. */
export function subscriptionOverridesPath(config: AppConfig): string {
  return join(dirname(config.accounting?.journal_path || '/data/accounting.jsonl'), 'subscription-overrides.json');
}
/** Where overrides live when the database is the source (tenancy phase 3); null keeps the file. */
export type OverridesStoreLike = { read(): Promise<Record<string, unknown>>; write(subscriptionId: string, override: unknown): Promise<void> } | null;

export async function readSubscriptionOverrides(_config: AppConfig, store: OverridesStoreLike = null): Promise<Record<string, SubscriptionOverride>> {
  // No store (no database or no tenant): nothing was ever saved for this scope.
  return store ? (await store.read()) as Record<string, SubscriptionOverride> : {};
}
const fields = ['amount', 'currency', 'period', 'renewsAt', 'endsAt', 'status'];
export function validateSubscriptionPatch(input: unknown): { id: string; changes: Omit<SubscriptionOverride, 'updatedAt'> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SubscriptionInputError('Expected a subscription object');
  const body = input as Record<string, unknown>;
  if (typeof body.id !== 'string' || !body.id || body.id.length > 200) throw new SubscriptionInputError('Existing subscription ID is required');
  if (Object.keys(body).some(key => key !== 'id' && !fields.includes(key)) || !fields.some(key => key in body)) throw new SubscriptionInputError('Unsupported or empty subscription update');
  if ('amount' in body && body.amount !== null && (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0 || body.amount > 1_000_000)) throw new SubscriptionInputError('Amount must be a non-negative number or null');
  if ('currency' in body && (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency) || !Intl.supportedValuesOf('currency').includes(body.currency))) throw new SubscriptionInputError('Currency must be an ISO currency code');
  if ('period' in body && !['month', 'year', 'unknown'].includes(String(body.period))) throw new SubscriptionInputError('Invalid billing period');
  if ('status' in body && !['active', 'cancelled', 'expired', 'unknown'].includes(String(body.status))) throw new SubscriptionInputError('Invalid subscription status');
  for (const field of ['renewsAt', 'endsAt']) if (field in body && body[field] !== null) {
    const value = body[field];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new SubscriptionInputError('Dates must be valid YYYY-MM-DD values or null');
  }
  return { id: body.id, changes: Object.fromEntries(fields.filter(field => field in body).map(field => [field, body[field]])) as Omit<SubscriptionOverride, 'updatedAt'> };
}
/** Durable local edits survive snapshots; source/config records remain unchanged. */
export async function saveSubscriptionOverride(config: AppConfig, input: unknown, current: ProductOverview, store: OverridesStoreLike = null): Promise<void> {
  const { id, changes } = validateSubscriptionPatch(input);
  const existing = current.subscriptions.find(value => value.id === id);
  if (!existing) throw new SubscriptionInputError('Subscription no longer exists in the current inventory');
  if (!store) throw new SubscriptionStoreError('Subscription edits need the database; none is configured for this tenant');
  const previous = (await store.read())[id] as SubscriptionOverride | undefined;
  const priceChanged = (['amount', 'currency', 'period'] as const).some(field => field in changes && changes[field] !== existing[field]);
  await store.write(id, { ...previous, ...changes, ...(priceChanged ? { costEvidence: 'declared' as const } : {}), updatedAt: new Date().toISOString() });
}
