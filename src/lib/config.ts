import { readFileSync, statSync } from 'node:fs';
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
  billing: {
    snapshot_path: string;
    history_path: string;
  };
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
  billing: {
    snapshot_path: '/data/snapshot.json',
    history_path: '/data/history.jsonl',
  },
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

let derived: { path: string; mtimeMs: number; accounts: AccountConfig[] } | null = null;
/** Re-read the declared accounts only when the snapshot file changes; a stat per call is the whole cost. */
function deriveAccounts(snapshotPath: string): AccountConfig[] {
  let mtimeMs: number;
  try { mtimeMs = statSync(snapshotPath).mtimeMs; } catch { return []; }
  if (derived && derived.path === snapshotPath && derived.mtimeMs === mtimeMs) return derived.accounts;
  let accounts: AccountConfig[] = [];
  try { accounts = accountsFromSnapshot(JSON.parse(readFileSync(snapshotPath, 'utf8'))); } catch { accounts = []; }
  derived = { path: snapshotPath, mtimeMs, accounts };
  return accounts;
}

let accountsDeclared = true;
export function loadConfig(path = configPath()): AppConfig {
  // A config without accounts (hosted partner instance) takes them from the snapshot the collector delivers.
  if (cached) return accountsDeclared ? cached : { ...cached, accounts: deriveAccounts(cached.billing.snapshot_path) };
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
  accountsDeclared = accounts.length > 0;
  cached = { server, infisical, billing, secrets, accounts, accounting, subscriptions, account_browsers };
  return loadConfig(path);
}

/** Test hook: reset the cached config. */
export function resetConfigCache() {
  cached = null; derived = null; accountsDeclared = true;
}
