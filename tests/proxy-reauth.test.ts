import { createHash } from 'node:crypto';
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
const USER_TAB = 'https://claude.ai/new#settings/usage';
type Call = { method: string; params?: Record<string, unknown> };

/**
 * A browser tab walking through `pages` (one entry per history poll) with claude.ai reporting `email`, and a proxy
 * that issues numbered flows. `existing` are page targets already open in the profile; `before` is history the tab
 * already had; `clicks` are the Authorize button's answers in turn (then 'clicked').
 */
const SAVED = { id: 'claude-c0ffee42-intended@example.test.json', provider: 'claude', email: 'intended@example.test', status: 'active', status_message: '', unavailable: false };

function harness({ pages, email = 'intended@example.test', identity = 'ready', authStatus = ['wait', 'ok'], existing = [], before = [], clicks = [], visibility = 'visible', files = [SAVED], navigateFails = 0 }: {
  pages: (flow: string) => string[]; email?: string | null | ((href: string, flows: number) => string | null); identity?: AccountBrowserState['status']; authStatus?: string[];
  existing?: { targetId: string; type: string; url: string }[]; before?: string[]; clicks?: string[]; visibility?: string; files?: Record<string, unknown>[];
  navigateFails?: number }) {
  let clock = 0; let flows = 0; let step = 0;
  const calls: Call[] = [];
  /** The page each Authorize press landed on, and when each navigation was sent. */
  const clickedOn: string[] = [];
  const navigatedAt: number[] = [];
  const proxyCalls: { method: string; path: string; body?: unknown }[] = [];
  const history = () => {
    const walk = pages(`flow-${flows}`);
    return [...before, ...walk.slice(0, Math.min(step, walk.length - 1) + 1)];
  };
  const connection: AccountBrowserConnection = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Target.getTargets') return { targetInfos: existing };
      if (method === 'Target.createTarget') return { targetId: 'reauth-tab' };
      if (method === 'Target.attachToTarget') return { sessionId: 's' };
      if (method === 'Page.navigate') navigatedAt.push(clock);
      if (method === 'Page.navigate' && navigateFails > 0) { navigateFails -= 1; throw new Error('Account browser Page.navigate timed out'); }
      if (method === 'Page.getNavigationHistory') { step += 1; const entries = history().map(url => ({ url })); return { entries, currentIndex: entries.length - 1 }; }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression);
        const href = history().at(-1) ?? '';
        if (expression === 'document.visibilityState') return { result: { value: visibility } };
        if (expression.includes('/api/account')) return { result: { value: typeof email === 'function' ? email(href, flows) : email } };
        const answer = clicks.length ? clicks.shift() : 'clicked';
        if (answer === 'clicked') clickedOn.push(href);
        return { result: { value: answer } };
      }
      return {};
    }),
    close: vi.fn(),
  };
  const proxy: ReauthDeps['proxy'] = vi.fn(async (method, path, body) => {
    proxyCalls.push({ method, path, body });
    if (path === '/v0/management/anthropic-auth-url') { flows += 1; step = 0; return { status: 200, body: { status: 'ok', url: `${AUTHORIZE}flow-${flows}`, state: `flow-${flows}` } }; }
    if (path === '/v0/management/oauth-callback') return { status: 200, body: { status: 'ok' } };
    if (path === '/v0/management/auth-files') return { status: 200, body: { files } };
    return { status: 200, body: { status: authStatus.shift() ?? 'ok' } };
  });
  const deps: ReauthDeps = {
    connect: vi.fn(async () => connection), proxy,
    identity: vi.fn(async () => ({ status: identity }) as AccountBrowserState),
    sleep: vi.fn(async (ms: number) => { clock += ms; }), now: () => clock,
  };
  return { deps, calls, proxyCalls, connection, clickedOn, navigatedAt, flows: () => flows };
}

afterEach(() => resetReauthJobsForTests());
const closed = (calls: Call[], targetId = 'reauth-tab') => calls.some(call => call.method === 'Target.closeTarget' && call.params?.targetId === targetId);
const navigations = (calls: Call[]) => calls.filter(call => call.method === 'Page.navigate').map(call => String(call.params?.url));
/** Navigations to a later flow's authorize page: restarts of the proxy flow. */
const restarts = (calls: Call[]) => navigations(calls).filter(url => url.startsWith(AUTHORIZE) && url !== `${AUTHORIZE}flow-1`);
const clicked = (calls: Call[]) => calls.filter(call => call.method === 'Runtime.evaluate' && String(call.params?.expression).includes('click()')).length;

describe('Reconnect proxy', () => {
  it('runs in a new tab of the visible window, authorizes only for the expected account and closes its tab', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, 'https://claude.ai/login', AUTHORIZE + flow, CALLBACK + flow] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job).toMatchObject({ state: 'succeeded', finishedAt: expect.any(String) });
    // A new window (or /json/new) is not on the account browser's screen: same window, foreground, activated.
    expect(h.calls).toContainEqual({ method: 'Target.createTarget', params: { url: `${AUTHORIZE}flow-1`, newWindow: false, background: false } });
    expect(h.calls).toContainEqual({ method: 'Target.activateTarget', params: { targetId: 'reauth-tab' } });
    expect(navigations(h.calls)).toEqual([]);
    expect(h.proxyCalls).toContainEqual({ method: 'POST', path: '/v0/management/oauth-callback', body: { redirect_url: `${CALLBACK}flow-1`, state: 'flow-1' } });
    expect(closed(h.calls)).toBe(true);
    expect(JSON.stringify(job)).not.toContain('secret-code');
  });

  it('reports which configuration links the renamed credential no longer matches, with the rename-proof id', async () => {
    const settings = config() as AppConfig & { accounting?: unknown };
    const oldFileKey = createHash('sha256').update('oauth:claude-intended@example.test.json').digest('hex').slice(0, 24);
    const stable = createHash('sha256').update('oauth-account:claude:intended@example.test').digest('hex').slice(0, 24);
    settings.accounts[0].quota_snapshot_key = oldFileKey;
    settings.account_browsers![0].proxy_account_id = oldFileKey;
    settings.accounting = { account_bindings: [{ id: oldFileKey, label: 'Personal', members: [oldFileKey], quota_account_key: 'claude-personal' }] };
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, CALLBACK + flow] });
    const job = await startProxyReauth(settings, null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('succeeded');
    // quota_snapshot_key and the binding; proxy_account_id is the routing policy's id and is not judged.
    expect(job.mappingNotes).toHaveLength(2);
    expect(job.mappingNotes!.every(note => note.includes(stable))).toBe(true);
    expect(job.mappingNotes!.some(note => note.includes('proxy_account_id'))).toBe(false);
    expect(job.message).toContain('configuration no longer links it');
    // A configuration that already uses the rename-proof id (or the new file's id) needs nothing.
    settings.accounts[0].quota_snapshot_key = stable;
    settings.account_browsers![0].proxy_account_id = createHash('sha256').update(`oauth:${SAVED.id}`).digest('hex').slice(0, 24);
    settings.accounting = { account_bindings: [{ id: oldFileKey, label: 'Personal', members: [oldFileKey, stable], quota_account_key: 'claude-personal' }] };
    const clean = await startProxyReauth(settings, null, 'claude-personal', harness({ pages: (flow) => [AUTHORIZE + flow, CALLBACK + flow] }).deps).done;
    expect(clean).toMatchObject({ state: 'succeeded', mappingNotes: [] });
    expect(clean.message).toContain('active');
  });

  it('fails when the proxy saved the sign-in but the credential is still not active', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, CALLBACK + flow], files: [{ ...SAVED, status: 'error', status_message: 'invalid grant (retrying)', unavailable: true }] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job).toMatchObject({ state: 'failed', message: expect.stringContaining('invalid grant (retrying)') });
  });

  it('borrows the claude.ai tab the person already sees and sends it back to its page instead of closing it', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, CALLBACK + flow], existing: [{ targetId: 'user-tab', type: 'page', url: USER_TAB }],
      // An earlier flow's redirect in the same tab must not be taken for this one.
      before: [USER_TAB, `${CALLBACK}flow-old`] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('succeeded');
    expect(h.calls.some(call => call.method === 'Target.createTarget')).toBe(false);
    expect(h.calls).toContainEqual({ method: 'Target.activateTarget', params: { targetId: 'user-tab' } });
    expect(navigations(h.calls).at(-1)).toBe(USER_TAB);
    expect(closed(h.calls, 'user-tab')).toBe(false);
    expect(h.proxyCalls.filter(call => call.path === '/v0/management/oauth-callback')).toEqual([
      { method: 'POST', path: '/v0/management/oauth-callback', body: { redirect_url: `${CALLBACK}flow-1`, state: 'flow-1' } }]);
  });

  it('never closes a borrowed tab, even when attaching to it fails', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], existing: [{ targetId: 'user-tab', type: 'page', url: USER_TAB }] });
    const send = (h.connection.send as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (h.connection.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Target.attachToTarget') { h.calls.push({ method, params }); throw new Error('Account browser Target.attachToTarget timed out'); }
      return send(method, params);
    });
    expect((await startProxyReauth(config(), null, 'claude-personal', h.deps).done).state).toBe('failed');
    expect(h.calls.some(call => call.method === 'Target.closeTarget')).toBe(false);
    expect(navigations(h.calls)).toEqual([]);
  });

  it('never borrows a short-lived automation tab, and fails fast when its sign-in tab is closed under it', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], existing: [{ targetId: 'quota-read', type: 'page', url: 'https://claude.ai/robots.txt' }] });
    const send = (h.connection.send as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (h.connection.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getNavigationHistory') { h.calls.push({ method, params }); throw new Error('Account browser Page.getNavigationHistory failed'); }
      return send(method, params);
    });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(h.calls.some(call => call.method === 'Target.createTarget')).toBe(true);
    expect(h.calls).not.toContainEqual({ method: 'Target.activateTarget', params: { targetId: 'quota-read' } });
    expect(job).toMatchObject({ state: 'failed', message: expect.stringContaining('tab was closed') });
    expect(h.calls.filter(call => call.method === 'Page.getNavigationHistory')).toHaveLength(5);
  });

  it('does not fail when the borrowed tab is slow to start the authorize page', async () => {
    const h = harness({ pages: (flow) => [USER_TAB, AUTHORIZE + flow, CALLBACK + flow], existing: [{ targetId: 'user-tab', type: 'page', url: USER_TAB }] });
    const send = (h.connection.send as ReturnType<typeof vi.fn>).getMockImplementation()!;
    let first = true;
    (h.connection.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.navigate' && first) { first = false; h.calls.push({ method, params }); throw new Error('Account browser Page.navigate timed out'); }
      return send(method, params);
    });
    expect((await startProxyReauth(config(), null, 'claude-personal', h.deps).done).state).toBe('succeeded');
    expect(navigations(h.calls).at(-1)).toBe(USER_TAB);
  });

  it('never presses Authorize on the previous consent page while a restart is still loading', async () => {
    // flow-1 waits for a login past its lifetime; the restart's navigation times out and the tab keeps showing flow-1.
    const h = harness({ navigateFails: 1, email: (_href, flows) => flows === 1 ? null : 'intended@example.test',
      pages: (flow) => flow === 'flow-1' ? [AUTHORIZE + 'flow-1'] : [AUTHORIZE + 'flow-1', AUTHORIZE + 'flow-1', AUTHORIZE + 'flow-1', AUTHORIZE + 'flow-2', CALLBACK + 'flow-2'] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('succeeded');
    expect(h.clickedOn).toEqual([`${AUTHORIZE}flow-2`]);
    expect(h.proxyCalls).toContainEqual({ method: 'POST', path: '/v0/management/oauth-callback', body: { redirect_url: `${CALLBACK}flow-2`, state: 'flow-2' } });
  });

  it('never presses Authorize on another client\'s consent page in a borrowed tab', async () => {
    const theirs = 'https://claude.ai/oauth/authorize?client_id=someone-else&state=theirs';
    const h = harness({ navigateFails: 1, existing: [{ targetId: 'user-tab', type: 'page', url: theirs }],
      pages: (flow) => [theirs, theirs, AUTHORIZE + flow, CALLBACK + flow] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('succeeded');
    expect(h.clickedOn).toEqual([`${AUTHORIZE}flow-1`]);
    expect(navigations(h.calls).at(-1)).toBe(theirs);
  });

  it('hands over the callback of an earlier flow this job issued, with that flow\'s state', async () => {
    // The person finishes flow-1 just after flow-2 was issued (its navigation timed out).
    const h = harness({ navigateFails: 1, email: null, pages: (flow) => flow === 'flow-1' ? [AUTHORIZE + 'flow-1'] : [AUTHORIZE + 'flow-1', CALLBACK + 'flow-1'] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('succeeded');
    expect(h.flows()).toBe(2);
    expect(h.proxyCalls).toContainEqual({ method: 'POST', path: '/v0/management/oauth-callback', body: { redirect_url: `${CALLBACK}flow-1`, state: 'flow-1' } });
  });

  it('guesses nothing when several credentials hold the e-mail: it lists the links that name no active one', async () => {
    const settings = config() as AppConfig & { accounting?: unknown };
    const other = { ...SAVED, id: 'claude-0badcafe-intended@example.test.json' };
    const otherId = createHash('sha256').update(`oauth:${other.id}`).digest('hex').slice(0, 24);
    const savedId = createHash('sha256').update(`oauth:${SAVED.id}`).digest('hex').slice(0, 24);
    const pages = (flow: string) => [AUTHORIZE + flow, CALLBACK + flow];
    // Links naming one of the e-mail's active credentials are a deliberate choice: nothing to report.
    settings.accounts[0].quota_snapshot_key = otherId;
    settings.accounting = { account_bindings: [{ id: 'b'.repeat(24), label: 'Personal', members: [otherId], quota_account_key: 'claude-personal' }] };
    expect(await startProxyReauth(settings, null, 'claude-personal', harness({ pages, files: [SAVED, other] }).deps).done).toMatchObject({ state: 'succeeded', mappingNotes: [] });
    // Stale links: both are listed with the active file ids, no single id is recommended and recovery is not promised.
    resetReauthJobsForTests();
    settings.accounts[0].quota_snapshot_key = 'f'.repeat(24);
    settings.accounting = { account_bindings: [{ id: 'b'.repeat(24), label: 'Personal', members: ['e'.repeat(24)], quota_account_key: 'claude-personal' }] };
    const stale = await startProxyReauth(settings, null, 'claude-personal', harness({ pages, files: [SAVED, other] }).deps).done;
    expect(stale.state).toBe('succeeded');
    expect(stale.mappingNotes).toEqual([
      expect.stringContaining('quota_snapshot_key names none of the active credentials of this e-mail; 2 credentials hold it'),
      expect.stringContaining('binding Personal names none of the active credentials'),
    ]);
    expect(stale.mappingNotes!.every(note => note.includes(savedId) && note.includes(otherId))).toBe(true);
    expect(stale.message).not.toContain('recovers');
  });

  it('fails when the sign-in re-authorized another organisation\'s credential while this account\'s stays dead', async () => {
    const mineDead = { ...SAVED, id: 'claude-0aaa0aaa-intended@example.test.json', status: 'error', status_message: 'invalid grant (retrying)', unavailable: true };
    const otherOrg = { ...SAVED, id: 'claude-0bbb0bbb-intended@example.test.json' };
    const deadId = createHash('sha256').update(`oauth:${mineDead.id}`).digest('hex').slice(0, 24);
    const otherId = createHash('sha256').update(`oauth:${otherOrg.id}`).digest('hex').slice(0, 24);
    const stable = createHash('sha256').update('oauth-account:claude:intended@example.test').digest('hex').slice(0, 24);
    const pages = (flow: string) => [AUTHORIZE + flow, CALLBACK + flow];
    // The account's own credential named by its quota key, or only by a binding member (the key being the stable id).
    const byKey = config(); byKey.accounts[0].quota_snapshot_key = deadId;
    const byBinding = config() as AppConfig & { accounting?: unknown }; byBinding.accounts[0].quota_snapshot_key = stable;
    byBinding.accounting = { account_bindings: [{ id: 'b'.repeat(24), label: 'Personal', members: [deadId, stable], quota_account_key: 'claude-personal' }] };
    for (const settings of [byKey, byBinding]) {
      const job = await startProxyReauth(settings, null, 'claude-personal', harness({ pages, files: [mineDead, otherOrg] }).deps).done;
      expect(job).toMatchObject({ state: 'failed', suggestAccountBrowser: true });
      expect(job.message).toContain(`did not re-authorize this account's credential (${deadId}: invalid grant (retrying))`);
      expect(job.message).not.toContain(otherId);
      expect(job.mappingNotes ?? []).toEqual([]);
      resetReauthJobsForTests();
    }
  });

  it('fails when a credential of the e-mail stays dead and no link names an active one (unlinked or rename-proof-linked accounts)', async () => {
    const mineDead = { ...SAVED, id: 'claude-0aaa0aaa-intended@example.test.json', status: 'error', status_message: 'invalid grant (retrying)', unavailable: true };
    const otherOrg = { ...SAVED, id: 'claude-0bbb0bbb-intended@example.test.json' };
    const otherId = createHash('sha256').update(`oauth:${otherOrg.id}`).digest('hex').slice(0, 24);
    const stable = createHash('sha256').update('oauth-account:claude:intended@example.test').digest('hex').slice(0, 24);
    const pages = (flow: string) => [AUTHORIZE + flow, CALLBACK + flow];
    const unlinked = config();
    const byStable = config(); byStable.accounts[0].quota_snapshot_key = stable;
    for (const settings of [unlinked, byStable]) {
      const job = await startProxyReauth(settings, null, 'claude-personal', harness({ pages, files: [mineDead, otherOrg] }).deps).done;
      expect(job).toMatchObject({ state: 'failed', suggestAccountBrowser: true });
      expect(job.message).toContain('most likely authorized another organisation');
      expect(job.message).not.toContain('recovers');
      resetReauthJobsForTests();
    }
    // The active credential named by file id is a deliberate link: the dead one belongs to someone else.
    const pinned = config(); pinned.accounts[0].quota_snapshot_key = otherId;
    expect(await startProxyReauth(pinned, null, 'claude-personal', harness({ pages, files: [mineDead, otherOrg] }).deps).done).toMatchObject({ state: 'succeeded', mappingNotes: [] });
    // Several active credentials and no link: no recovery is promised, the file ids are listed.
    resetReauthJobsForTests();
    const both = await startProxyReauth(unlinked, null, 'claude-personal', harness({ pages, files: [{ ...mineDead, status: 'active', status_message: '', unavailable: false }, otherOrg] }).deps).done;
    expect(both.state).toBe('succeeded');
    expect(both.mappingNotes).toEqual([expect.stringContaining('quota_snapshot_key is not set; 2 credentials hold it, so the card cannot use the e-mail key')]);
    expect(both.message).not.toContain('recovers');
  });

  it('re-sends a tab stuck on an older flow at most every 30 s, without asking the proxy for more flows', async () => {
    const h = harness({ navigateFails: 4, email: (_href, flows) => flows === 1 ? null : 'intended@example.test',
      pages: (flow) => flow === 'flow-1' ? [AUTHORIZE + 'flow-1'] : [...Array(70).fill(AUTHORIZE + 'flow-1'), AUTHORIZE + 'flow-2', CALLBACK + 'flow-2'] });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('succeeded');
    expect(h.flows()).toBe(2);
    expect(h.clickedOn).toEqual([`${AUTHORIZE}flow-2`]);
    const gaps = h.navigatedAt.slice(1).map((at, index) => at - h.navigatedAt[index]);
    expect(h.navigatedAt.length).toBeGreaterThanOrEqual(2);
    expect(gaps.every(gap => gap >= 30_000)).toBe(true);
  });

  it('waits for the Authorize button to become enabled before pressing it once', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, AUTHORIZE + flow, AUTHORIZE + flow, AUTHORIZE + flow, CALLBACK + flow], clicks: ['disabled', 'disabled', 'clicked'] });
    expect((await startProxyReauth(config(), null, 'claude-personal', h.deps).done).state).toBe('succeeded');
    expect(clicked(h.calls)).toBe(3);
    expect(restarts(h.calls)).toEqual([]);
  });

  it('accepts the person pressing Authorize themselves, mid-request', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, CALLBACK + flow], clicks: ['none'], email: null });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('succeeded');
    expect(job.message).not.toContain('different');
    expect(clicked(h.calls)).toBe(0);
  });

  it('says so while the sign-in tab is not on the account browser screen', async () => {
    const note = 'not be on the account browser screen';
    const messages: Record<string, string[]> = {};
    for (const visibility of ['hidden', 'visible']) {
      const h = harness({ pages: (flow) => ['https://accounts.google.com/signin', 'https://accounts.google.com/signin', CALLBACK + flow], visibility });
      const sleep = h.deps.sleep;
      let job: { message: string } | undefined;
      messages[visibility] = [];
      h.deps.sleep = vi.fn(async (ms: number) => { if (job) messages[visibility].push(job.message); await sleep(ms); });
      const running = startProxyReauth(config(), null, 'claude-personal', h.deps);
      job = running.job;
      expect((await running.done).state).toBe('succeeded');
    }
    expect(messages.hidden[0]).toContain(note);
    expect(messages.visible.some(message => message.includes(note))).toBe(false);
  });

  it('stops on a consent page of a different account without any callback', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], email: 'someone-else@example.test' });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job).toMatchObject({ state: 'failed', suggestAccountBrowser: true, remoteUrl: 'https://browser.example.test/vnc.html' });
    expect(job.message).toContain('different claude.ai account');
    expect(h.proxyCalls.some(call => call.path === '/v0/management/oauth-callback')).toBe(false);
    expect(clicked(h.calls)).toBe(0);
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

  it('restarts the proxy flow before it expires while the consent page waits, then times out and still closes the tab', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow], email: null });
    const job = await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(job.state).toBe('failed');
    expect(job.message).toContain('15 minutes');
    expect(h.flows()).toBeGreaterThanOrEqual(Math.floor(15 * 60_000 / FLOW_TTL_MS));
    expect(restarts(h.calls).length).toBe(h.flows() - 1);
    expect(navigations(h.calls).every(url => url.startsWith(AUTHORIZE))).toBe(true);
    expect(closed(h.calls)).toBe(true);
  });

  it('keeps going through a page that is mid-redirect', async () => {
    const h = harness({ pages: (flow) => [AUTHORIZE + flow, AUTHORIZE + flow, CALLBACK + flow] });
    const send = (h.connection.send as ReturnType<typeof vi.fn>).getMockImplementation()!;
    let failures = 1;
    (h.connection.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('/api/account') && failures-- > 0) { h.calls.push({ method, params }); throw new Error('Account browser Runtime.evaluate failed'); }
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
    expect(restarts(h.calls)).toEqual([]);
  });

  it('never reloads or restarts the flow while the person is on a login page', async () => {
    const h = harness({ pages: () => ['https://claude.ai/login'] });
    await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(h.flows()).toBe(1);
    expect(restarts(h.calls)).toEqual([]);
    expect(h.calls.some(call => call.method === 'Page.reload')).toBe(false);
  });

  it('never pulls the tab away from another host mid-login', async () => {
    const h = harness({ pages: () => ['https://accounts.google.com/signin'] });
    await startProxyReauth(config(), null, 'claude-personal', h.deps).done;
    expect(restarts(h.calls)).toEqual([]);
    expect(closed(h.calls)).toBe(true);
  });

  it('closes the tab when the browser fails mid-flow and reports the proxy refusing the save', async () => {
    const broken = harness({ pages: (flow) => [AUTHORIZE + flow] });
    const send = (broken.connection.send as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (broken.connection.send as ReturnType<typeof vi.fn>).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getNavigationHistory') { broken.calls.push({ method, params }); throw new Error('Account browser Page.getNavigationHistory timed out'); }
      return send(method, params);
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
