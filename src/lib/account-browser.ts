import type { AccountBrowserConfig, AccountConfig, AppConfig } from './config';
import { validateCdpEndpoint } from './cdp-startup';
import { connectAccountBrowser, type AccountBrowserConnection, type BrowserTarget } from './account-browser-cdp';
import type { AccountBrowserSelector, AccountBrowserState, AccountBrowserStatus } from './account-browser-types';
import { acquireBrowserLease, releaseBrowserLease, renewBrowserLease, type BrowserLease } from './browser-lease';

export class AccountBrowserInputError extends Error {}
const providerHosts: Record<AccountConfig['provider'], string[]> = {
  claude: ['claude.ai'], codex: ['chatgpt.com', 'auth.openai.com'],
  kimi: ['www.kimi.ai', 'kimi.ai', 'www.kimi.com', 'kimi.com'], cursor: ['cursor.com', 'www.cursor.com', 'authenticator.cursor.sh'],
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
  const sharedIdentity = binding.shared_identity_email;
  if (sharedIdentity !== undefined && (!email(sharedIdentity) || normalizeEmail(sharedIdentity) !== normalizeEmail(account.email))) throw new Error('Shared browser identity must match the expected account email');
  const profilePattern = sharedIdentity === undefined ? /^ai-bills-[a-z0-9][a-z0-9-]{1,70}$/ : /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
  if (!profilePattern.test(binding.profile_id)) throw new Error('Invalid browser profile');
  const endpoint = validateCdpEndpoint({ ...account, cdp_http: binding.cdp_http });
  const remote = safeUrl(binding.remote_url);
  for (const other of bindings) {
    if (other === binding) continue;
    const otherEndpoint = safeUrl(other.cdp_http).origin;
    const otherRemote = safeUrl(other.remote_url);
    const overlaps = other.profile_id === binding.profile_id || otherEndpoint === endpoint
      || (otherRemote.origin === remote.origin && otherRemote.pathname === remote.pathname);
    if (!overlaps) continue;
    const otherAccounts = config.accounts.filter(candidate => candidate.key === other.account_key);
    if (sharedIdentity === undefined || !email(other.shared_identity_email)
      || normalizeEmail(other.shared_identity_email) !== normalizeEmail(sharedIdentity)
      || otherAccounts.length !== 1 || !email(otherAccounts[0].email)
      || normalizeEmail(otherAccounts[0].email) !== normalizeEmail(sharedIdentity)
      || other.profile_id !== binding.profile_id || otherEndpoint !== endpoint
      || validateCdpEndpoint({ ...otherAccounts[0], cdp_http: other.cdp_http }) !== endpoint
      || otherRemote.href !== remote.href) throw new Error('Conflicting shared browser binding');
    // A provider has one cookie identity inside a profile. Keep its account and
    // subscription selectors unambiguous even when other providers share it.
    if (other.account_key === binding.account_key
      || (binding.subscription_id && other.subscription_id === binding.subscription_id)
      || otherAccounts[0].provider === account.provider) throw new Error('Duplicate provider identity in shared browser');
  }
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

type Identity = { status: AccountBrowserStatus; verifiedEmail?: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** How long a probe tab may take to reach the provider's origin: well inside the connection's 12 s deadline, so the
 * tab can still be closed over the same connection afterwards. */
const PROBE_TAB_WAIT_MS = 4_000;

async function probeTab(connection: AccountBrowserConnection, targetId: string, expression: string, account: AccountConfig, loading: boolean): Promise<Identity> {
  const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  if (typeof attached.sessionId !== 'string') return { status: 'identity_unknown' };
  try {
    const deadline = Date.now() + (loading ? PROBE_TAB_WAIT_MS : 0);
    let value: { state?: string; email?: unknown } | null | undefined;
    for (;;) {
      const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 2500 }, attached.sessionId);
      value = result.exceptionDetails ? null : result.result?.value;
      // A freshly opened tab answers `unknown` until it has reached the provider's origin.
      if (value?.state !== 'unknown' || Date.now() >= deadline) break;
      await sleep(400);
    }
    if (value?.state === 'login_required') return { status: 'login_required' };
    if (value?.state !== 'authenticated' || !email(value.email)) return { status: 'identity_unknown' };
    return { status: normalizeEmail(value.email) === normalizeEmail(account.email) ? 'ready' : 'mismatch', verifiedEmail: value.email };
  } finally { await connection.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => undefined); }
}

/** `login_required` needs auth evidence: the provider answered 401/403 (or reported no user). A shared resident
 * profile without an open tab of this provider is normal, so the probe opens a background tab and closes it again. */
async function identity(connection: AccountBrowserConnection, targets: BrowserTarget[], account: AccountConfig, endpoint: string): Promise<Identity> {
  const expression = identityExpression(account.provider);
  if (!expression) return { status: 'identity_unknown' };
  const origin = account.provider === 'claude' ? 'https://claude.ai' : account.provider === 'cursor' ? 'https://cursor.com' : 'https://chatgpt.com';
  const pages = targets.filter(target => { try { return target.type === 'page' && new URL(target.url).origin === origin; } catch { return false; } });
  if (pages.length) return probeTab(connection, pages[0].targetId, expression, account, false);
  let created: string | undefined;
  try {
    const result = await connection.send('Target.createTarget', { url: `${origin}/robots.txt`, background: true });
    if (typeof result.targetId !== 'string') return { status: 'identity_unknown' };
    created = result.targetId;
    return await probeTab(connection, created, expression, account, true);
  } catch { return { status: 'identity_unknown' }; }
  finally {
    // Past the connection's deadline the CDP close cannot be sent; the endpoint's HTTP interface still closes the tab.
    if (created) await connection.send('Target.closeTarget', { targetId: created }).catch(() =>
      fetch(`${endpoint}/json/close/${encodeURIComponent(created!)}`, { signal: AbortSignal.timeout(2_000), redirect: 'error' }).catch(() => undefined));
  }
}

async function openTab(connection: AccountBrowserConnection, binding: AccountBrowserConfig, account: AccountConfig, targets: BrowserTarget[], action: 'login' | 'manage') {
  const url = action === 'login' ? binding.login_url : binding.manage_url;
  const key = JSON.stringify([binding.profile_id, account.key, account.provider, action]);
  const known = ownedTabs.get(key);
  const target = known && known.url === url ? targets.find(target => {
    if (target.targetId !== known.id || target.type !== 'page') return false;
    // Login can be in the middle of an SSO redirect. Focus the same owned tab;
    // never navigate it or start a competing OAuth flow.
    if (action === 'login') return true;
    try { return safeUrl(target.url, providerHosts[account.provider]).href === new URL(url).href; } catch { return false; }
  }) : undefined;
  // After a restart the owned-tab map is empty: focus a tab already showing this page instead of opening another one.
  let id = target?.targetId ?? (known ? undefined : targets.find(candidate => candidate.type === 'page' && candidate.url === url)?.targetId);
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

const SESSION_ENDED = 'The browser session already ended (it expired or Zecori restarted). Open the account browser to start a new one; saved sign-in is preserved.';

/** HTTP status of a browser action: an unready manage and an extend without a live lease are conflicts the person resolves by opening the browser. */
export function browserActionStatus(action: BrowserAction, state: Pick<AccountBrowserState, 'status' | 'manualLeaseExpiresAt'>): number {
  if (action === 'manage' && state.status !== 'ready') return 409;
  if (state.status === 'unavailable') return 503;
  if (action === 'renew' && !state.manualLeaseExpiresAt) return 409;
  return 200;
}

const messages: Record<AccountBrowserStatus, string> = {
  unconfigured: 'No account browser is configured. A website link uses your current browser account.',
  login_required: 'Open the account browser to sign in and verify the intended website account. Proxy OAuth is separate.',
  identity_unknown: 'Website identity could not be verified. Open the account browser; billing navigation remains disabled.',
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
        message: 'Browser access released; saved sign-in is preserved.', observedAt: new Date().toISOString() });
      await proxy;
      return state;
    }
    if (action === 'renew') {
      // The lease expired, or this process restarted and forgot it. Nothing to extend; the binding is fine.
      if (!lease) {
        Object.assign(state, { status: 'identity_unknown', manualLeaseExpiresAt: null, message: SESSION_ENDED, observedAt: new Date().toISOString() });
        await proxy; return state;
      }
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
    Object.assign(state, await identity(connection, targets, account, endpoint), { observedAt: new Date().toISOString() });
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
