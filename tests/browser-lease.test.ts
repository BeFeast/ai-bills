import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireBrowserLease, releaseBrowserLease } from '../src/lib/browser-lease';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('bounded browser ownership', () => {
  it('does nothing when the operator has not enabled lifecycle integration', async () => {
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_URL', '');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await acquireBrowserLease(undefined, 'quota')).toBeNull();
    await releaseBrowserLease(null);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('acquires only a configured profile, follows no redirects, and releases the same lease', async () => {
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_URL', 'http://lifecycle.example.test');
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_TOKEN', 'fixture-token');
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ lease_id: 'lease-one', expires_at: Date.parse('2099-01-01T00:00:00Z') / 1000 }), { status: 201 })).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const lease = await acquireBrowserLease('fixture-profile', 'quota');
    await releaseBrowserLease(lease);
    expect(fetch.mock.calls[0][0]).toBe('http://lifecycle.example.test/leases');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ profile_id: 'fixture-profile', purpose: 'quota' });
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
    expect(fetch.mock.calls[1][0]).toBe('http://lifecycle.example.test/leases/lease-one');
    expect(fetch.mock.calls[1][1].method).toBe('DELETE');
  });
  it('reports capacity contention without leaking the token or remote error body', async () => {
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_URL', 'http://lifecycle.example.test');
    vi.stubEnv('AI_BILLS_BROWSER_LIFECYCLE_TOKEN', 'fixture-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private backend detail', { status: 409 })));
    await expect(acquireBrowserLease('fixture-profile', 'manual')).rejects.toThrow('Browser busy with another account');
    await expect(acquireBrowserLease('../invalid', 'manual')).rejects.toThrow('configured profile binding');
  });
});
