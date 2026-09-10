/** Server-only integration with the bounded browser lifecycle owner. */
export type BrowserLease = { id: string; expiresAt: string };
type Purpose = 'quota' | 'identity' | 'manual';

function settings() {
  const base = process.env.AI_BILLS_BROWSER_LIFECYCLE_URL;
  if (!base) return null;
  const token = process.env.AI_BILLS_BROWSER_LIFECYCLE_TOKEN;
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !token) {
    throw new Error('Browser lifecycle configuration is incomplete');
  }
  return { base: base.replace(/\/$/, ''), token };
}

export async function acquireBrowserLease(profileId: string | undefined, purpose: Purpose): Promise<BrowserLease | null> {
  const config = settings();
  if (!config) return null; // Existing operator-owned lifecycle remains compatible.
  if (!profileId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(profileId)) {
    throw new Error('Automatic browser source needs a configured profile binding');
  }
  const response = await fetch(`${config.base}/leases`, { method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id: profileId, purpose }), cache: 'no-store',
    redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    if (response.status === 409) throw new Error('Browser busy with another account; automatic refresh will retry');
    throw new Error('Browser lifecycle unavailable; other account sources continue updating');
  }
  const value = await response.json();
  const expires = typeof value?.expires_at === 'number' ? value.expires_at * 1000 : Date.parse(value?.expires_at);
  if (typeof value?.lease_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.lease_id)
    || !Number.isFinite(expires) || expires <= Date.now()) {
    throw new Error('Browser lifecycle returned an invalid lease');
  }
  return { id: value.lease_id, expiresAt: new Date(expires).toISOString() };
}

export async function renewBrowserLease(lease: BrowserLease): Promise<BrowserLease> {
  const config = settings();
  if (!config) throw new Error('Browser lifecycle is not enabled');
  const response = await fetch(`${config.base}/leases/${encodeURIComponent(lease.id)}`, { method: 'PATCH',
    headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error',
    signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!response.ok) throw new Error('Browser lease could not be renewed; close it before opening another account');
  const value = await response.json();
  const expires = typeof value?.expires_at === 'number' ? value.expires_at * 1000 : Date.parse(value?.expires_at);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Browser lease renewal returned an invalid expiry');
  return { id: lease.id, expiresAt: new Date(expires).toISOString() };
}

export async function releaseBrowserLease(lease: BrowserLease | null, strict = false): Promise<void> {
  if (!lease) return;
  const config = settings();
  if (!config) return;
  try {
    const response = await fetch(`${config.base}/leases/${encodeURIComponent(lease.id)}`, { method: 'DELETE',
      headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error',
      signal: AbortSignal.timeout(40_000), cache: 'no-store' });
    if (!response.ok) throw new Error('Browser close is pending; try closing it again');
  } catch (error) {
    if (strict) throw error;
    // The owner's finite lease expiry remains the recovery bound for quota jobs.
  }
}
