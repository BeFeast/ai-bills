import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/lib/config';
import type { AccountBrowserConnection } from '../src/lib/account-browser-cdp';
import type { AccountBrowserState } from '../src/lib/account-browser-types';
import { FLOW_TTL_MS, resetReauthJobsForTests, startProxyReauth, type ReauthDeps } from '../src/lib/proxy-reauth';

const config = (): AppConfig => ({
  accounts: [{ key: 'claude-personal', provider: 'claude', label: 'Personal', email: 'intended@example.test' }],
  account_browsers: [{ subscription_id: 'subscription-claude-personal', account_key: 'claude-personal', profile_id: 'ai-bills-claude-personal', cdp_http: 'http://127.0.0.1:18811',
    remote_url: 'https://browser.example.test/vnc.html', login_url: 'https://claude.ai/login', manage_url: 'https://claude.ai/settings/usage' }],
  proxy_management: { base_url: 'https://proxy.example.test', management_key: 'm' },
} as unknown as AppConfig);

const AUTHORIZE = 'https://claude.ai/oauth/authorize?client_id=x&state=';
const CALLBACK = 'http://localhost:54545/callback?code=secret-code&state=';

/** A browser tab walking through `pages` (one per poll) with claude.ai reporting `email`, plus a proxy that issues numbered flows. */
function harness({ pages, email = 'intended@example.test', identity = 'ready', authStatus = ['wait', 'ok'] }: { pages: (flow: string) => string[]; email?: string | null; identity?: AccountBrowserState['status']; authStatus?: string[] }) {
  let clock = 0; let flows = 0; let step = 0;
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const proxyCalls: { method: string; path: string; body?: unknown }[] = [];
  const history = () => {
    const walk = pages(`flow-${flows}`);
    return walk.slice(0, Math.min(step, walk.length - 1) + 1);
  };
  const connection: AccountBrowserConnection = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Target.createTarget') return { targetId: 'reauth-tab' };
      if (method === 'Target.attachToTarget') return { sessionId: 's' };
      if (method === 'Page.getNavigationHistory') { step += 1; const entries = history().map(url => ({ url })); return { entries, currentIndex: entries.length - 1 }; }
      if (method === 'Runtime.evaluate') return { result: { value: String(params?.expression).includes('/api/account') ? email : 'clicked' } };
      return {};
    }),
    close: vi.fn(),
  };
  const proxy: ReauthDeps['proxy'] = vi.fn(async (method, path, body) => {
    proxyCalls.push({ method, path, body });
    if (path === '/v0/management/anthropic-auth-url') { flows += 1; step = 0; return { status: 200, body: { status: 'ok', url: `${AUTHORIZE}flow-${flows}`, state: `flow-${flows}` } }; }
    if (path === '/v0/management/oauth-callback') return { status: 200, body: { status: 'ok' } };
    return { status: 200, body: { status: authStatus.shift() ?? 'ok' } };
  });
  const deps: ReauthDeps = {
    connect: vi.fn(async () => connection), proxy,
    identity: vi.fn(async () => ({ status: identity }) as AccountBrowserState),
    sleep: vi.fn(async (ms: number) => { clock += ms; }), now: () => clock,
  };
  return { deps, calls, proxyCalls, connection, flows: () => flows };
}

afterEach(() => resetReauthJobsForTests());
const closed = (calls: { method: string; params?: Record<string, unknown> }[]) => calls.some(call => call.method === 'Target.closeTarget' && call.params?.targetId === 'reauth-tab');

describe('Reconnect proxy', () => {
  it('authorizes only for the expected account, hands the callback to the proxy and closes its tab', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, 'https://claude.ai/login', AUTHORIZE + flow, CALLBACK + flow] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job).toMatchObject({ state: 'succeeded', finishedAt: expect.any(String) });
    expect(h.calls).toContainEqual({ method: 'Target.createTarget', params: { url: `${AUTHORIZE}flow-1`, background: false } });
    expect(h.proxyCalls).toContainEqual({ method: 'POST', path: '/v0/management/oauth-callback', body: { redirect_url: `${CALLBACK}flow-1`, state: 'flow-1' } });
    expect(closed(h.calls)).toBe(true);
    expect(JSON.stringify(job)).not.toContain('secret-code');
  });

  it('stops on a consent page of a different account without any callback', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], email: 'someone-else@example.test' });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job).toMatchObject({ state: 'failed', suggestAccountBrowser: true, remoteUrl: 'https://browser.example.test/vnc.html' });
    expect(job.message).toContain('different claude.ai account');
    expect(h.proxyCalls.some(call => call.path === '/v0/management/oauth-callback')).toBe(false);
    expect(h.calls.some(call => call.method === 'Runtime.evaluate' && String(call.params?.expression).includes('click()'))).toBe(false);
    expect(closed(h.calls)).toBe(true);
  });

  it('suggests the account browser and starts nothing when the profile is not signed in', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], identity: 'login_required' });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job).toMatchObject({ state: 'failed', suggestAccountBrowser: true });
    expect(job.message).toContain('Open the account browser');
    expect(h.flows()).toBe(0);
    expect(h.deps.connect).not.toHaveBeenCalled();
  });

  it('restarts the proxy flow before it expires while the authorize page waits, then times out and still closes the tab', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], email: null });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('failed');
    expect(job.message).toContain('15 minutes');
    expect(h.flows()).toBeGreaterThanOrEqual(Math.floor(15 * 60_000 / FLOW_TTL_MS));
    expect(h.calls.filter(call => call.method === 'Page.navigate').every(call => String(call.params?.url).startsWith(AUTHORIZE))).toBe(true);
    expect(closed(h.calls)).toBe(true);
  });

  it('keeps going through a page that is mid-redirect', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, AUTHORIZE + flow, CALLBACK + flow] });
    const send = (h.connection.send as ReturnType<typeof vi.fn>).getMockImplementation()!;
    let failures = 1;
    (h.connection.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && failures-- > 0) { h.calls.push({ method, params }); throw new Error('Account browser Runtime.evaluate failed'); }
      return send(method, params);
    });
    expect((await startProxyReauth(config(), null, 'claude-personal', h.deps).done).state).toBe('succeeded');
    expect(closed(h.calls)).toBe(true);
  });

  it('backs off when the proxy cannot start a new flow, and keeps the old one current until the tab shows the new one', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], email: null });
    let refuse = false;
    const proxy = h.deps.proxy as ReturnType<typeof vi.fn>;
    const issue = proxy.getMockImplementation()!;
    proxy.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (path === '/v0/management/anthropic-auth-url' && refuse) return { status: 401, body: { error: { code: 'authentication_failed' } } };
      refuse = true;
      return issue(method, path, body);
    });
    await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    const attempts = proxy.mock.calls.filter(([, path]) => path === '/v0/management/anthropic-auth-url').length;
    // 15 minutes, first restart after 4.5, then at most one try per 30 s.
    expect(attempts).toBeLessThanOrEqual(1 + Math.ceil((15 * 60_000 - FLOW_TTL_MS) / 30_000) + 1);
    expect(h.calls.some(call => call.method === 'Page.navigate')).toBe(false);
  });

  it('never restarts the flow while the person is on a login page', async () => {
    const h = harness({ pages: () => ['https://claude.ai/login'] });
    await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(h.flows()).toBe(1);
    expect(h.calls.some(call => call.method === 'Page.navigate')).toBe(false);
  });

  it('never pulls the tab away from another host mid-login', async () => {
    const h = harness({ pages: () => ['https://accounts.google.com/signin'] });
    await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(h.calls.some(call => call.method === 'Page.navigate')).toBe(false);
    expect(closed(h.calls)).toBe(true);
  });

  it('closes the tab when the browser fails mid-flow and reports the proxy refusing the save', async () => {
    const broken = harness({ pages: (flow) => [AUTHORIZE + flow] });
    (broken.connection.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      broken.calls.push({ method, params });
      if (method === 'Target.createTarget') return { targetId: 'reauth-tab' };
      if (method === 'Target.attachToTarget') return { sessionId: 's' };
      if (method === 'Page.getNavigationHistory') throw new Error('Account browser Page.getNavigationHistory timed out');
      return {};
    });
    expect((await startProxyReauth(config(), null, 'claude-personal', broken.deps).done).state).toBe('failed');
    expect(closed(broken.calls)).toBe(true);
    const refused = harness({ pages: (flow) => [AUTHORIZE + flow, CALLBACK + flow], authStatus: ['error'] });
    expect((await startProxyReauth(config(), null, 'claude-personal', refused.deps).done)).toMatchObject({ state: 'failed', message: expect.stringContaining('could not save') });
  });

  it('runs one flow per account at a time', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, CALLBACK + flow] });
    const first = startProxyReauth(config(), null, 'claude-personal', h.deps);
    const second = startProxyReauth(config(), null, 'claude-personal', h.deps);
    expect(second.job).toBe(first.job);
    await first.done;
    expect(h.flows()).toBe(1);
  });
});
