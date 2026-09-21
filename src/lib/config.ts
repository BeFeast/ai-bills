import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import type { AccountingConfig } from './accounting';
import type { SubscriptionConfig } from './overview';

export type AccountBrowserConfig = {
  subscription_id?: string;
  account_key: string;
  profile_id: string;
  /** Explicit sign-in identity shared by all bindings of this browser. */
  shared_identity_email?: string;
  cdp_http: string;
  remote_url: string;
  login_url: string;
  manage_url: string;
  proxy_account_id?: string;
};

/** A secret value: inline literal, env var reference, or Infisical reference ("path:KEY"). */
export type SecretRef = string | { env: string } | { infisical: string };

export type AccountConfig = {
  key: string;
  provider: 'claude' | 'codex' | 'kimi' | 'cursor';
  label: string;
  email: string;
  claude_org_id?: string;
  cdp_http?: string;
  cdp_profile_id?: string;
  codex_home?: string;
  quota_snapshot_key?: string;
};

export type AppConfig = {
  server: {
    port: number;
    host: string;
    timezone: string;
    usage_refresh_seconds: number;
    billing_fetch_timeout_ms: number;
    idle_timeout_seconds: number;
    codex_proxy_management_url?: string;
  };
  infisical: {
    api_url: string;
    workspace_id: string;
    environment: string;
  };
  secrets: Record<string, SecretRef>;
  /** Legacy block: tolerated in existing config files, no longer read (tenancy phase 5 — the database is the store). */
  billing: Record<string, unknown>;
  accounts: AccountConfig[];
  accounting?: AccountingConfig;
  subscriptions?: SubscriptionConfig[];
  account_browsers?: AccountBrowserConfig[];
};

const DEFAULTS: AppConfig = {
  server: {
    port: 18088,
    host: '0.0.0.0',
    timezone: 'Asia/Jerusalem',
    usage_refresh_seconds: 60,
    billing_fetch_timeout_ms: 1500,
    idle_timeout_seconds: 60,
  },
  infisical: {
    api_url: process.env.INFISICAL_API_URL ?? '',
    workspace_id: process.env.INFISICAL_PROJECT_ID ?? '',
    environment: 'prod',
  },
  secrets: {},
  billing: {},
  accounts: [],
};

let cached: AppConfig | null = null;

function configPath(): string {
  return process.env.AI_BILLS_CONFIG ?? '/app/config.toml';
}

const SNAPSHOT_ACCOUNT_PROVIDERS = new Set(['claude', 'codex']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Accounts a portable collector declares in its snapshot (`collector.accounts`: `{type, email}` rows).
 * Only the two providers whose quota the collector fetches itself are accepted; the key is stable per address.
 */
export function accountsFromSnapshot(snapshot: unknown): AccountConfig[] {
  const collector = (snapshot as { collector?: { accounts?: unknown } } | null)?.collector;
  const rows = Array.isArray(collector?.accounts) ? collector.accounts as Array<Record<string, unknown>> : [];
  const seen = new Set<string>(); const result: AccountConfig[] = [];
  for (const row of rows) {
    const provider = typeof row?.type === 'string' ? row.type : '';
    const email = typeof row?.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (!SNAPSHOT_ACCOUNT_PROVIDERS.has(provider) || !EMAIL.test(email) || seen.has(`${provider}:${email}`)) continue;
    seen.add(`${provider}:${email}`);
    result.push({ key: `${provider}-${email}`, provider: provider as AccountConfig['provider'], label: email, email });
  }
  return result;
}

/** The accounts a tenant is served with: the operator's declaration, or — when none — the ones the collector declares in the tenant's snapshot. */
export function tenantAccounts(config: AppConfig, snapshot: unknown): AccountConfig[] {
  return config.accounts.length ? config.accounts : accountsFromSnapshot(snapshot);
}

export function loadConfig(path = configPath()): AppConfig {
  if (cached) return cached;
  let raw: Record<string, unknown> = {};
  try {
    raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (process.env.NODE_ENV !== 'production' || process.env.AI_BILLS_CONFIG) throw error;
    console.warn(`[config] ${path} unreadable (${(error as NodeJS.ErrnoException).code}), using defaults`);
  }
  const server = { ...DEFAULTS.server, ...(raw.server as object | undefined) };
  const infisical = { ...DEFAULTS.infisical, ...(raw.infisical as object | undefined) };
  const billing = { ...DEFAULTS.billing, ...(raw.billing as object | undefined) };
  const secrets = (raw.secrets ?? {}) as Record<string, SecretRef>;
  const accounts = Array.isArray(raw.accounts) ? (raw.accounts as AccountConfig[]) : [];
  const accounting = raw.accounting as AccountingConfig | undefined;
  const subscriptions = Array.isArray(raw.subscriptions) ? raw.subscriptions as SubscriptionConfig[] : [];
  const account_browsers = Array.isArray(raw.account_browsers) ? raw.account_browsers as AccountBrowserConfig[] : [];
  cached = { server, infisical, billing, secrets, accounts, accounting, subscriptions, account_browsers };
  return cached;
}

/** Test hook: reset the cached config. */
export function resetConfigCache() {
  cached = null;
}
