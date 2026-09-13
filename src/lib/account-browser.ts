import type { AccountBrowserConfig, AccountConfig, AppConfig } from './config';
import { validateCdpEndpoint } from './cdp-startup';
import { connectAccountBrowser, type AccountBrowserConnection, type BrowserTarget } from './account-browser-cdp';
import type { AccountBrowserSelector, AccountBrowserState, AccountBrowserStatus } from './account-browser-types';
import { acquireBrowserLease, releaseBrowserLease, renewBrowserLease, type BrowserLease } from './browser-lease';

export class AccountBrowserInputError extends Error {}
const providerHosts: Record<AccountConfig['provider'], string[]> = {
  claude: ['claude.ai'], codex: ['chatgpt.com', 'auth.openai.com'],
  kimi: ['www.kimi.com', 'kimi.com'], cursor: ['cursor.com', 'www.cursor.com', 'authenticator.cursor.sh'],
};
const email = (value: unknown): value is string => typeof value === 'string' && value.length < 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const ownedTabs = new Map<string, { id: string; url: string }>();
const queues = new Map<string, Promise<void>>();
const readFlights = new Map<string, Promise<AccountBrowserState>>();
const manualLeases = new Map<string, BrowserLease>();
type BrowserAction = 'manage' | 'login' | 'close' | 'renew';
type Dependencies = { connect: typeof connectAccountBrowser; routing: () => Promise<unknown> };

export function parseAccountBrowserInput(input: unknown, actionRequired = false): { selector: AccountBrowserSelector; action?: BrowserAction } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountBrowserInputError('Expected an account browser request');
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => !['subscriptionId', 'accountKey', ...(actionRequired ? ['action'] : [])].includes(key))) throw new AccountBrowserInputError('Unsupported account browser field');
  const selected = ['subscriptionId', 'accountKey'].filter(key => data[key] !== undefined);
  if (selected.length !== 1 || typeof data[selected[0]] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(data[selected[0]] as string)) throw new AccountBrowserInputError('Select exactly one subscription or account');
  if (actionRequired && !['manage', 'login', 'close', 'renew'].includes(String(data.action))) throw new AccountBrowserInputError('Unsupported browser action');
  return { selector: { [selected[0]]: data[selected[0]] } as AccountBrowserSelector, ...(actionRequired ? { action: data.action as BrowserAction } : {}) };
}

function safeUrl(value: string, hosts?: string[]): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (hosts && (url.protocol !== 'https:' || !hosts.includes(url.hostname) || (url.port && url.port !== '443')))) throw new Error('Invalid browser binding URL');
  return url;
}

export function resolveBrowserBinding(config: AppConfig, selector: AccountBrowserSelector) {
  const bindings = config.account_browsers ?? [];
  const matching = bindings.filter(binding => selector.subscriptionId ? binding.subscription_id === selector.subscriptionId : binding.account_key === selector.accountKey);
  if (!matching.length) return null;
  if (matching.length !== 1) throw new Error('Ambiguous browser binding');
  const binding = matching[0];
  const accounts = config.accounts.filter(account => account.key === binding.account_key);
  if (accounts.length !== 1 || !email(accounts[0].email)) throw new Error('Account identity missing');
  const account = accounts[0];
  if (!/^ai-bills-[a-z0-9][a-z0-9-]{1,70}$/.test(binding.profile_id)) throw new Error('Dedicated browser profile required');
  const endpoint = validateCdpEndpoint({ ...account, cdp_http: binding.cdp_http });
  const remote = safeUrl(binding.remote_url);
  if (bindings.some(other => other !== binding && (other.profile_id === binding.profile_id || safeUrl(other.cdp_http).origin === endpoint
    || (safeUrl(other.remote_url).origin === remote.origin && safeUrl(other.remote_url).pathname === remote.pathname)))) throw new Error('Browser profile must have exactly one account binding');
  const hosts = providerHosts[account.provider];
  if (!hosts) throw new Error('Unsupported account provider');
  safeUrl(binding.manage_url, hosts); safeUrl(binding.login_url, hosts); safeUrl(binding.remote_url);
  if (binding.proxy_account_id !== undefined && (typeof binding.proxy_account_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(binding.proxy_account_id))) throw new Error('Invalid proxy account binding');
  return { binding, account, endpoint };
}

/** Only the email field crosses CDP. No cookie reads, auth token extraction,
 * arbitrary DOM email scanning or user-controlled JavaScript is permitted. */
export function identityExpression(provider: AccountConfig['provider']): string | null {
  const origin = provider === 'claude' ? 'https://claude.ai' : provider === 'codex' ? 'https://chatgpt.com' : provider === 'cursor' ? 'https://cursor.com' : null;
  if (!origin) return null;
  const path = provider === 'claude' ? '/api/account' : provider === 'cursor' ? '/api/auth/me' : '/api/auth/session';
  const field = provider === 'claude' ? 'data?.email_address' : provider === 'cursor' ? 'data?.email' : 'data?.user?.email';
  return `(async () => {
    if (location.origin !== ${JSON.stringify(origin)}) return { state: 'unknown' };
    try {
      const response = await fetch(${JSON.stringify(path)}, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (response.status === 401 || response.status === 403) return { state: 'login_required' };
      if (!response.ok) return { state: 'unknown' };
      const data = await response.json();
      const email = ${field};
      if (typeof email === 'string') return { state: 'authenticated', email };
      return { state: ${provider === 'codex' ? "data?.user == null ? 'login_required' : 'unknown'" : "'unknown'"} };
    } catch { return { state: 'unknown' }; }
  })()`;
}

async function identity(connection: AccountBrowserConnection, targets: BrowserTarget[], account: AccountConfig): Promise<{ status: AccountBrowserStatus; verifiedEmail?: string }> {
  const expression = identityExpression(account.provider);
  if (!expression) return { status: 'identity_unknown' };
  const origin = account.provider === 'claude' ? 'https://claude.ai' : account.provider === 'cursor' ? 'https://cursor.com' : 'https://chatgpt.com';
  const pages = targets.filter(target => { try { return target.type === 'page' && new URL(target.url).origin === origin; } catch { return false; } });
  if (!pages.length) return { status: 'login_required' };
  const attached = await connection.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
  if (typeof attached.sessionId !== 'string') return { status: 'identity_unknown' };
  try {
    const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 2500 }, attached.sessionId);
    const value = result.exceptionDetails ? null : result.result?.value;
    if (value?.state === 'login_required') return { status: 'login_required' };
    if (value?.state !== 'authenticated' || !email(value.email)) return { status: 'identity_unknown' };
    return { status: normalizeEmail(value.email) === normalizeEmail(account.email) ? 'ready' : 'mismatch', verifiedEmail: value.email };
  } finally { await connection.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => undefined); }
}

async function openTab(connection: AccountBrowserConnection, binding: AccountBrowserConfig, account: AccountConfig, targets: BrowserTarget[], action: 'login' | 'manage') {
  const url = action === 'login' ? binding.login_url : binding.manage_url;
  const key = `${binding.profile_id}:${action}`;
  const known = ownedTabs.get(key);
  const target = known && known.url === url ? targets.find(target => {
    if (target.targetId !== known.id || target.type !== 'page') return false;
    // Login can be in the middle of an SSO redirect. Focus the same owned tab;
    // never navigate it or start a competing OAuth flow.
    if (action === 'login') return true;
    try { return safeUrl(target.url, providerHosts[account.provider]).href === new URL(url).href; } catch { return false; }
  }) : undefined;
  let id = target?.targetId;
  if (!id) {
    const created = await connection.send('Target.createTarget', { url, background: false });
    if (typeof created.targetId !== 'string') throw new Error('Browser did not create a tab');
    id = created.targetId;
    ownedTabs.set(key, { id, url });
  }
  await connection.send('Target.activateTarget', { targetId: id });
}

async function routingState(): Promise<unknown> {
  const base = process.env.AI_BILLS_ROUTING_URL; const token = process.env.AI_BILLS_ROUTING_TOKEN;
  if (!base || !token) return null; // Routing service retired: no linkage claim, not an outage.
  const url = safeUrl(`${base.replace(/\/$/, '')}/control/state`);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Routing state unavailable');
  return response.json();
}

export function projectBrowserProxy(value: unknown, accountId: string): AccountBrowserState['proxy'] {
  const state = value as { policy?: { version?: number; accounts?: { id: string; enabled: boolean }[] }; account_health?: { id: string; bound: boolean; quota_state: string }[] };
  const account = Array.isArray(state?.policy?.accounts) ? state.policy.accounts.find(row => row.id === accountId) : undefined;
  const health = Array.isArray(state?.account_health) ? state.account_health.find(row => row.id === accountId) : undefined;
  return { status: account ? 'linked' : 'not_found', policyVersion: typeof state?.policy?.version === 'number' ? state.policy.version : null,
    enabled: typeof account?.enabled === 'boolean' ? account.enabled : null, nativeBound: typeof health?.bound === 'boolean' ? health.bound : null,
    quotaState: typeof health?.quota_state === 'string' ? health.quota_state : null, observedAt: new Date().toISOString() };
}

const messages: Record<AccountBrowserStatus, string> = {
  unconfigured: 'No dedicated account browser is configured. A website link uses your current browser account.',
  login_required: 'Open the dedicated browser to sign in and verify the intended website account. Proxy OAuth is separate.',
  identity_unknown: 'Website identity could not be verified. Open the dedicated browser; billing navigation remains disabled.',
  mismatch: 'This browser is signed in to a different account. Recover the website login before opening billing.',
  ready: 'Website account identity matches. Proxy status and budget remain controlled by routing.',
  unavailable: 'Account browser is unavailable or its binding is invalid. Existing proxy credentials are unchanged.',
};

export async function accountBrowser(config: AppConfig, selector: AccountBrowserSelector, action?: BrowserAction, deps: Dependencies = { connect: connectAccountBrowser, routing: routingState }): Promise<AccountBrowserState> {
  let key: string;
  try {
    const resolved = resolveBrowserBinding(config, selector);
    key = JSON.stringify(resolved ? [resolved.binding, resolved.account.email] : selector);
  } catch { return observeBrowser(config, selector, action, deps); }
  if (action) return observeBrowser(config, selector, action, deps);
  const existing = readFlights.get(key);
  if (existing) return existing;
  const pending = observeBrowser(config, selector, undefined, deps).finally(() => { if (readFlights.get(key) === pending) readFlights.delete(key); });
  readFlights.set(key, pending);
  return pending;
}

async function observeBrowser(config: AppConfig, selector: AccountBrowserSelector, action: BrowserAction | undefined, deps: Dependencies): Promise<AccountBrowserState> {
  const state: AccountBrowserState = { subscriptionId: selector.subscriptionId ?? null, accountKey: selector.accountKey ?? null,
    provider: null, intendedEmail: null, configured: false, status: 'unconfigured', observedAt: null, maxAgeSeconds: 30,
    proxyAccountId: null, proxy: { status: 'unlinked', policyVersion: null, enabled: null, nativeBound: null, quotaState: null, observedAt: null }, message: messages.unconfigured };
  let resolved: ReturnType<typeof resolveBrowserBinding>;
  try { resolved = resolveBrowserBinding(config, selector); }
  catch { return { ...state, configured: true, status: 'unavailable', message: messages.unavailable }; }
  if (!resolved) return state;
  const { binding, account, endpoint } = resolved;
  Object.assign(state, { subscriptionId: binding.subscription_id ?? null, accountKey: account.key, provider: account.provider,
    intendedEmail: account.email, profileId: binding.profile_id, configured: true, remoteUrl: binding.remote_url,
    proxyAccountId: binding.proxy_account_id ?? null });
  const proxy = binding.proxy_account_id ? deps.routing().then(value => { if (value != null) state.proxy = projectBrowserProxy(value, binding.proxy_account_id!); }).catch(() => { state.proxy.status = 'unavailable'; }) : Promise.resolve();
  const previous = queues.get(binding.profile_id) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  queues.set(binding.profile_id, pending);
  await previous;
  let connection: AccountBrowserConnection | undefined;
  let lease: BrowserLease | null = null;
  let borrowedManual = false;
  try {
    const prior = manualLeases.get(binding.profile_id);
    if (prior && (action === 'close' || Date.parse(prior.expiresAt) > Date.now())) { lease = prior; borrowedManual = true; }
    else if (prior) manualLeases.delete(binding.profile_id);
    state.manualLeaseExpiresAt = lease?.expiresAt ?? null;
    if (action === 'close') {
      if (!lease) {
        Object.assign(state, { status: 'identity_unknown', message: 'No tracked browser lease; closure cannot be confirmed. An existing lease expires automatically.', observedAt: new Date().toISOString() });
        await proxy; return state;
      }
      await releaseBrowserLease(lease, true);
      manualLeases.delete(binding.profile_id);
      Object.assign(state, { status: 'identity_unknown', manualLeaseExpiresAt: null,
        message: 'Browser closed; saved sign-in is preserved.', observedAt: new Date().toISOString() });
      await proxy;
      return state;
    }
    if (action === 'renew') {
      if (!lease) throw new Error('No active manual browser lease');
      lease = await renewBrowserLease(lease); manualLeases.set(binding.profile_id, lease);
      Object.assign(state, { status: 'identity_unknown', manualLeaseExpiresAt: lease.expiresAt,
        message: 'Browser lease renewed.', observedAt: new Date().toISOString() });
      await proxy;
      return state;
    }
    if (lease && action) { lease = await renewBrowserLease(lease); manualLeases.set(binding.profile_id, lease); }
    if (!lease) lease = await acquireBrowserLease(binding.profile_id, action ? 'manual' : 'identity');
    if (action && lease) manualLeases.set(binding.profile_id, lease);
    state.manualLeaseExpiresAt = manualLeases.get(binding.profile_id)?.expiresAt ?? null;
    connection = await deps.connect(endpoint);
    const result = await connection.send('Target.getTargets');
    const targets: BrowserTarget[] = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    Object.assign(state, await identity(connection, targets, account), { observedAt: new Date().toISOString() });
    // Every manage action re-verifies identity; a cached GET never grants access.
    if (action === 'login' || (action === 'manage' && state.status === 'ready')) await openTab(connection, binding, account, targets, action);
  } catch (error) {
    // Log only our fixed CDP operation names, never provider payloads or URLs.
    const operation = error instanceof Error ? error.message.match(/Account browser ([A-Za-z.]+) (failed|timed out)/)?.[0] : null;
    console.warn(operation ?? 'Account browser operation unavailable');
    state.status = 'unavailable'; state.observedAt = new Date().toISOString();
  }
  finally {
    connection?.close();
    // Explicit manual access keeps its bounded lease while the user signs in.
    if ((!action && !borrowedManual) || (action && state.status === 'unavailable' && !borrowedManual)) {
      await releaseBrowserLease(lease);
      if (action) { manualLeases.delete(binding.profile_id); state.manualLeaseExpiresAt = null; }
    }
    release(); if (queues.get(binding.profile_id) === pending) queues.delete(binding.profile_id);
  }
  await proxy;
  state.message = messages[state.status];
  return state;
}
