import type { AppConfig } from './config';
import { accountBrowser, resolveBrowserBinding } from './account-browser';
import { connectAccountBrowser, type AccountBrowserConnection } from './account-browser-cdp';
import { acquireBrowserLease, releaseBrowserLease } from './browser-lease';
import { resolveSecret } from './infisical';

/**
 * "Reconnect proxy": the proxy's own Claude OAuth flow, driven through the account's signed-in resident browser profile.
 *
 * The proxy hands out an authorize URL and waits (about five minutes) for its callback. The flow opens that URL in a
 * foreground tab of the account's profile, where claude.ai usually sends it through its login page first; the person
 * signs in there through the account browser. Authorize is clicked only on claude.ai's consent page and only while
 * claude.ai's own `/api/account` reports the expected e-mail; anything else stops the flow without a callback. The
 * callback to the proxy's localhost redirect never loads, but the tab's navigation history keeps its URL, which is
 * handed to the proxy. The tab is closed in every outcome. Started only by a person, one flow per account at a time.
 */
export type ReauthState = 'checking' | 'waiting_for_login' | 'authorizing' | 'exchanging' | 'succeeded' | 'failed';
export type ReauthJob = { accountKey: string; state: ReauthState; message: string; startedAt: string; finishedAt: string | null;
  /** Where the person signs in when the flow waits for, or stopped on, the website login. */
  remoteUrl: string | null; suggestAccountBrowser: boolean };

const CALLBACK_PREFIX = 'http://localhost:54545/callback';
/** The proxy forgets a flow after about five minutes; restart a little before that. */
export const FLOW_TTL_MS = 270_000;
export const WINDOW_MS = 15 * 60_000;
const STATUS_POLL_MS = 2_000;
const FLOW_RETRY_MS = 30_000;
const STATUS_TIMEOUT_MS = 90_000;

type ProxyAnswer = { status: number; body: Record<string, unknown> };
export type ReauthDeps = {
  connect: (endpoint: string) => Promise<AccountBrowserConnection>;
  proxy: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<ProxyAnswer>;
  identity: typeof accountBrowser;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const jobs = new Map<string, ReauthJob>();
const slot = (scope: string | null, accountKey: string) => `${scope ?? ''}\u0000${accountKey}`;
export const reauthJob = (scope: string | null, accountKey: string): ReauthJob | null => jobs.get(slot(scope, accountKey)) ?? null;
export const reauthConfigured = (config: AppConfig) => Boolean(config.proxy_management?.base_url && config.proxy_management.management_key);

function proxyClient(config: AppConfig): ReauthDeps['proxy'] {
  return async (method, path, body) => {
    const settings = config.proxy_management;
    if (!settings) throw new Error('Proxy management is not configured');
    const base = new URL(settings.base_url);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid proxy management URL');
    const [managementKey, clientKey] = await Promise.all([resolveSecret(settings.management_key), resolveSecret(settings.client_key)]);
    if (!managementKey) throw new Error('Proxy management key is unavailable');
    const response = await fetch(new URL(path, base), { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { 'X-Management-Key': managementKey, ...(clientKey ? { 'X-Api-Key': clientKey } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed = await response.json().catch(() => ({}));
    return { status: response.status, body: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {} };
  };
}

const defaultDeps = (config: AppConfig): ReauthDeps => ({
  connect: (endpoint) => connectAccountBrowser(endpoint, WINDOW_MS + 5 * 60_000),
  proxy: proxyClient(config), identity: accountBrowser,
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now });

const host = (value: string) => { try { return new URL(value).host; } catch { return ''; } };

/** Starts the flow unless one is already running for the account; returns the job to poll. */
export function startProxyReauth(config: AppConfig, scope: string | null, accountKey: string, deps: ReauthDeps = defaultDeps(config)): { job: ReauthJob; done: Promise<ReauthJob> } {
  const key = slot(scope, accountKey);
  const running = jobs.get(key);
  if (running && !running.finishedAt) return { job: running, done: Promise.resolve(running) };
  const job: ReauthJob = { accountKey, state: 'checking', message: 'Checking the account browser identity', startedAt: new Date(deps.now()).toISOString(), finishedAt: null, remoteUrl: null, suggestAccountBrowser: false };
  jobs.set(key, job);
  const done = runReauth(config, job, deps).catch((error) => {
    finish(job, deps, 'failed', error instanceof Error ? error.message : 'Proxy reconnect failed');
    return job;
  });
  return { job, done };
}

function finish(job: ReauthJob, deps: ReauthDeps, state: 'succeeded' | 'failed', message: string, suggestAccountBrowser = false) {
  Object.assign(job, { state, message, suggestAccountBrowser, finishedAt: new Date(deps.now()).toISOString() });
  // The account's event line: outcome and time only; never URLs, codes or keys.
  console.info(`[zecori] proxy reconnect ${job.accountKey}: ${state} — ${message}`);
}

async function startFlow(deps: ReauthDeps): Promise<{ url: string; state: string; at: number }> {
  const answer = await deps.proxy('GET', '/v0/management/anthropic-auth-url');
  const url = typeof answer.body.url === 'string' ? answer.body.url : '';
  const state = typeof answer.body.state === 'string' ? answer.body.state : '';
  if (answer.status !== 200 || !url || !state) throw new Error(`The proxy did not start an OAuth flow (HTTP ${answer.status}${typeof (answer.body.error as { code?: unknown } | undefined)?.code === 'string' ? `, ${(answer.body.error as { code: string }).code}` : ''})`);
  // The tab is only ever sent to claude.ai's own authorize page.
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.host !== 'claude.ai' || !parsed.pathname.startsWith('/oauth/authorize')) throw new Error('The proxy returned an unexpected authorize URL');
  return { url, state, at: deps.now() };
}

const ACCOUNT_EMAIL = `fetch('/api/account', { credentials: 'include', cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => j && typeof j.email_address === 'string' ? j.email_address : null).catch(() => null)`;
const CLICK_AUTHORIZE = `(() => { const button = [...document.querySelectorAll('button')].find(b => /^(authori[sz]e|allow)$/i.test((b.innerText || '').trim())); if (!button) return 'none'; if (button.disabled) return 'disabled'; button.click(); return 'clicked'; })()`;

async function runReauth(config: AppConfig, job: ReauthJob, deps: ReauthDeps): Promise<ReauthJob> {
  const resolved = resolveBrowserBinding(config, { accountKey: job.accountKey });
  if (!resolved || resolved.account.provider !== 'claude') { finish(job, deps, 'failed', 'No Claude account browser is configured for this account'); return job; }
  const { binding, account, endpoint } = resolved;
  job.remoteUrl = binding.remote_url;
  const expected = account.email.trim().toLowerCase();
  const identity = await deps.identity(config, { accountKey: job.accountKey });
  if (identity.status !== 'ready') {
    const message = identity.status === 'login_required' ? 'claude.ai is not signed in in the account browser. Open the account browser, sign in, then reconnect.'
      : identity.status === 'mismatch' ? 'The account browser is signed in to a different claude.ai account. Open the account browser and switch accounts first.'
      : 'The account browser identity could not be verified. Open the account browser and check the claude.ai sign-in.';
    finish(job, deps, 'failed', message, true); return job;
  }
  const lease = await acquireBrowserLease(binding.profile_id, 'manual');
  let connection: AccountBrowserConnection | undefined;
  let tab: string | undefined;
  let callback: string | null = null;
  let flow: { url: string; state: string; at: number };
  try {
    flow = await startFlow(deps);
    connection = await deps.connect(endpoint);
    const created = await connection.send('Target.createTarget', { url: flow.url, background: false });
    if (typeof created.targetId !== 'string') throw new Error('The browser did not open the authorize tab');
    tab = created.targetId;
    await connection.send('Target.activateTarget', { targetId: tab });
    const attached = await connection.send('Target.attachToTarget', { targetId: tab, flatten: true });
    const session = typeof attached.sessionId === 'string' ? attached.sessionId : undefined;
    if (!session) throw new Error('The browser did not attach to the authorize tab');
    const evaluate = async (expression: string) => (await connection!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session)).result?.value;
    const deadline = deps.now() + WINDOW_MS;
    let clickedFor: string | null = null;
    let retryFlowAt = 0;
    while (deps.now() < deadline) {
      try {
        const history = await connection.send('Page.getNavigationHistory', {}, session);
        const entries: { url?: string }[] = Array.isArray(history.entries) ? history.entries : [];
        callback = entries.map(entry => entry.url ?? '').find(url => url.startsWith(CALLBACK_PREFIX)) ?? null;
        if (callback) break;
        const href = entries[typeof history.currentIndex === 'number' ? history.currentIndex : entries.length - 1]?.url ?? '';
        const onClaude = host(href) === 'claude.ai';
        const onAuthorize = onClaude && new URL(href).pathname.startsWith('/oauth/authorize');
        // Restart only on the authorize page itself: never mid-login on claude.ai's own login page or another host.
        if (deps.now() - flow.at > FLOW_TTL_MS && clickedFor !== flow.state && onAuthorize && deps.now() >= retryFlowAt) {
          // A failed restart is retried after a pause, not every second; the old flow stays current until the tab shows the new one.
          retryFlowAt = deps.now() + FLOW_RETRY_MS;
          const next = await startFlow(deps);
          await connection.send('Page.navigate', { url: next.url }, session);
          flow = next;
        } else if (onAuthorize && clickedFor !== flow.state) {
          const email = await evaluate(ACCOUNT_EMAIL);
          if (typeof email !== 'string') {
            Object.assign(job, { state: 'waiting_for_login', message: 'Sign in to claude.ai in the account browser; the reconnect continues by itself.', suggestAccountBrowser: true });
          } else if (email.trim().toLowerCase() !== expected) {
            finish(job, deps, 'failed', 'The consent page belongs to a different claude.ai account; nothing was authorized. Open the account browser and switch accounts.', true);
            return job;
          } else if (await evaluate(CLICK_AUTHORIZE) === 'clicked') {
            clickedFor = flow.state;
            Object.assign(job, { state: 'authorizing', message: 'Authorized for the expected account; waiting for the proxy callback', suggestAccountBrowser: false });
          }
        } else if (onClaude && clickedFor !== flow.state) {
          Object.assign(job, { state: 'waiting_for_login', message: 'Sign in to claude.ai in the account browser; the reconnect continues by itself.', suggestAccountBrowser: true });
        }
      } catch (error) {
        // A page in the middle of a redirect (destroyed context, slow evaluate) is "not yet"; a dead connection is not.
        if (error instanceof Error && /connection closed|deadline exceeded|send failed/i.test(error.message)) throw error;
      }
      await deps.sleep(1_000);
    }
  } finally {
    if (tab && connection) await connection.send('Target.closeTarget', { targetId: tab }).catch(() => undefined);
    connection?.close();
    await releaseBrowserLease(lease);
  }
  if (!callback) { finish(job, deps, 'failed', 'No sign-in completed within 15 minutes; nothing was changed.', true); return job; }
  if (new URL(callback).searchParams.get('state') !== flow.state) { finish(job, deps, 'failed', 'The callback did not belong to this flow; nothing was handed to the proxy.'); return job; }
  Object.assign(job, { state: 'exchanging', message: 'Handing the authorization to the proxy' });
  const handed = await deps.proxy('POST', '/v0/management/oauth-callback', { redirect_url: callback, state: flow.state });
  if (handed.status !== 200) { finish(job, deps, 'failed', `The proxy rejected the callback (HTTP ${handed.status})`); return job; }
  const until = deps.now() + STATUS_TIMEOUT_MS;
  while (deps.now() < until) {
    const status = await deps.proxy('GET', `/v0/management/get-auth-status?state=${encodeURIComponent(flow.state)}`);
    if (status.body.status === 'ok') { finish(job, deps, 'succeeded', 'Proxy credential re-authorized; quota recovers with the next collector run.'); return job; }
    if (status.body.status === 'error') { finish(job, deps, 'failed', `The proxy could not save the credential${typeof status.body.error === 'string' ? `: ${status.body.error.slice(0, 200)}` : ''}`); return job; }
    await deps.sleep(STATUS_POLL_MS);
  }
  finish(job, deps, 'failed', 'The proxy did not confirm the new credential within 90 seconds.');
  return job;
}

/** Test hook. */
export function resetReauthJobsForTests(): void { jobs.clear(); }
