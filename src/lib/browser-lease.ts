/** Server-only integration with the bounded browser lifecycle owner.
 *
 * The owner runs one mutation at a time and answers any request that arrives meanwhile with 409 controller_busy; a
 * profile that already has a live lease answers 409 profile_in_use. A refresh asks for several leases at once (both
 * Claude website reads, Kimi, Cursor; three of them on one profile), so without coordination only one wins and the
 * others fail for a whole cycle. This process therefore
 *  - sends its lifecycle requests one at a time,
 *  - lets one automatic read per profile hold a lease at a time; the others wait their turn in order,
 *  - retries what is still contended (other processes, the owner's own sweep) with bounded, jittered back-off before
 *    calling the browser busy.
 * A person's manual session on a profile is not waited out: automatic reads on it fail fast while it lasts. */
export type BrowserLease = { id: string; expiresAt: string };
type Purpose = 'quota' | 'identity' | 'manual';

const BUSY_MESSAGE = 'Browser busy with another account; automatic refresh will retry';
const UNAVAILABLE_MESSAGE = 'Browser lifecycle unavailable; other account sources continue updating';
/** Refusals that clear on their own: a mutation in progress, a lease that ends with its read, a slot that frees up, an
 * expired lease the owner's sweep (every 30 s) has not reaped yet. Anything else is reported at once. */
const RETRYABLE = new Set(['controller_busy', 'profile_in_use', 'capacity_busy', 'profile_stop_pending']);

type RetryPolicy = { baseMs: number; capMs: number; budgetMs: Record<Purpose, number>; releaseBudgetMs: number; random: () => number };
const DEFAULT_POLICY: RetryPolicy = {
  baseMs: 250,
  capMs: 5_000,
  // Queue wait plus retries. A refresh is background work and a read on a shared profile takes seconds (a Kimi read
  // with a reload up to about a minute); a person waiting on the account browser gets a short wait.
  budgetMs: { quota: 90_000, identity: 20_000, manual: 20_000 },
  // A release left to the TTL keeps the profile refused for the next read for up to five minutes.
  releaseBudgetMs: 15_000,
  random: Math.random,
};
let policy: RetryPolicy = DEFAULT_POLICY;

class LeaseRefusal extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

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

/** Full-jitter exponential back-off: between half and all of min(cap, base * 2^attempt). */
export function retryDelayMs(attempt: number, random: () => number = policy.random, base = policy.baseMs, cap = policy.capMs): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- one request at a time

let controllerTail: Promise<unknown> = Promise.resolve();
/** Runs one lifecycle request after every earlier one from this process has finished. */
function controllerTurn<T>(request: () => Promise<T>): Promise<T> {
  const run = controllerTail.then(request, request);
  controllerTail = run.catch(() => undefined);
  return run;
}

/** The refusal code in an owner's error body (`{"error":"…"}`), never the body itself. */
async function refusalCode(response: Response): Promise<string> {
  try {
    const value = await response.json();
    return typeof value?.error === 'string' && /^[a-z_]{1,60}$/.test(value.error) ? value.error : 'unknown';
  } catch { return 'unknown'; }
}

// ---------------------------------------------------------------- one automatic lease per profile

type Held = { profile: string; purpose: Purpose; acquiredAt: number; free: () => void; timer?: ReturnType<typeof setTimeout> };
const profileTails = new Map<string, Promise<void>>();
const held = new Map<string, Held>();
/** Manual (sign-in) leases this process holds, by profile, until their expiry. */
const manualUntil = new Map<string, number>();

/** Waits for every earlier automatic holder of the profile in this process; returns the function that frees the turn.
 * A waiter that gives up frees its own turn without letting the next one jump ahead of the current holder. */
async function profileTurn(profile: string, deadline: number): Promise<() => void> {
  const previous = profileTails.get(profile) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  profileTails.set(profile, tail);
  let freed = false;
  const free = () => {
    if (freed) return;
    freed = true;
    release();
    if (profileTails.get(profile) === tail) profileTails.delete(profile);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    previous.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); }),
  ]);
  clearTimeout(timer);
  if (!ready) {
    freed = true;
    release();
    // Earlier holders may still be reading: the queue entry stays until they finish, so a newcomer still waits.
    void tail.then(() => { if (profileTails.get(profile) === tail) profileTails.delete(profile); });
    throw new LeaseRefusal('queue_timeout', 409, BUSY_MESSAGE);
  }
  return free;
}

const MAX_TIMER_MS = 2 ** 31 - 1;
/** Safety net: past its expiry the owner no longer holds the lease, so neither does this process. */
function expireAt(id: string, entry: Held, expires: number) {
  clearTimeout(entry.timer);
  // setTimeout fires at once beyond 2^31-1 ms, which would free a far-future lease's turn immediately.
  entry.timer = setTimeout(() => {
    if (held.get(id) === entry) held.delete(id);
    if (entry.purpose === 'manual' && (manualUntil.get(entry.profile) ?? 0) <= expires) manualUntil.delete(entry.profile);
    entry.free();
  }, Math.min(MAX_TIMER_MS, Math.max(0, expires - Date.now()) + 1_000));
  entry.timer.unref?.();
}

function log(event: 'acquire' | 'release', fields: Record<string, string | number>) {
  console.info(`[zecori] browser lease ${event} ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ')}`);
}

const tally = (codes: string[]) => codes.length
  ? Object.entries(codes.reduce<Record<string, number>>((all, code) => ({ ...all, [code]: (all[code] ?? 0) + 1 }), {})).map(([code, count]) => `${code}:${count}`).join(',')
  : '-';

// ---------------------------------------------------------------- API

export async function acquireBrowserLease(profileId: string | undefined, purpose: Purpose): Promise<BrowserLease | null> {
  const config = settings();
  if (!config) return null; // Existing operator-owned lifecycle remains compatible.
  if (!profileId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(profileId)) {
    throw new Error('Automatic browser source needs a configured profile binding');
  }
  const started = Date.now();
  const deadline = started + policy.budgetMs[purpose];
  const contended: string[] = [];
  let attempts = 0;
  let queuedMs = 0;
  let free: (() => void) | undefined;
  try {
    if (purpose !== 'manual' && (manualUntil.get(profileId) ?? 0) > Date.now()) {
      throw new LeaseRefusal('manual_session', 409, BUSY_MESSAGE);
    }
    free = await profileTurn(profileId, deadline);
    queuedMs = Date.now() - started;
    for (;;) {
      attempts += 1;
      const response = await controllerTurn(() => fetch(`${config.base}/leases`, { method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, purpose }), cache: 'no-store',
        redirect: 'error', signal: AbortSignal.timeout(60_000) }));
      if (response.ok) {
        const value = await response.json();
        const expires = typeof value?.expires_at === 'number' ? value.expires_at * 1000 : Date.parse(value?.expires_at);
        if (typeof value?.lease_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.lease_id)
          || !Number.isFinite(expires) || expires <= Date.now()) {
          throw new LeaseRefusal('invalid_lease', response.status, 'Browser lifecycle returned an invalid lease');
        }
        const lease = { id: value.lease_id as string, expiresAt: new Date(expires).toISOString() };
        const entry: Held = { profile: profileId, purpose, acquiredAt: Date.now(), free: () => undefined };
        if (purpose === 'manual') {
          manualUntil.set(profileId, expires);
          free(); // A sign-in session is not an automatic turn; reads on the profile see manualUntil instead.
        } else entry.free = free;
        free = undefined;
        held.set(lease.id, entry);
        expireAt(lease.id, entry, expires);
        log('acquire', { profile: profileId, purpose, result: 'ok', queue_ms: queuedMs, attempts, contended: tally(contended), total_ms: Date.now() - started });
        return lease;
      }
      const code = response.status === 409 || response.status === 503 ? await refusalCode(response) : `http_${response.status}`;
      const retryable = (response.status === 409 && (RETRYABLE.has(code) || code === 'unknown'))
        || (response.status === 503 && code === 'profile_stop_pending');
      if (!retryable) {
        throw new LeaseRefusal(code, response.status, response.status === 409 ? BUSY_MESSAGE : UNAVAILABLE_MESSAGE);
      }
      contended.push(code);
      const delay = retryDelayMs(attempts - 1);
      if (Date.now() + delay > deadline) {
        throw new LeaseRefusal(code, response.status, response.status === 409 ? BUSY_MESSAGE : UNAVAILABLE_MESSAGE);
      }
      await sleep(delay);
    }
  } catch (error) {
    free?.();
    const refusal = error instanceof LeaseRefusal ? error : null;
    log('acquire', { profile: profileId, purpose, result: refusal?.status === 409 ? 'busy' : 'failed', code: refusal?.code ?? 'request_failed',
      queue_ms: queuedMs, attempts, contended: tally(contended), total_ms: Date.now() - started });
    if (refusal) throw new Error(refusal.message);
    throw new Error(UNAVAILABLE_MESSAGE);
  }
}

export async function renewBrowserLease(lease: BrowserLease): Promise<BrowserLease> {
  const config = settings();
  if (!config) throw new Error('Browser lifecycle is not enabled');
  const deadline = Date.now() + policy.releaseBudgetMs;
  for (let attempt = 0; ; attempt += 1) {
    const response = await controllerTurn(() => fetch(`${config.base}/leases/${encodeURIComponent(lease.id)}`, { method: 'PATCH',
      headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error',
      signal: AbortSignal.timeout(10_000), cache: 'no-store' }));
    if (response.ok) {
      const value = await response.json();
      const expires = typeof value?.expires_at === 'number' ? value.expires_at * 1000 : Date.parse(value?.expires_at);
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Browser lease renewal returned an invalid expiry');
      const entry = held.get(lease.id);
      if (entry) {
        if (entry.purpose === 'manual') manualUntil.set(entry.profile, expires);
        expireAt(lease.id, entry, expires);
      }
      return { id: lease.id, expiresAt: new Date(expires).toISOString() };
    }
    const delay = retryDelayMs(attempt);
    if (response.status !== 409 || await refusalCode(response) !== 'controller_busy' || Date.now() + delay > deadline) {
      throw new Error('Browser lease could not be renewed; close it before opening another account');
    }
    await sleep(delay);
  }
}

export async function releaseBrowserLease(lease: BrowserLease | null, strict = false): Promise<void> {
  if (!lease) return;
  const entry = held.get(lease.id);
  const started = Date.now();
  let attempts = 0;
  let released = false;
  try {
    const config = settings();
    if (!config) return;
    const deadline = started + policy.releaseBudgetMs;
    for (;;) {
      attempts += 1;
      const response = await controllerTurn(() => fetch(`${config.base}/leases/${encodeURIComponent(lease.id)}`, { method: 'DELETE',
        headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error',
        signal: AbortSignal.timeout(40_000), cache: 'no-store' }));
      if (response.ok) { released = true; return; }
      const delay = retryDelayMs(attempts - 1);
      if (response.status !== 409 || await refusalCode(response) !== 'controller_busy' || Date.now() + delay > deadline) {
        throw new Error('Browser close is pending; try closing it again');
      }
      await sleep(delay);
    }
  } catch (error) {
    if (strict) throw error;
    // The owner's finite lease expiry remains the recovery bound for quota jobs.
  } finally {
    // A sign-in session whose close failed is still live: reads keep failing fast until it closes or expires.
    if (entry && (released || entry.purpose !== 'manual')) {
      if (held.get(lease.id) === entry) held.delete(lease.id);
      if (entry.purpose === 'manual') manualUntil.delete(entry.profile);
      clearTimeout(entry.timer);
      // Freed only now: the next read on this profile must not reach the owner while this lease is still live.
      entry.free();
    }
    if (entry) log('release', { profile: entry.profile, purpose: entry.purpose, result: released ? 'ok' : 'failed', attempts,
      held_ms: Date.now() - entry.acquiredAt, release_ms: Date.now() - started });
  }
}

/** Test hook: shorten (or restore) the back-off and budgets. */
export function setBrowserLeaseRetryForTests(overrides: Partial<RetryPolicy> | null): void {
  policy = overrides ? { ...DEFAULT_POLICY, ...overrides, budgetMs: { ...DEFAULT_POLICY.budgetMs, ...overrides.budgetMs } } : DEFAULT_POLICY;
}

/** Test hook: forget queued turns, held leases and manual sessions. */
export function resetBrowserLeasesForTests(): void {
  for (const entry of held.values()) clearTimeout(entry.timer);
  held.clear(); profileTails.clear(); manualUntil.clear();
  controllerTail = Promise.resolve();
}
