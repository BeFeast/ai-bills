import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import type { AppConfig } from '../src/lib/config';
import { accountBrowser, identityExpression, parseAccountBrowserInput, projectBrowserProxy } from '../src/lib/account-browser';
import type { AccountBrowserConnection, BrowserTarget } from '../src/lib/account-browser-cdp';
import { GET, POST } from '../src/app/api/account-browser/route';

let sequence = 0;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function config(): AppConfig {
  return { accounts: [{ key: 'personal', provider: 'claude', label: 'Personal', email: 'intended@example.test' }],
    account_browsers: [{ subscription_id: 'subscription-personal', account_key: 'personal', profile_id: `ai-bills-test-${++sequence}`,
      cdp_http: 'http://127.0.0.1:18811', remote_url: 'https://browser.example.test/vnc.html',
      login_url: 'https://claude.ai/login', manage_url: 'https://claude.ai/settings/billing', proxy_account_id: 'route-personal' }],
  } as AppConfig;
}
function browser(value: unknown, initial?: BrowserTarget[]) {
  const targets = initial ?? [{ targetId: 'unrelated', type: 'page', url: 'https://example.test/work' }, { targetId: 'provider', type: 'page', url: 'https://claude.ai/new' }];
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Target.getTargets') return { targetInfos: targets };
    if (method === 'Target.attachToTarget') return { sessionId: 'attached' };
    if (method === 'Runtime.evaluate') return { result: { value } };
    if (method === 'Target.createTarget') {
      const targetId = `created-${targets.length}`;
      targets.push({ targetId, type: 'page', url: String(params?.url) });
      return { targetId };
    }
    return {};
  });
  const close = vi.fn();
  const connection = { send, close } as AccountBrowserConnection;
  const connect = vi.fn(async () => connection);
  const routing = vi.fn(async () => ({ policy: { version: 9, accounts: [{ id: 'route-personal', enabled: false }] },
    account_health: [{ id: 'route-personal', bound: true, quota_state: 'unknown' }], budget: { secretOrInternalField: 'do-not-forward' } }));
  return { connect, routing, send, close, targets };
}

function sharedConfig(): AppConfig {
  const settings = config();
  settings.accounts.push({ key: 'chat', provider: 'codex', label: 'Chat', email: 'intended@example.test' });
  settings.account_browsers![0].shared_identity_email = 'INTENDED@example.test';
  settings.account_browsers!.push({ ...settings.account_browsers![0], account_key: 'chat', subscription_id: 'subscription-chat',
    login_url: 'https://chatgpt.com/auth/login', manage_url: 'https://chatgpt.com/' });
  return settings;
}

describe('explicit shared browser identity', () => {
  it('keeps provider identity checks independent and billing blocked on mismatch', async () => {
    const settings = sharedConfig(); settings.account_browsers!.forEach(b => { b.profile_id = `identity_${sequence}`; });
    const deps = browser({ state: 'authenticated', email: 'intended@example.test' });
    expect((await accountBrowser(settings, { accountKey: 'personal' }, 'manage', deps)).status).toBe('ready');
    // A matching Claude session says nothing about the ChatGPT session.
    expect((await accountBrowser(settings, { accountKey: 'chat' }, 'manage', deps)).status).toBe('login_required');
    deps.targets.push({ targetId: 'chat-page', type: 'page', url: 'https://chatgpt.com/' });
    const wrong = browser({ state: 'authenticated', email: 'different@example.test' }, deps.targets);
    expect((await accountBrowser(settings, { accountKey: 'chat' }, 'manage', wrong)).status).toBe('mismatch');
    expect(wrong.send.mock.calls.some(([method]) => /createTarget|activateTarget/.test(method))).toBe(false);
  });

  it('reuses each provider login tab across redirects without stealing another provider tab', async () => {
    const settings = sharedConfig(); const deps = browser(null, []);
    await accountBrowser(settings, { accountKey: 'personal' }, 'login', deps);
    const claudeTab = deps.targets[0]; claudeTab.url = 'https://accounts.google.com/signin/oauth';
    await accountBrowser(settings, { accountKey: 'chat' }, 'login', deps);
    const chatTab = deps.targets[1]; chatTab.url = 'https://accounts.google.com/signin/oauth';
    await accountBrowser(settings, { accountKey: 'personal' }, 'login', deps);
    expect(deps.send).toHaveBeenLastCalledWith('Target.activateTarget', { targetId: claudeTab.targetId });
    await accountBrowser(settings, { accountKey: 'chat' }, 'login', deps);
    expect(deps.send).toHaveBeenLastCalledWith('Target.activateTarget', { targetId: chatTab.targetId });
    expect(deps.send.mock.calls.filter(([method]) => method === 'Target.createTarget')).toHaveLength(2);
  });

  it('serializes different provider operations on their shared browser', async () => {
    const settings = sharedConfig(); const deps = browser(null, []);
    let unblock!: () => void; const gate = new Promise<void>(resolve => { unblock = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    deps.connect.mockImplementationOnce(async () => { entered(); await gate; return { send: deps.send, close: deps.close }; });
    const first = accountBrowser(settings, { accountKey: 'personal' }, 'login', deps);
    await started;
    const second = accountBrowser(settings, { accountKey: 'chat' }, 'login', deps);
    await Promise.resolve(); await Promise.resolve();
    expect(deps.connect).toHaveBeenCalledOnce();
    unblock(); await Promise.all([first, second]);
    expect(deps.connect).toHaveBeenCalledTimes(2);
  });

  it('shares the bounded manual lease and closes the whole profile from either binding', async () => {
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_URL', 'http://lifecycle.example.test');
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_TOKEN', 'fixture-token');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ lease_id: 'shared-lease', expires_at: 4070908800 })));
    vi.stubGlobal('fetch', fetch);
    const settings = sharedConfig(); const deps = browser(null, []);
    const opened = await accountBrowser(settings, { accountKey: 'personal' }, 'login', deps);
    const shared = await accountBrowser(settings, { accountKey: 'chat' }, 'login', deps);
    expect(shared.manualLeaseExpiresAt).toBe(opened.manualLeaseExpiresAt);
    expect(fetch.mock.calls.map(call => (call as unknown as [string, RequestInit])[1].method)).toEqual(['POST', 'PATCH']);
    await accountBrowser(settings, { accountKey: 'chat' }, 'close', deps);
    expect((await accountBrowser(settings, { accountKey: 'personal' }, 'close', deps)).message).toContain('closure cannot be confirmed');
    expect(fetch.mock.calls.map(call => (call as unknown as [string, RequestInit])[1].method)).toEqual(['POST', 'PATCH', 'DELETE']);
  });

  it('rejects implicit sharing and conflicting resource or identity declarations before connection', async () => {
    for (const alter of [
      (c: AppConfig) => { delete c.account_browsers![1].shared_identity_email; },
      (c: AppConfig) => { c.account_browsers![1].shared_identity_email = 'other@example.test'; },
      (c: AppConfig) => { c.accounts[1].email = 'other@example.test'; },
      (c: AppConfig) => { c.account_browsers![1].profile_id = 'ai-bills-other'; },
      (c: AppConfig) => { c.account_browsers![1].cdp_http = 'http://127.0.0.1:18812'; },
      (c: AppConfig) => { c.account_browsers![1].cdp_http += '/unexpected'; },
      (c: AppConfig) => { c.account_browsers![1].remote_url += '?other-session=1'; },
      (c: AppConfig) => { c.accounts[1].provider = 'claude'; },
    ]) {
      const settings = sharedConfig(); alter(settings); const deps = browser(null, []);
      for (const accountKey of ['personal', 'chat']) {
        expect((await accountBrowser(settings, { accountKey }, 'login', deps)).status).toBe('unavailable');
      }
      expect(deps.connect).not.toHaveBeenCalled();
    }
  });
});

describe('account-specific website management', () => {
  it('does not claim a browser closed when this process has no tracked lease', async () => {
    const deps = browser({ state: 'authenticated', email: 'intended@example.test' });
    const state = await accountBrowser(config(), { accountKey: 'personal' }, 'close', deps);
    expect(state.message).toContain('closure cannot be confirmed');
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('reuses a manual lease, renews it explicitly, and releases it before another account opens', async () => {
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_URL', 'http://lifecycle.example.test');
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_TOKEN', 'fixture-token');
    let active = false; let opens = 0; let closes = 0;
    const expiry = Date.parse('2099-01-01T00:00:00Z') / 1000;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'POST') { if (active) return new Response('{}', { status: 409 }); active = true; opens++; }
      if (options.method === 'DELETE') { active = false; closes++; return new Response('{}'); }
      return new Response(JSON.stringify({ lease_id: 'fixture-lease', expires_at: expiry }));
    });
    vi.stubGlobal('fetch', fetch);
    const settings = config(); const deps = browser({ state: 'authenticated', email: 'intended@example.test' });
    const first = await accountBrowser(settings, { accountKey: 'personal' }, 'manage', deps);
    expect(first.manualLeaseExpiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect((await accountBrowser(settings, { accountKey: 'personal' }, 'manage', deps)).status).toBe('ready');
    expect(opens).toBe(1);
    await accountBrowser(settings, { accountKey: 'personal' }, 'renew', deps);
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(2);
    const closed = await accountBrowser(settings, { accountKey: 'personal' }, 'close', deps);
    expect(closed.manualLeaseExpiresAt).toBeNull(); expect(closes).toBe(1);
    expect((await accountBrowser(config(), { accountKey: 'personal' }, 'manage', deps)).status).toBe('ready');
    expect(opens).toBe(2);
  });

  it('reads identity and current exact proxy linkage without navigation or budget writes', async () => {
    const deps = browser({ state: 'authenticated', email: 'INTENDED@example.test' });
    const before = JSON.stringify(deps.targets);
    const state = await accountBrowser(config(), { subscriptionId: 'subscription-personal' }, undefined, deps);
    expect(state).toMatchObject({ status: 'ready', intendedEmail: 'intended@example.test', verifiedEmail: 'INTENDED@example.test', maxAgeSeconds: 30,
      proxy: { status: 'linked', policyVersion: 9, enabled: false, nativeBound: true, quotaState: 'unknown' } });
    expect(state.observedAt).toBeTruthy();
    expect(JSON.stringify(deps.targets)).toBe(before);
    expect(deps.send.mock.calls.some(([method]) => /createTarget|activateTarget|navigate|closeTarget/.test(method))).toBe(false);
    expect(JSON.stringify(state)).not.toContain('do-not-forward');
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it('opens and reuses only its own billing tab, preserving unrelated tabs', async () => {
    const settings = config(); const deps = browser({ state: 'authenticated', email: 'intended@example.test' });
    await accountBrowser(settings, { accountKey: 'personal' }, 'manage', deps);
    await accountBrowser(settings, { accountKey: 'personal' }, 'manage', deps);
    expect(deps.send.mock.calls.filter(([method]) => method === 'Target.createTarget')).toEqual([
      ['Target.createTarget', { url: 'https://claude.ai/settings/billing', background: false }],
    ]);
    expect(deps.targets[0]).toEqual({ targetId: 'unrelated', type: 'page', url: 'https://example.test/work' });
    expect(deps.send.mock.calls.some(([method]) => method === 'Page.navigate' || method === 'Target.closeTarget')).toBe(false);
    const previousBilling = deps.targets[deps.targets.length - 1];
    previousBilling.url = 'https://claude.ai/new';
    await accountBrowser(settings, { accountKey: 'personal' }, 'manage', deps);
    expect(previousBilling.url).toBe('https://claude.ai/new');
    expect(deps.send.mock.calls.filter(([method]) => method === 'Target.createTarget')).toHaveLength(2);
  });

  it('rechecks a changed account on manage and blocks billing on mismatch', async () => {
    const settings = config();
    expect((await accountBrowser(settings, { accountKey: 'personal' }, undefined, browser({ state: 'authenticated', email: 'intended@example.test' }))).status).toBe('ready');
    const deps = browser({ state: 'authenticated', email: 'different@example.test' });
    const state = await accountBrowser(settings, { accountKey: 'personal' }, 'manage', deps);
    expect(state.status).toBe('mismatch');
    expect(state.remoteUrl).toBe('https://browser.example.test/vnc.html');
    expect(deps.send.mock.calls.some(([method]) => method === 'Target.createTarget' || method === 'Target.activateTarget')).toBe(false);
    await accountBrowser(settings, { accountKey: 'personal' }, 'login', deps);
    expect(deps.send).toHaveBeenCalledWith('Target.createTarget', { url: 'https://claude.ai/login', background: false });
  });

  it('coalesces simultaneous subscription/account checks and reuses a redirected login tab', async () => {
    const settings = config(); const deps = browser({ state: 'authenticated', email: 'intended@example.test' });
    const states = await Promise.all([
      accountBrowser(settings, { subscriptionId: 'subscription-personal' }, undefined, deps),
      accountBrowser(settings, { accountKey: 'personal' }, undefined, deps),
    ]);
    expect(states.map(state => state.status)).toEqual(['ready', 'ready']);
    expect(deps.connect).toHaveBeenCalledOnce();
    await accountBrowser(settings, { accountKey: 'personal' }, 'login', deps);
    const owned = deps.targets[deps.targets.length - 1];
    owned.url = 'https://accounts.google.com/signin/oauth';
    await accountBrowser(settings, { accountKey: 'personal' }, 'login', deps);
    expect(deps.send.mock.calls.filter(([method]) => method === 'Target.createTarget')).toHaveLength(1);
    expect(deps.send).toHaveBeenLastCalledWith('Target.activateTarget', { targetId: owned.targetId });
  });

  it('handles a new empty profile as login required, while unsupported identity stays unknown', async () => {
    const settings = config(); const blank = browser(null, []);
    const state = await accountBrowser(settings, { accountKey: 'personal' }, undefined, blank);
    expect(state.status).toBe('login_required');
    expect(blank.send.mock.calls.some(([method]) => method === 'Target.createTarget')).toBe(false);
    await accountBrowser(settings, { accountKey: 'personal' }, 'login', blank);
    expect(blank.send).toHaveBeenCalledWith('Target.createTarget', { url: 'https://claude.ai/login', background: false });
    settings.accounts[0].provider = 'kimi';
    Object.assign(settings.account_browsers![0], { login_url: 'https://www.kimi.com/', manage_url: 'https://www.kimi.com/code/console' });
    expect((await accountBrowser(settings, { accountKey: 'personal' }, 'manage', browser(null, []))).status).toBe('identity_unknown');
  });

  it('fails closed on invalid provider URLs, shared profiles and missing expected email before connecting', async () => {
    for (const alter of [
      (c: AppConfig) => { c.account_browsers![0].manage_url = 'https://claude.ai.evil.test/settings'; },
      (c: AppConfig) => { c.account_browsers![0].login_url = 'http://169.254.169.254/latest'; },
      (c: AppConfig) => { c.account_browsers![0].cdp_http = 'http://user:pass@127.0.0.1:18811'; },
      (c: AppConfig) => { c.account_browsers!.push({ ...c.account_browsers![0], subscription_id: 'other', account_key: 'other' }); },
      (c: AppConfig) => { c.account_browsers!.push({ ...c.account_browsers![0], subscription_id: 'other', account_key: 'other', profile_id: 'ai-bills-other', cdp_http: 'http://127.0.0.1:18812', remote_url: 'https://browser.example.test/vnc.html?autoconnect=false' }); },
      (c: AppConfig) => { c.accounts[0].email = ''; },
    ]) {
      const settings = config(); alter(settings); const deps = browser(null);
      expect((await accountBrowser(settings, { subscriptionId: 'subscription-personal' }, 'login', deps)).status).toBe('unavailable');
      expect(deps.connect).not.toHaveBeenCalled();
    }
  });

  it('retains website state while routing is unavailable and never invents proxy linkage', async () => {
    const settings = config(); const deps = browser({ state: 'authenticated', email: 'intended@example.test' });
    deps.routing.mockRejectedValueOnce(new Error('offline'));
    expect(await accountBrowser(settings, { accountKey: 'personal' }, undefined, deps)).toMatchObject({ status: 'ready', proxy: { status: 'unavailable', policyVersion: null } });
    deps.routing.mockResolvedValueOnce(null as never);
    expect(await accountBrowser(settings, { accountKey: 'personal' }, undefined, deps)).toMatchObject({ status: 'ready', proxy: { status: 'unlinked' } });
    delete settings.account_browsers![0].proxy_account_id;
    expect(await accountBrowser(settings, { accountKey: 'personal' }, undefined, deps)).toMatchObject({ status: 'ready', proxy: { status: 'unlinked' } });
    expect(projectBrowserProxy({ policy: { version: 10, accounts: [{ id: 'different', enabled: true }] } }, 'expected')).toMatchObject({ status: 'not_found', enabled: null });
  });

  it('selects only provider identity email from responses and rejects changed origins', async () => {
    for (const provider of ['claude', 'codex', 'cursor'] as const) {
      const response = provider === 'claude' ? { email_address: 'intended@example.test', accessToken: 'secret' } : provider === 'cursor' ? { email: 'intended@example.test', id: 'private-id' } : { user: { email: 'intended@example.test' }, accessToken: 'secret' };
      const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }));
      const origin = provider === 'claude' ? 'https://claude.ai' : provider === 'cursor' ? 'https://cursor.com' : 'https://chatgpt.com';
      const result = await runInNewContext(identityExpression(provider)!, { location: { origin }, fetch, AbortSignal });
      expect(result).toEqual({ state: 'authenticated', email: 'intended@example.test' });
      expect(fetch).toHaveBeenCalledWith(provider === 'claude' ? '/api/account' : provider === 'cursor' ? '/api/auth/me' : '/api/auth/session', expect.objectContaining({ credentials: 'include', redirect: 'error' }));
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('private-id');
      fetch.mockClear();
      expect(await runInNewContext(identityExpression(provider)!, { location: { origin: 'https://evil.test' }, fetch, AbortSignal })).toEqual({ state: 'unknown' });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('rejects untrusted URLs/commands and cross-origin actions at the request boundary', async () => {
    expect(() => parseAccountBrowserInput({ accountKey: 'personal', url: 'http://169.254.169.254' }, true)).toThrow();
    expect(() => parseAccountBrowserInput({ accountKey: 'personal', subscriptionId: 'also' })).toThrow();
    expect(() => parseAccountBrowserInput({ accountKey: 'personal', action: 'navigate' }, true)).toThrow();
    const denied = await POST(new Request('http://dashboard.test/api/account-browser', { method: 'POST', headers: { Origin: 'http://evil.test' }, body: JSON.stringify({ accountKey: 'personal', action: 'login' }) }));
    expect(denied.status).toBe(403);
    expect((await GET(new Request('http://dashboard.test/api/account-browser?url=http://evil.test'))).status).toBe(400);
  });
});
