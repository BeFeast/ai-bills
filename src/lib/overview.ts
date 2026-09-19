import { readFile } from 'node:fs/promises';
import { loadConfig, type AppConfig } from './config';
import { currentMonth } from './accounting';
import { readSubscriptionOverrides, type SubscriptionOverride } from './subscription-overrides';

export type SubscriptionConfig = {
  id: string; provider: string; label?: string; plan: string; status?: string;
  amount?: number; currency?: string; period?: 'month' | 'year' | 'unknown';
  replaces_provider?: string; quantity?: number; renews_at?: string; ends_at?: string; manage_url?: string; login_url?: string;
  account_keys?: string[]; source_note?: string; observed_at?: string;
  cost_evidence?: 'verified' | 'declared' | 'estimated' | 'unknown';
};
export type ProductSubscription = {
  id: string; provider: string; label: string; plan: string; status: string;
  amount: number | null; currency: string; period: 'month' | 'year' | 'unknown';
  quantity: number | null; renewsAt: string | null; endsAt: string | null;
  manageUrl: string | null; loginUrl: string | null; accountKeys: string[];
  sourceNote: string; observedAt: string | null;
  costEvidence: 'verified' | 'declared' | 'estimated' | 'unknown';
};
export type OverviewUsageGroup = { name: string; tokens: number; requests: number; apiEquivalentUsd: number | null; pricedApiEquivalentUsd: number | null; failed?: number; rateLimited?: number; lastRequestAt?: string | null };
/** One proxy upstream (provider + account) in the rolling 24-hour window. Names are masked when they look like keys. */
export type OverviewUpstreamActivity = OverviewUsageGroup & { provider: string };
export type OverviewRecentUsage = { windowHours: number; observedAt: string | null; periodStart: string | null; periodEnd: string | null; requests: number | null; failed: number; rateLimited: number; byUpstream: OverviewUpstreamActivity[]; byAccount: OverviewUsageGroup[] };
export type ProductOverview = {
  month: string;
  links?: { proxyManagementUrl: string | null };
  subscriptions: ProductSubscription[];
  summary: { activeSubscriptionCount: number; subscriptionCountComplete: boolean; knownMonthlyCosts: { currency: string; amount: number }[]; unknownPriceCount: number; monthlyCostEvidence: 'verified' | 'declared' | 'estimated' | 'unknown' };
  usage: { period: 'month'; apiEquivalentUsd: number | null; pricedApiEquivalentUsd: number | null; tokens: number | null; requests: number | null; byClient: OverviewUsageGroup[]; byProject: OverviewUsageGroup[]; byModel: OverviewUsageGroup[]; byAccount?: OverviewUsageGroup[]; reconciliation?: { status: string; confirmedTokens: number | null; confirmedRequests: number | null; nativeObservations: number | null }; unpriced: Record<string, number>; observedAt: string | null; last24h?: OverviewRecentUsage };
  features: { routing: boolean };
};
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
/** The routing service was retired; its tab and proxy linkage only render when it is explicitly configured. */
export const routingConfigured = () => Boolean(process.env.AI_BILLS_ROUTING_URL && process.env.AI_BILLS_ROUTING_TOKEN);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const url = (value: unknown): string | null => { try { const parsed = new URL(text(value)); return ['https:', 'http:'].includes(parsed.protocol) && !/\s/.test(text(value)) ? parsed.href : null; } catch { return null; } };
const date = (value: unknown): string | null => { const v = text(value); return /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null; };
const links: Record<string, [string, string]> = {
  anthropic: ['https://claude.ai/login', 'https://claude.ai/new#settings/usage'],
  openai: ['https://chatgpt.com/auth/login', 'https://chatgpt.com/#settings'],
  google: ['https://accounts.google.com/', 'https://one.google.com/settings'],
  ollamacloud: ['https://ollama.com/signin', 'https://ollama.com/settings'],
  kimi: ['https://www.kimi.com/', 'https://www.kimi.com/code/console'],
  xai: ['https://grok.com/', 'https://grok.com/settings'],
  opencodesst: ['https://opencode.ai/auth', 'https://opencode.ai/workspace'],
};
function subscription(raw: Row, fallbackId: string): ProductSubscription {
  const provider = text(raw.provider); const defaults = links[key(provider)];
  const period = raw.period === 'month' || raw.period === 'year' ? raw.period : 'unknown';
  const amount = number(raw.amount);
  const evidence = ['verified', 'declared', 'estimated'].includes(text(raw.cost_evidence)) ? raw.cost_evidence as ProductSubscription['costEvidence'] : amount === null ? 'unknown' : 'declared';
  return { id: text(raw.id) || fallbackId, provider, label: text(raw.label) || provider, plan: text(raw.plan) || 'Plan not recorded',
    status: text(raw.status) || 'unknown', amount, currency: /^[A-Z]{3}$/.test(text(raw.currency)) ? text(raw.currency) : 'USD', period,
    quantity: raw.quantity === null ? null : number(raw.quantity) ?? 1, renewsAt: date(raw.renews_at), endsAt: date(raw.ends_at),
    manageUrl: url(raw.manage_url) || url(raw.dashboard) || defaults?.[1] || null, loginUrl: url(raw.login_url) || defaults?.[0] || null,
    accountKeys: Array.isArray(raw.account_keys) ? raw.account_keys.filter((value): value is string => typeof value === 'string') : [],
    sourceNote: text(raw.source_note) || 'Provider inventory; renewal date and charged amount have not been reconciled.', observedAt: date(raw.observed_at) || date(raw.verified), costEvidence: evidence };
}
function legacyProvider(raw: Row, index: number): ProductSubscription {
  const original = text(raw.cost_usd_month); const parsed = typeof raw.cost_usd_month === 'number' ? number(raw.cost_usd_month) : /^~?\d+(?:\.\d+)?$/.test(original) ? Number(original.replace('~', '')) : null;
  const quantity = text(raw.plan).match(/×\s*(\d+)/)?.[1];
  return subscription({ ...raw, amount: raw.amount ?? parsed, currency: raw.currency ?? 'USD', period: raw.period ?? 'month',
    quantity: raw.quantity ?? (quantity ? Number(quantity) : text(raw.provider).includes('+') ? null : 1),
    cost_evidence: raw.cost_evidence ?? (original.startsWith('~') ? 'estimated' : parsed === null ? 'unknown' : 'declared'),
    source_note: raw.source_note ?? (text(raw.provider).includes('+') ? 'Grouped provider inventory: separate subscriptions and renewal dates still need to be recorded.' : 'Provider subscription inventory. Amount is declared, not a verified charge; record renewal date from billing settings.') }, `provider-${index}`);
}
/** Upstream-key providers are logged under the raw key; show a fingerprint, never the credential. */
export function maskAccountName(name: string): string {
  const trimmed = name.trim();
  if (/^sk-/i.test(trimmed) || (trimmed.length >= 32 && !/[@\s]/.test(trimmed))) return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
  return trimmed;
}
/** `mask` only for account-shaped names: model and client ids are never credentials and must stay intact. */
function group(value: Row, mask = false): OverviewUsageGroup {
  const lastRequestAt = date(value.last_request_at);
  return { name: mask ? maskAccountName(text(value.name)) : text(value.name), tokens: number(value.tokens) ?? 0, requests: number(value.requests) ?? 0,
    apiEquivalentUsd: number(value.api_equivalent_usd), pricedApiEquivalentUsd: number(value.priced_api_equivalent_usd) ?? number(value.api_equivalent_usd),
    ...(number(value.failed) !== null ? { failed: number(value.failed)! } : {}), ...(number(value.rate_limited) !== null ? { rateLimited: number(value.rate_limited)! } : {}),
    ...(lastRequestAt ? { lastRequestAt } : {}) };
}
function groups(value: unknown, mask = false): OverviewUsageGroup[] {
  return rows(value).map(value => group(value, mask)).filter(value => value.name).sort((a, b) => b.tokens - a.tokens);
}
/** The collector's rolling window is the only recency evidence; a calendar day or month is never relabelled as it. */
function recentUsage(ledger: Row, snapshot: Row): OverviewRecentUsage | undefined {
  const candidate = row(ledger.last_24h);
  if (text(candidate.period) !== 'rolling_24h') return undefined;
  const windowHours = number(candidate.window_hours) ?? 24;
  return { windowHours, observedAt: date(ledger.generated) || date(snapshot.generated), periodStart: date(candidate.period_start), periodEnd: date(candidate.period_end),
    requests: number(candidate.requests), failed: number(candidate.failed) ?? 0, rateLimited: number(candidate.rate_limited) ?? 0,
    byUpstream: rows(candidate.by_upstream).map(value => ({ ...group(value, true), provider: text(value.provider) })).filter(value => value.name && value.provider).sort((a, b) => b.requests - a.requests),
    byAccount: groups(candidate.by_account, true) };
}

/** Product projection: subscriptions are commercial plans, never credential rows. */
export function buildProductOverview(config: AppConfig, input: unknown, month = currentMonth(config.server.timezone), overrides: Record<string, SubscriptionOverride> = {}, features: ProductOverview['features'] = { routing: routingConfigured() }): ProductOverview {
  const snapshot = row(input);
  const explicit = (config.subscriptions ?? []).map(value => subscription(value as unknown as Row, value.id));
  const sourceExplicit = rows(snapshot.subscriptions).map((value, index) => subscription(value, `subscription-${index}`));
  const nested = rows(snapshot.providers).flatMap(provider => rows(provider.subscriptions).map((value, index) => subscription({ ...value, provider: value.provider ?? provider.provider }, `provider-${key(text(provider.provider))}-${index}`)));
  const configuredProviders = new Set(explicit.map(value => key(value.provider)));
  const authoritative = [...explicit, ...[...sourceExplicit, ...nested].filter(value => !configuredProviders.has(key(value.provider)))];
  const coveredProviders = new Set([...authoritative.map(value => key(value.provider)), ...(config.subscriptions ?? []).map(value => key(value.replaces_provider || '')), ...rows(snapshot.subscriptions).map(value => key(text(value.replaces_provider)))]);
  const subscriptions = [...authoritative, ...rows(snapshot.providers).filter(value => !coveredProviders.has(key(text(value.provider))) && (text(value.billing).toLowerCase().includes('subscription') || text(value.status) === 'cancelled')).map(legacyProvider)];
  const unique = [...new Map(subscriptions.map(value => [value.id, value])).values()].map(value => overrides[value.id] ? { ...value, ...overrides[value.id], costEvidence: overrides[value.id].costEvidence ?? value.costEvidence, sourceNote: `${value.sourceNote} Manual update saved ${overrides[value.id].updatedAt}.`, observedAt: overrides[value.id].updatedAt } : value);
  const accountEmails = new Map((config.accounts ?? []).map(account => [account.key, account.email?.trim()]));
  for (const value of unique) {
    const emails = [...new Set(value.accountKeys.map(accountKey => accountEmails.get(accountKey)).filter((email): email is string => Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))))];
    if (emails.length) value.label = emails.join(', ');
    else if (value.accountKeys.length) value.label = `${value.provider} · email not recorded`;
  }
  const active = unique.filter(value => value.status === 'active');
  const costs = new Map<string, number>();
  for (const value of active) if (value.amount !== null && value.period !== 'unknown') costs.set(value.currency, (costs.get(value.currency) ?? 0) + value.amount / (value.period === 'year' ? 12 : 1));
  const ledger = row(snapshot.usage_ledger); const candidate = row(ledger.month);
  // Today's totals/trend cannot supply month rankings; never relabel them.
  const current = text(candidate.date) === month && text(candidate.period_start || `${month}-01`).startsWith(month) ? candidate : {};
  const unpriced = Object.fromEntries(Object.entries(row(current.unpriced)).filter((entry): entry is [string, number] => number(entry[1]) !== null));
  const reconciliation = row(current.reconciliation);
  return { month, links: { proxyManagementUrl: url(config.server.codex_proxy_management_url) }, subscriptions: unique, summary: { activeSubscriptionCount: active.reduce((count, value) => count + (value.quantity ?? 0), 0),
    subscriptionCountComplete: (rows(snapshot.providers).length > 0 || snapshot.subscription_inventory_complete === true) && unique.filter(value => !['cancelled', 'expired'].includes(value.status)).every(value => value.status === 'active' && value.quantity !== null), knownMonthlyCosts: [...costs].map(([currency, amount]) => ({ currency, amount })),
    unknownPriceCount: active.filter(value => value.amount === null || value.period === 'unknown').length, monthlyCostEvidence: active.some(value => value.costEvidence === 'estimated') ? 'estimated' : active.some(value => value.costEvidence === 'declared') ? 'declared' : active.length > 0 && active.every(value => value.costEvidence === 'verified') ? 'verified' : 'unknown' },
    usage: { period: 'month', apiEquivalentUsd: number(current.api_equivalent_usd), pricedApiEquivalentUsd: number(current.priced_api_equivalent_usd) ?? number(current.api_equivalent_usd),
      tokens: number(current.tokens_total), requests: number(current.requests), byClient: groups(current.by_client), byProject: groups(current.by_project), byModel: groups(current.by_model), byAccount: groups(current.by_account, true), unpriced,
      reconciliation: { status: text(reconciliation.status) || 'unknown', confirmedTokens: number(reconciliation.confirmed_tokens), confirmedRequests: number(reconciliation.confirmed_requests), nativeObservations: number(reconciliation.unreconciled_native_observations) },
      observedAt: Object.keys(current).length ? date(ledger.generated) || date(snapshot.generated) : null, last24h: recentUsage(ledger, snapshot) }, features };
}
export async function productOverview(config: AppConfig = loadConfig()): Promise<ProductOverview> {
  let snapshot: unknown = {};
  try { snapshot = JSON.parse(await readFile(config.billing.snapshot_path, 'utf8')); } catch { /* Explicit plans remain useful while usage is unavailable. */ }
  return buildProductOverview(config, snapshot, currentMonth(config.server.timezone), await readSubscriptionOverrides(config));
}
