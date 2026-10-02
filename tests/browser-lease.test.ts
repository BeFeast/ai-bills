import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireBrowserLease, releaseBrowserLease, renewBrowserLease, resetBrowserLeasesForTests, retryDelayMs, setBrowserLeaseRetryForTests } from '../src/lib/browser-lease';
import { FakeLifecycleOwner } from './fixtures/lifecycle-owner';

const lifecycle = () => {
  vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_URL', 'http://lifecycle.example.test');
  vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_TOKEN', 'fixture-token');
};
const owner = (workMs = 5) => {
  const fake = new FakeLifecycleOwner(workMs);
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => fake.handle(String(url), init)));
  return fake;
};
const refusal = (code: string, status = 409) => Response.json({ error: code }, { status, headers: { 'Retry-After': '30' } });
const granted = (id: string) => Response.json({ lease_id: id, expires_at: Date.parse('2099-01-01T00:00:00Z') / 1000 }, { status: 201 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  setBrowserLeaseRetryForTests({ baseMs: 2, capMs: 10, budgetMs: { quota: 2_000, identity: 400, manual: 400 }, releaseBudgetMs: 400 });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  resetBrowserLeasesForTests(); setBrowserLeaseRetryForTests(null);
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('bounded browser ownership', () => {
  it('does nothing when the operator has not enabled lifecycle integration', async () => {
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_URL', '');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await acquireBrowserLease(undefined, 'quota')).toBeNull();
    await releaseBrowserLease(null);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('acquires only a configured profile, follows no redirects, and releases the same lease', async () => {
    lifecycle();
    const fetch = vi.fn().mockResolvedValueOnce(granted('lease-one')).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const lease = await acquireBrowserLease('fixture-profile', 'quota');
    await releaseBrowserLease(lease);
    expect(fetch.mock.calls[0][0]).toBe('http://lifecycle.example.test/leases');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ profile_id: 'fixture-profile', purpose: 'quota' });
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
    expect(fetch.mock.calls[1][0]).toBe('http://lifecycle.example.test/leases/lease-one');
    expect(fetch.mock.calls[1][1].method).toBe('DELETE');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reports lasting contention as busy after its bounded retries, without leaking the token or remote error body', async () => {
    lifecycle();
    const fetch = vi.fn(async () => new Response('private backend detail', { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const started = Date.now();
    const error = await acquireBrowserLease('fixture-profile', 'manual').catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Browser busy with another account');
    expect((error as Error).message).not.toMatch(/private backend detail|fixture-token/);
    // Retried, but only within the purpose's budget.
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(acquireBrowserLease('../invalid', 'manual')).rejects.toThrow('configured profile binding');
  });
});

describe('retry policy', () => {
  it('backs off exponentially with full jitter between half and all of the capped step', () => {
    expect(retryDelayMs(0, () => 0, 250, 5_000)).toBe(125);
    expect(retryDelayMs(0, () => 1, 250, 5_000)).toBe(250);
    expect(retryDelayMs(3, () => 1, 250, 5_000)).toBe(2_000);
    expect(retryDelayMs(10, () => 1, 250, 5_000)).toBe(5_000);
    expect(retryDelayMs(10, () => 0, 250, 5_000)).toBe(2_500);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = retryDelayMs(attempt, Math.random, 250, 5_000);
      const ceiling = Math.min(5_000, 250 * 2 ** attempt);
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('retries controller_busy and profile_in_use, then logs the acquisition without the token or lease id', async () => {
    lifecycle();
    const fetch = vi.fn().mockResolvedValueOnce(refusal('controller_busy')).mockResolvedValueOnce(refusal('profile_in_use')).mockResolvedValueOnce(granted('lease-secretish'));
    vi.stubGlobal('fetch', fetch);
    const lease = await acquireBrowserLease('fixture-profile', 'quota');
    expect(lease?.id).toBe('lease-secretish');
    expect(fetch).toHaveBeenCalledTimes(3);
    const line = vi.mocked(console.info).mock.calls.map((call) => String(call[0])).find((text) => text.includes('browser lease acquire'))!;
    expect(line).toMatch(/profile=fixture-profile purpose=quota result=ok queue_ms=\d+ attempts=3 contended=controller_busy:1,profile_in_use:1 total_ms=\d+/);
    expect(line).not.toMatch(/fixture-token|lease-secretish/);
  });

  it('retries an expired lease the owner has not reaped yet, and capacity that frees up', async () => {
    lifecycle();
    const fetch = vi.fn().mockResolvedValueOnce(refusal('profile_stop_pending', 503)).mockResolvedValueOnce(refusal('capacity_busy')).mockResolvedValueOnce(granted('lease-two'));
    vi.stubGlobal('fetch', fetch);
    expect((await acquireBrowserLease('fixture-profile', 'quota'))?.id).toBe('lease-two');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry refusals that do not clear on their own', async () => {
    lifecycle();
    for (const [response, message] of [
      [refusal('unmanaged_profiles_active'), 'Browser busy with another account'],
      [refusal('insufficient_memory', 503), 'Browser lifecycle unavailable'],
      [new Response('nope', { status: 401 }), 'Browser lifecycle unavailable'],
    ] as const) {
      const fetch = vi.fn().mockResolvedValueOnce(response);
      vi.stubGlobal('fetch', fetch);
      await expect(acquireBrowserLease('fixture-profile', 'quota')).rejects.toThrow(message);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a release refused as controller_busy, so the lease does not linger until its TTL', async () => {
    lifecycle();
    const fake = owner();
    const lease = await acquireBrowserLease('fixture-profile', 'quota');
    fake.externalBusy = 2;
    await releaseBrowserLease(lease);
    expect(fake.live('fixture-profile')).toBe(0);
    expect(fake.requests.filter((request) => request.method === 'DELETE')).toHaveLength(3);
  });

  it('retries a renewal refused as controller_busy', async () => {
    lifecycle();
    const fake = owner();
    const lease = await acquireBrowserLease('fixture-profile', 'manual');
    fake.externalBusy = 1;
    const renewed = await renewBrowserLease(lease!);
    expect(renewed.id).toBe(lease!.id);
    expect(fake.requests.filter((request) => request.method === 'PATCH')).toHaveLength(2);
  });
});

describe('lease queue', () => {
  it('sends this process\'s lifecycle requests one at a time, so concurrent reads on different profiles are never refused', async () => {
    lifecycle();
    const fake = owner(10);
    const profiles = ['profile-a', 'profile-b', 'profile-c', 'profile-d'];
    const leases = await Promise.all(profiles.map((profile) => acquireBrowserLease(profile, 'quota')));
    expect(leases.every(Boolean)).toBe(true);
    await Promise.all(leases.map((lease) => releaseBrowserLease(lease)));
    expect(fake.refusals).toEqual([]);
    expect(fake.liveTotal).toBe(0);
  });

  it('lets one automatic read per profile hold a lease at a time, in arrival order', async () => {
    lifecycle();
    const fake = owner();
    const order: string[] = [];
    const read = async (name: string) => {
      const lease = await acquireBrowserLease('shared-profile', 'quota');
      order.push(`${name}:start`);
      expect(fake.live('shared-profile')).toBe(1);
      await tick();
      order.push(`${name}:end`);
      await releaseBrowserLease(lease);
    };
    await Promise.all([read('claude-work'), read('kimi'), read('cursor')]);
    expect(order).toEqual(['claude-work:start', 'claude-work:end', 'kimi:start', 'kimi:end', 'cursor:start', 'cursor:end']);
    expect(fake.refusals).toEqual([]);
    expect(fake.maxPerProfile).toBe(1);
  });

  it('a waiter that gives up does not let a newcomer jump ahead of the current holder', async () => {
    lifecycle();
    const fake = owner();
    const holder = await acquireBrowserLease('shared-profile', 'quota');
    // Identity has a short budget: it gives up while the quota read still holds the profile.
    await expect(acquireBrowserLease('shared-profile', 'identity')).rejects.toThrow('Browser busy');
    const newcomer = acquireBrowserLease('shared-profile', 'quota');
    await tick();
    expect(fake.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    await releaseBrowserLease(holder);
    await releaseBrowserLease(await newcomer);
    expect(fake.refusals).toEqual([]);
  });

  it('frees a turn whose acquisition failed', async () => {
    lifecycle();
    const fetch = vi.fn().mockResolvedValueOnce(refusal('insufficient_memory', 503)).mockResolvedValueOnce(granted('lease-after'));
    vi.stubGlobal('fetch', fetch);
    await expect(acquireBrowserLease('shared-profile', 'quota')).rejects.toThrow('Browser lifecycle unavailable');
    expect((await acquireBrowserLease('shared-profile', 'quota'))?.id).toBe('lease-after');
  });

  it('frees the profile at the lease expiry when a holder never releases', async () => {
    lifecycle();
    const fake = owner();
    fake.ttlMs = 50;
    await acquireBrowserLease('shared-profile', 'quota');
    const started = Date.now();
    const next = await acquireBrowserLease('shared-profile', 'quota');
    expect(next).not.toBeNull();
    // Waited for the expiry plus the safety second, not the whole budget.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fake.refusals).toEqual([]);
  });

  it('keeps the turn of a lease whose expiry lies beyond the timer range', async () => {
    lifecycle();
    const fetch = vi.fn().mockResolvedValueOnce(granted('far-future')).mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(granted('next'));
    vi.stubGlobal('fetch', fetch);
    const first = await acquireBrowserLease('shared-profile', 'quota');
    const second = acquireBrowserLease('shared-profile', 'quota');
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    await releaseBrowserLease(first);
    expect((await second)?.id).toBe('next');
  });

  it('fails automatic reads fast while this process holds a manual session on the profile, and resumes after it', async () => {
    lifecycle();
    const fake = owner();
    const manual = await acquireBrowserLease('shared-profile', 'manual');
    const posts = () => fake.requests.filter((request) => request.method === 'POST').length;
    await expect(acquireBrowserLease('shared-profile', 'quota')).rejects.toThrow('Browser busy');
    expect(posts()).toBe(1);
    // Another profile is unaffected.
    await releaseBrowserLease(await acquireBrowserLease('other-profile', 'quota'));
    await releaseBrowserLease(manual, true);
    await releaseBrowserLease(await acquireBrowserLease('shared-profile', 'quota'));
    expect(fake.refusals).toEqual([]);
  });

  it('a manual session waits for an automatic read in progress on the same profile', async () => {
    lifecycle();
    const fake = owner();
    const quota = await acquireBrowserLease('shared-profile', 'quota');
    const manual = acquireBrowserLease('shared-profile', 'manual');
    await tick();
    expect(fake.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    await releaseBrowserLease(quota);
    expect(await manual).not.toBeNull();
    expect(fake.refusals).toEqual([]);
  });
});
