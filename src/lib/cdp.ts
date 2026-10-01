import WebSocket from 'ws';
import { readCodexAccessToken, refreshCodexAuth } from './codex-auth';
import { acquireBrowserLease, releaseBrowserLease, type BrowserLease } from './browser-lease';
import {
  CdpStartupBudget,
  CdpStartupCancelledError,
  cdpAccountName,
  cdpStartupCancellationError,
  connectCdpBrowser,
  throwIfCdpStartupCancelled,
  validateCdpEndpoint,
  waitForCdpStartup,
} from './cdp-startup';
import { parseCursorUsagePayload, parseKimiUsagePayload, type ClaudeUsagePayload, type CodexUsagePayload, type CursorUsagePayload, type KimiUsagePayload, type ProviderConfig, type ProviderUsage, type ProxyAuthEvidence, usageUrl } from './usage';
import { checkDue, compareReadings, proxyClaudeReading, recordCheck, webClaudeReading } from './quota-consistency';
import { CLAUDE_LAST_KNOWN_MS, FRESH_MS } from './usage-evidence';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

type CdpSession = {
  account: ProviderConfig;
  endpoint: string;
  browserWs: WebSocket;
  targetId?: string;
  sessionId?: string;
  nextId: number;
  pending: Map<number, Pending>;
  lastUsed: number;
};

type SessionStart = {
  accountSignature: string;
  controller: AbortController;
  promise: Promise<CdpSession>;
  waiters: number;
  settled: boolean;
};

export type CdpFetchOptions = {
  signal?: AbortSignal;
  /** The collector snapshot already read by the caller (tenancy phase 3); without it the file is read. */
  snapshot?: unknown;
  /** Tenant the observation belongs to; keys the consistency checker's memory. */
  scope?: string | null;
};

const sessions = new Map<string, CdpSession>();
const sessionStarts = new Map<string, SessionStart>();
/** Callers currently using an account's tab. The last one out closes it, so neither an idle instance nor a
 * restart leaves provider tabs behind in a shared browser profile. Counted per account before the session
 * exists, so concurrent callers that join one startup keep the tab open for each other. */
const holds = new Map<string, number>();
/** Every tab this process created: an orphan sweep must never close one of them. */
const ownTargets = new Set<string>();
/** When each endpoint was last swept for tabs a previous process left behind. */
const sweptEndpoints = new Map<string, number>();
/** Set as `window.name` on each quota tab (`<mark>:<boot>:<ms>`); survives same-site navigation and identifies the
 * tab after a restart. A tab from another boot is closed only once it is older than any fetch could take, so a second
 * instance on the same profile (a rolling deploy) never loses a tab mid-read. */
const TAB_MARK = 'zecori-quota';
const BOOT = Math.random().toString(36).slice(2, 10);
// Well past the longest a fetch may hold its tab (startup, two Kimi evaluations and a reload), with overlap to spare.
const ORPHAN_AFTER_MS = 10 * 60_000;
export function isOrphanMark(value: unknown, now = Date.now()): boolean {
  if (typeof value !== 'string' || !value.startsWith(TAB_MARK)) return false;
  const [, boot, at] = value.split(':');
  if (boot === BOOT) return false;
  const stamped = Number(at);
  return !Number.isFinite(stamped) || now - stamped > ORPHAN_AFTER_MS;
}
const EVALUATE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const REUSE_PROBE_TIMEOUT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cdpName(account: ProviderConfig): string {
  return cdpAccountName(account);
}

export async function fetchUsageThroughCdp(account: ProviderConfig, options: CdpFetchOptions = {}): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const sourceUrl = usageUrl(account);
  let lease: BrowserLease | null = null;
  let held = false;
  try {
    if (account.provider === 'codex') {
      const proxyQuota = fetchCodexFromSnapshot(account, options.snapshot);
      if (proxyQuota) return proxyQuota;
      return await fetchCodexStatus(account, fetchedAt, sourceUrl);
    }
    if (account.provider === 'claude') return await fetchClaude(account, options);
    lease = await acquireBrowserLease(account.cdp_profile_id, 'quota');
    held = hold(account.key);
    const session = await getSession(account, options.signal);
    throwIfCdpStartupCancelled(options.signal, cdpName(account));

    // This is the provider action boundary. Startup transport may retry before this
    // point; provider fetch/evaluation is deliberately dispatched exactly once.
    let result = account.provider === 'cursor'
      ? await evaluateCursorFetch(session)
      : await evaluateKimiFetch(session, sourceUrl);
    // The page did not renew its token in time: reload once instead of ever sending an expired one.
    if (result?.expiredToken) {
      await reloadPage(session, options.signal);
      result = await evaluateKimiFetch(session, sourceUrl);
    }
    if (result?.expiredToken) throw new Error('Kimi access token stayed expired after a page reload; the browser profile may be signed out of kimi.ai');
    return {
      account,
      ok: Boolean(result.ok),
      status: result.status,
      statusText: result.statusText,
      // A provider error body is kept as it came, so the message reaches the card instead of a parse failure.
      data: result.ok ? normalizePayload(account, result.data) : result.data,
      error: result.ok ? undefined : extractError(result.data) ?? `HTTP ${result.status}`,
      fetchedAt,
      sourceUrl,
    };
  } catch (error) {
    if (!(error instanceof CdpStartupCancelledError)) {
      await closeSession(account.key).catch(() => undefined);
    }
    return {
      account,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fetchedAt,
      sourceUrl,
    };
  } finally {
    if (held) await unhold(account.key);
    await releaseBrowserLease(lease);
  }
}

function hold(key: string): true {
  holds.set(key, (holds.get(key) ?? 0) + 1);
  return true;
}

async function unhold(key: string): Promise<void> {
  const left = (holds.get(key) ?? 1) - 1;
  if (left > 0) { holds.set(key, left); return; }
  holds.delete(key);
  await closeSession(key).catch(() => undefined);
}

function normalizePayload(account: ProviderConfig, data: unknown): ClaudeUsagePayload | KimiUsagePayload | CodexUsagePayload | CursorUsagePayload | undefined {
  if (account.provider === 'kimi') return parseKimiUsagePayload(data);
  if (account.provider === 'codex') return data as CodexUsagePayload;
  if (account.provider === 'cursor') {
    if (data && typeof data === 'object') return parseCursorUsagePayload(data as { stripe: unknown; usage: unknown; currentPeriod?: unknown; usageSummary?: unknown });
    return undefined;
  }
  return (data ?? undefined) as ClaudeUsagePayload | undefined;
}

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const WHAM_TIMEOUT_MS = 15_000;
const WHAM_RETRY_DELAY_MS = 1_500;

async function fetchCodexStatus(
  account: ProviderConfig,
  fetchedAt: string,
  sourceUrl: string,
  attempt = 0,
): Promise<ProviderUsage> {
  try {
    let token = await readCodexAccessToken(account);
    if (!token && await refreshCodexAuth(account)) token = await readCodexAccessToken(account);
    if (!token) {
      return {
        account,
        ok: false,
        status: 401,
        statusText: 'Not connected',
        error: 'Codex is not connected for this identity. Use Connect on this card to start built-in device sign-in.',
        fetchedAt,
        sourceUrl,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WHAM_TIMEOUT_MS);
    try {
      const response = await fetch(WHAM_URL, {
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      });
      // 401/403 = access token went stale; refresh through the CLI and retry once.
      if ((response.status === 401 || response.status === 403) && attempt === 0 && await refreshCodexAuth(account)) {
        const refreshedToken = await readCodexAccessToken(account);
        if (refreshedToken && refreshedToken !== token) return fetchCodexStatus(account, fetchedAt, sourceUrl, attempt + 1);
      }
      // 5xx = upstream hiccup (WHAM 503s regularly); one retry beats a red card.
      if (response.status >= 500 && attempt === 0) {
        await sleep(WHAM_RETRY_DELAY_MS);
        return fetchCodexStatus(account, fetchedAt, sourceUrl, attempt + 1);
      }
      const data = await response.json().catch(() => null);
      return {
        account,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        data: response.ok ? (data as CodexUsagePayload) : undefined,
        error: response.ok ? undefined : `WHAM HTTP ${response.status}`,
        fetchedAt,
        sourceUrl,
      };
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.name !== 'AbortError' && await refreshCodexAuth(account)) {
        const refreshedToken = await readCodexAccessToken(account);
        if (refreshedToken && refreshedToken !== token) return fetchCodexStatus(account, fetchedAt, sourceUrl, attempt + 1);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      account,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fetchedAt,
      sourceUrl,
    };
  }
}

async function getSession(account: ProviderConfig, signal?: AbortSignal): Promise<CdpSession> {
  const endpoint = validateCdpEndpoint(account);
  const accountSignature = `${account.provider}\u0000${endpoint}`;
  throwIfCdpStartupCancelled(signal, cdpName(account));

  const existing = sessions.get(account.key);
  if (
    existing
    && existing.endpoint === endpoint
    && existing.account.provider === account.provider
    && existing.browserWs.readyState === WebSocket.OPEN
    && existing.sessionId
  ) {
    try {
      const version = await send(existing, 'Browser.getVersion', {}, undefined, {
        signal,
        timeoutMs: REUSE_PROBE_TIMEOUT_MS,
      });
      if (typeof version?.product !== 'string' || !version.product) {
        throw new Error(`${cdpName(account)}: Browser.getVersion returned no product`);
      }
      return existing;
    } catch (error) {
      if (error instanceof CdpStartupCancelledError) throw error;
      if (sessions.get(account.key) === existing) {
        sessions.delete(account.key);
        await disposeSession(existing).catch(() => undefined);
      }
      return await getSession(account, signal);
    }
  }
  if (existing) {
    if (sessions.get(account.key) === existing) {
      sessions.delete(account.key);
      await disposeSession(existing).catch(() => undefined);
    }
  }

  const current = sessionStarts.get(account.key);
  if (current) {
    if (current.accountSignature !== accountSignature) {
      throw new Error(`${cdpName(account)}: account CDP configuration changed during session startup`);
    }
    return await joinSessionStart(current, signal, cdpName(account));
  }

  const controller = new AbortController();
  const flight: SessionStart = {
    accountSignature,
    controller,
    promise: undefined as unknown as Promise<CdpSession>,
    waiters: 0,
    settled: false,
  };
  flight.promise = (async () => {
    const session = await establishSession(account, endpoint, controller.signal);
    if (controller.signal.aborted) {
      await disposeSession(session).catch(() => undefined);
      throw cdpStartupCancellationError(cdpName(account), controller.signal);
    }
    sessions.set(account.key, session);
    return session;
  })().finally(() => {
    flight.settled = true;
    if (sessionStarts.get(account.key) === flight) sessionStarts.delete(account.key);
  });
  sessionStarts.set(account.key, flight);
  return await joinSessionStart(flight, signal, cdpName(account));
}

async function establishSession(account: ProviderConfig, endpoint: string, signal: AbortSignal): Promise<CdpSession> {
  const budget = new CdpStartupBudget(cdpName(account), signal);
  const browserWs = await connectCdpBrowser(endpoint, budget);
  const session: CdpSession = { account, endpoint, browserWs, nextId: 1, pending: new Map(), lastUsed: Date.now() };
  browserWs.addEventListener('message', (event) => handleMessage(session, String(event.data)));
  browserWs.addEventListener('close', () => rejectAll(session, `${cdpName(account)}: CDP socket closed`));
  browserWs.addEventListener('error', () => rejectAll(session, `${cdpName(account)}: CDP socket error`));

  try {
    const startupSend = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => send(
      session,
      method,
      params,
      sessionId,
      { signal, timeoutMs: budget.remaining() },
    );
    await sweepOrphanTabs(session, budget);
    const target = await startupSend('Target.createTarget', { url: 'about:blank', background: true });
    if (typeof target?.targetId !== 'string' || !target.targetId) {
      throw new Error(`${cdpName(account)}: Target.createTarget returned no targetId`);
    }
    session.targetId = target.targetId;
    ownTargets.add(target.targetId);
    const attached = await startupSend('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    if (typeof attached?.sessionId !== 'string' || !attached.sessionId) {
      throw new Error(`${cdpName(account)}: Target.attachToTarget returned no sessionId`);
    }
    session.sessionId = attached.sessionId;
    await startupSend('Page.enable', {}, session.sessionId);
    await startupSend('Runtime.enable', {}, session.sessionId);
    // Kimi moved its international site to kimi.ai (2026-09); the token lives in the page's localStorage there.
    // Claude only needs a same-origin document for its usage request; robots.txt loads without the app.
    const navUrl = account.provider === 'kimi' ? 'https://www.kimi.ai/' : account.provider === 'claude' ? CLAUDE_WEB_PAGE : 'https://cursor.com';
    await startupSend('Page.navigate', { url: navUrl }, session.sessionId);
    await waitForReady(session, budget);
    await waitForExecutionContext(session, budget);
    await startupSend('Runtime.evaluate', { expression: `window.name = ${JSON.stringify(`${TAB_MARK}:${BOOT}:${Date.now()}`)}`, returnByValue: true }, session.sessionId);
    return session;
  } catch (error) {
    await disposeSession(session).catch(() => undefined);
    throw error;
  }
}

async function joinSessionStart(flight: SessionStart, signal: AbortSignal | undefined, name: string): Promise<CdpSession> {
  flight.waiters += 1;
  try {
    return await waitForCdpStartup(flight.promise, signal, name);
  } finally {
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled) {
      flight.controller.abort(new CdpStartupCancelledError(name));
    }
  }
}

async function evaluateKimiFetch(session: CdpSession, url: string) {
  return evaluateInPage(session, `
    (async () => {
      // kimi.ai keeps the session token in localStorage (access_token, a short-lived JWT the page renews a few
      // seconds after it loads); the older kimi.com cookie is the fallback. Reading the token straight after
      // navigation returns the previous, often expired one, so wait for a token that is still valid.
      const expiresAt = (token) => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch (_) { return null; } };
      const stored = async () => {
        const deadline = Date.now() + 12000;
        let token = null;
        while (Date.now() < deadline) {
          try { token = localStorage.getItem('access_token'); } catch (_) { token = null; }
          const exp = token ? expiresAt(token) : null;
          if (token && (exp === null || exp > Date.now() + 30000)) return token;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return token;
      };
      const authCookie = document.cookie
        .split('; ')
        .find((part) => part.startsWith('kimi-auth='));
      const token = await stored();
      const tokenExpiry = token ? expiresAt(token) : null;
      if (token && tokenExpiry !== null && tokenExpiry <= Date.now() + 30000) return { ok: false, status: null, expiredToken: true, data: null };
      const authValue = token || (authCookie ? decodeURIComponent(authCookie.slice('kimi-auth='.length)) : '');
      if (!authValue) throw new Error('Missing Kimi access token: the browser profile is not signed in to kimi.ai');
      const response = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + authValue,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: JSON.stringify({ scope: ['FEATURE_CODING'] }),
      });
      const text = await response.text();
      let data = text;
      try { data = text ? JSON.parse(text) : null; } catch (_) {}
      return { ok: response.ok, status: response.status, statusText: response.statusText, data };
    })()
  `);
}

async function evaluateCursorFetch(session: CdpSession) {
  return evaluateInPage(session, `
    (async () => {
      // Parallel fetch: stripe + usage-summary (primary) + legacy usage (fallback)
      const [stripeRes, summaryRes, meRes] = await Promise.all([
        fetch('/api/auth/stripe', {
          credentials: 'include',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        }),
        fetch('/api/usage-summary', {
          credentials: 'include',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        }),
        fetch('/api/auth/me', {
          credentials: 'include',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        }),
      ]);

      let stripe = null, usageSummary = null, usage = null;
      try { stripe = await stripeRes.json(); } catch (_) {}
      try { usageSummary = await summaryRes.json(); } catch (_) {}

      // Get userId from /api/auth/me for legacy usage endpoint
      let userId = null;
      try {
        const me = await meRes.json();
        userId = me.sub || me.id || null;
      } catch (_) {}

      // Legacy usage fallback (for request-count billing model)
      if (userId) {
        try {
          const usageRes = await fetch('/api/usage?user=' + encodeURIComponent(userId), {
            credentials: 'include',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          usage = await usageRes.json();
        } catch (_) {}
      }

      const anyOk = stripeRes.ok || summaryRes.ok;
      if (!anyOk && !userId) {
        return { ok: false, status: 401, statusText: 'Not authenticated', data: null };
      }

      return {
        ok: anyOk,
        status: summaryRes.ok ? summaryRes.status : stripeRes.status,
        statusText: summaryRes.ok ? summaryRes.statusText : stripeRes.statusText,
        data: { stripe, usage, usageSummary },
      };
    })()
  `);
}

async function evaluateInPage(session: CdpSession, expression: string) {
  if (!session.sessionId) throw new Error(`${cdpName(session.account)}: no page session`);
  session.lastUsed = Date.now();
  const evaluated = await send(session, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: EVALUATE_TIMEOUT_MS,
  }, session.sessionId);
  if (evaluated.exceptionDetails) throw new Error(`${cdpName(session.account)}: ${evaluated.exceptionDetails.text ?? 'Runtime.evaluate failed'}`);
  return evaluated.result?.value;
}

async function reloadPage(session: CdpSession, signal?: AbortSignal) {
  if (!session.sessionId) throw new Error(`${cdpName(session.account)}: no page session`);
  const budget = new CdpStartupBudget(cdpName(session.account), signal ?? new AbortController().signal);
  await send(session, 'Page.reload', { ignoreCache: false }, session.sessionId, { signal, timeoutMs: budget.remaining() });
  await sleep(500);
  await waitForReady(session, budget);
  await waitForExecutionContext(session, budget);
}

/**
 * Closes quota tabs a previous process left behind on this endpoint (a crash or kill before its `finally`): page
 * targets whose `window.name` carries TAB_MARK and that this process did not create. Best effort, once per endpoint.
 */
async function sweepOrphanTabs(session: CdpSession, budget: CdpStartupBudget) {
  // Tabs of a process that crashed moments ago are not orphans yet; sweeping again once they could be catches them.
  const last = sweptEndpoints.get(session.endpoint);
  if (last !== undefined && Date.now() - last < ORPHAN_AFTER_MS) return;
  sweptEndpoints.set(session.endpoint, Date.now());
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => send(session, method, params, sessionId, { signal: budget.signal, timeoutMs: Math.min(CLEANUP_TIMEOUT_MS, budget.remaining()) });
  try {
    const listed = await call('Target.getTargets');
    const pages = (Array.isArray(listed?.targetInfos) ? listed.targetInfos : []).filter((target: { type?: string; targetId?: string }) => target.type === 'page' && typeof target.targetId === 'string' && !ownTargets.has(target.targetId));
    for (const page of pages) {
      const attached = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true }).catch(() => null);
      if (typeof attached?.sessionId !== 'string') continue;
      const named = await call('Runtime.evaluate', { expression: 'window.name', returnByValue: true }, attached.sessionId).catch(() => null);
      await call('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => undefined);
      if (isOrphanMark(named?.result?.value)) await call('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof CdpStartupCancelledError) throw error;
  }
}

async function waitForReady(session: CdpSession, budget: CdpStartupBudget) {
  if (!session.sessionId) throw new Error(`${cdpName(session.account)}: no page session`);
  let lastError: unknown;
  while (Date.now() < budget.deadline) {
    budget.throwIfCancelled();
    try {
      const result = await send(session, 'Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }, session.sessionId, { signal: budget.signal, timeoutMs: budget.remaining(lastError) });
      const state = result.result?.value;
      if (state === 'interactive' || state === 'complete') return;
    } catch (error) {
      if (error instanceof CdpStartupCancelledError) throw error;
      lastError = error;
    }
    await budget.sleep(Math.min(300, Math.max(1, budget.deadline - Date.now())));
  }
  budget.remaining(lastError ?? new Error('page did not become ready'));
}

async function waitForExecutionContext(session: CdpSession, budget: CdpStartupBudget) {
  if (!session.sessionId) throw new Error(`${cdpName(session.account)}: no page session`);
  let lastError: unknown;
  while (Date.now() < budget.deadline) {
    budget.throwIfCancelled();
    try {
      await send(
        session,
        'Runtime.evaluate',
        { expression: 'location.origin', returnByValue: true },
        session.sessionId,
        { signal: budget.signal, timeoutMs: budget.remaining(lastError) },
      );
      return;
    } catch (error) {
      if (error instanceof CdpStartupCancelledError) throw error;
      lastError = error;
      await budget.sleep(Math.min(300, Math.max(1, budget.deadline - Date.now())));
    }
  }
  budget.remaining(lastError ?? new Error('execution context did not become ready'));
}

type SendOptions = { signal?: AbortSignal; timeoutMs?: number };

async function send(
  session: CdpSession,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
  options: SendOptions = {},
): Promise<any> {
  if (session.browserWs.readyState !== WebSocket.OPEN) throw new Error(`${cdpName(session.account)}: CDP socket is not open`);
  throwIfCdpStartupCancelled(options.signal, cdpName(session.account));
  const id = session.nextId++;
  const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = Math.max(1, options.timeoutMs ?? (method === 'Runtime.evaluate' ? EVALUATE_TIMEOUT_MS + 5_000 : CONNECT_TIMEOUT_MS));
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      session.pending.delete(id);
    };
    const settleResolve = (value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => settleReject(cdpStartupCancellationError(cdpName(session.account), options.signal));
    const timeout = setTimeout(() => settleReject(new Error(`${cdpName(session.account)}: ${method} timed out`)), timeoutMs);
    session.pending.set(id, { resolve: settleResolve, reject: settleReject });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      session.browserWs.send(JSON.stringify(message));
    } catch (error) {
      settleReject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function handleMessage(session: CdpSession, raw: string) {
  let message: any;
  try { message = JSON.parse(raw); } catch { return; }
  if (typeof message.id !== 'number') return;
  const pending = session.pending.get(message.id);
  if (!pending) return;
  if (message.error) pending.reject(new Error(`${cdpName(session.account)}: ${message.error.message ?? JSON.stringify(message.error)}`));
  else pending.resolve(message.result);
}

function rejectAll(session: CdpSession, reason: string) {
  for (const pending of [...session.pending.values()]) {
    pending.reject(new Error(reason));
  }
}

async function disposeSession(session: CdpSession): Promise<void> {
  try {
    if (session.targetId && session.browserWs.readyState === WebSocket.OPEN) {
      await send(
        session,
        'Target.closeTarget',
        { targetId: session.targetId },
        undefined,
        { timeoutMs: CLEANUP_TIMEOUT_MS },
      ).catch(() => undefined);
    } else if (session.targetId) {
      // The socket is gone but the tab is not: close it through the endpoint's HTTP interface instead.
      await fetch(`${session.endpoint}/json/close/${encodeURIComponent(session.targetId)}`, { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS), redirect: 'error' }).catch(() => undefined);
    }
  } finally {
    if (session.targetId) ownTargets.delete(session.targetId);
    rejectAll(session, `${cdpName(session.account)}: CDP session closed`);
    try { session.browserWs.close(); } catch {}
  }
}

export async function closeSession(key: string) {
  const flight = sessionStarts.get(key);
  if (flight) {
    flight.controller.abort(new CdpStartupCancelledError('CDP session'));
    await flight.promise.catch(() => undefined);
  }
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  await disposeSession(session);
}

export async function closeAllSessions() {
  const keys = new Set([...sessions.keys(), ...sessionStarts.keys()]);
  await Promise.all([...keys].map(closeSession));
}

function extractError(data: unknown) {
  if (data && typeof data === 'object') {
    const record = data as Record<string, any>;
    return record.error?.message ?? record.message ?? record.type;
  }
  return typeof data === 'string' ? data.slice(0, 200) : undefined;
}

const CLAUDE_SNAPSHOT_SOURCE = 'https://api.anthropic.com/api/oauth/usage (maestro collector, cliproxy OAuth token)';
const CLAUDE_WEB_SOURCE = 'claude.ai usage (account browser)';
const CLAUDE_WEB_PAGE = 'https://claude.ai/robots.txt';
/** While the proxy's observation fails, the website is read at most this often. */
const CLAUDE_WEB_FALLBACK_INTERVAL_MS = 5 * 60_000;

/** Claude usage comes from snapshot.json, fetched on the collector host by ai-bill-collect.sh with
 *  cliproxy-refreshed OAuth tokens. The browser/CDP transport died with the example-host
 *  workstation (2026-08-20); the endpoint returns the same shape as the old claude.ai one. */
type SnapshotQuotaEntry<T> = { ok?: boolean; status?: number | null; fetched_at?: string; error?: string; data?: T;
  source?: string; direct?: { status?: number | null; error?: string; attempted_at?: string };
  proxy_auth?: { state?: string; message?: string; observed_at?: string } };

/** A collector entry whose data came from the proxy's header-observed quota or the last success says so; its status is then null. */
function snapshotObservationFields(entry: SnapshotQuotaEntry<unknown>): Pick<ProviderUsage, 'status' | 'source' | 'direct'> {
  const status = typeof entry.status === 'number' ? entry.status : undefined;
  if (entry.source !== 'proxy_headers' && entry.source !== 'retained') return { status };
  return { status, source: entry.source, direct: { status: typeof entry.direct?.status === 'number' ? entry.direct.status : null,
    error: entry.direct?.error || 'The direct quota request failed', attemptedAt: entry.direct?.attempted_at || null } };
}

/** The collector's proxy credential evidence, passed through only in its one recognised state. */
function snapshotProxyAuth(entry: SnapshotQuotaEntry<unknown>): { proxyAuth?: ProxyAuthEvidence } {
  const auth = entry.proxy_auth;
  if (auth?.state !== 'expired') return {};
  return { proxyAuth: { state: 'expired', message: typeof auth.message === 'string' && auth.message ? auth.message.slice(0, 300) : 'The proxy credential needs a re-login',
    observedAt: typeof auth.observed_at === 'string' ? auth.observed_at : null } };
}

/** The snapshot handed in by the caller (the tenant's newest stored one); nothing else is read here. */
const snapshotBody = (provided: unknown): unknown => provided ?? {};

export function fetchClaudeFromSnapshot(account: ProviderConfig, provided?: unknown): ProviderUsage {
  const fetchedAt = ""; // Missing observation time is unknown, never a fresh fetch.
  const sourceUrl = CLAUDE_SNAPSHOT_SOURCE;
  try {
    const snapshot = snapshotBody(provided) as { claude_usage?: Record<string, SnapshotQuotaEntry<ClaudeUsagePayload>> };
    const entry = snapshot.claude_usage?.[account.quota_snapshot_key || account.email || ''];
    if (!entry) return { account, ok: false, error: 'no claude_usage entry in snapshot', fetchedAt, sourceUrl };
    if (!entry.ok || !entry.data) {
      return { account, ok: false, status: typeof entry.status === 'number' ? entry.status : undefined, error: entry.error ?? 'collector fetch failed', fetchedAt: entry.fetched_at ?? fetchedAt, sourceUrl, ...snapshotProxyAuth(entry) };
    }
    return { account, ok: true, ...snapshotObservationFields(entry), data: entry.data, fetchedAt: entry.fetched_at ?? fetchedAt, sourceUrl, ...snapshotProxyAuth(entry) };
  } catch (error) {
    return { account, ok: false, error: error instanceof Error ? error.message : String(error), fetchedAt, sourceUrl };
  }
}

const webReads = new Map<string, { result: ProviderUsage; at: number }>();
const age = (result: ProviderUsage, now: number) => now - (Date.parse(result.fetchedAt) || 0);
const isDirect = (result: ProviderUsage) => result.source === undefined || result.source === 'direct';

/**
 * The proxy's observation (the collector snapshot) is the primary Claude source. With `claude_web_quota` the signed-in
 * claude.ai session is the second one: read when the primary has no current answer, and every CHECK_INTERVAL for the
 * consistency checker. Whichever usable observation is newest is shown; how the proxy failed and its credential state
 * stay attached, so a website number never hides a dead proxy credential.
 */
export async function fetchClaude(account: ProviderConfig, options: CdpFetchOptions, readWeb = fetchClaudeWebUsage, now = Date.now()): Promise<ProviderUsage> {
  const proxy = fetchClaudeFromSnapshot(account, options.snapshot);
  if (!account.claude_web_quota) return proxy;
  const scope = options.scope ?? null;
  const proxyCurrent = proxy.ok && isDirect(proxy) && age(proxy, now) <= FRESH_MS && !proxy.proxyAuth;
  const cached = webReads.get(account.key);
  const due = checkDue(scope, account.key, now);
  let web = cached?.result;
  if (due || (!proxyCurrent && (!cached || now - cached.at >= CLAUDE_WEB_FALLBACK_INTERVAL_MS))) {
    const read = await readWeb(account, options.signal);
    // A transient failure must not discard a good recent read; only a signed-out answer replaces it.
    const signedOut = read.status === 401 || read.status === 403;
    web = read.ok || signedOut || !cached?.result.ok ? read : cached.result;
    webReads.set(account.key, { result: web, at: now });
    // Fallback reads in between only feed the card; the checker counts one run per interval.
    if (due) recordCheck(scope, account.key, account.provider, compareReadings(proxyClaudeReading(proxy, now), webClaudeReading(read)), now);
  }
  if (proxyCurrent || !web?.ok || age(web, now) > CLAUDE_LAST_KNOWN_MS) return proxy;
  if (proxy.ok && age(proxy, now) <= age(web, now)) return proxy;
  const failure = proxy.ok ? proxy.direct : undefined;
  return { ...web, source: 'web',
    direct: { status: failure ? failure.status : proxy.status ?? null, error: failure ? failure.error : proxy.proxyAuth ? 'Proxy OAuth expired — re-login proxy' : proxy.error ?? 'The proxy quota observation is not current',
      attemptedAt: failure ? failure.attemptedAt : proxy.fetchedAt || null },
    ...(proxy.proxyAuth ? { proxyAuth: proxy.proxyAuth } : {}) };
}

/** claude.ai's own usage answer for the organisation, read in a background tab of the account's profile that is closed afterwards. */
export async function fetchClaudeWebUsage(account: ProviderConfig, signal?: AbortSignal): Promise<ProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const sourceUrl = CLAUDE_WEB_SOURCE;
  let lease: BrowserLease | null = null;
  let held = false;
  try {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(account.claude_org_id ?? '')) throw new Error(`${cdpName(account)}: claude_org_id is required for claude_web_quota`);
    lease = await acquireBrowserLease(account.cdp_profile_id, 'quota');
    held = hold(account.key);
    const session = await getSession(account, signal);
    throwIfCdpStartupCancelled(signal, cdpName(account));
    const result = await evaluateClaudeFetch(session, new URL(usageUrl(account)).pathname);
    const signedOut = result?.status === 401 || result?.status === 403;
    const data = result?.ok ? result.data as ClaudeUsagePayload : undefined;
    const valid = Boolean(data && (data.five_hour || data.seven_day || data.limits?.length));
    return { account, ok: valid, status: result?.status, data: valid ? data : undefined,
      error: valid ? undefined : signedOut ? 'claude.ai is signed out in the account browser' : `claude.ai usage request failed (HTTP ${result?.status ?? 'unknown'})`,
      fetchedAt, sourceUrl, source: 'web' };
  } catch (error) {
    // The tab closes when its last holder leaves (unhold); closing here would cut another caller's read.
    return { account, ok: false, error: error instanceof Error ? error.message : String(error), fetchedAt, sourceUrl, source: 'web' };
  } finally {
    if (held) await unhold(account.key);
    await releaseBrowserLease(lease);
  }
}

/** Same-origin request with the page's own session; only the usage numbers come back over CDP. */
async function evaluateClaudeFetch(session: CdpSession, path: string) {
  return evaluateInPage(session, `
    (async () => {
      if (location.origin !== 'https://claude.ai') return { ok: false, status: null, data: null };
      const response = await fetch(${JSON.stringify(path)}, { credentials: 'include', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } });
      let data = null;
      try { data = response.ok ? await response.json() : null; } catch (_) {}
      return { ok: response.ok, status: response.status, data };
    })()
  `);
}

/** Test hook: forget website reads. */
export function resetClaudeWebReadsForTests(): void { webReads.clear(); }

/** Test hook: forget which endpoints were swept and which tabs this process created. */
export function resetCdpHousekeepingForTests(): void { sweptEndpoints.clear(); ownTargets.clear(); }

/** Prefer proxy-owned quota observations when a matching or explicitly bound source exists.
 * An error observation must not trigger a second credential refresh owner. */
export function fetchCodexFromSnapshot(account: ProviderConfig, provided?: unknown): ProviderUsage | null {
  const sourceUrl = 'proxy-collector:codex-quota';
  const missing = (): ProviderUsage => ({ account, ok: false, error: 'Configured proxy quota observation is missing', fetchedAt: '', sourceUrl });
  try {
    const snapshot = snapshotBody(provided) as { codex_usage?: Record<string, SnapshotQuotaEntry<CodexUsagePayload>> };
    const entry = snapshot.codex_usage?.[account.quota_snapshot_key || account.email];
    if (!entry) return account.quota_snapshot_key ? missing() : null;
    return { account, ok: entry.ok === true && !!entry.data, ...snapshotObservationFields(entry), data: entry.ok ? entry.data : undefined,
      error: entry.ok && entry.data ? undefined : entry.error || 'Proxy quota collector failed', fetchedAt: entry.fetched_at || '', sourceUrl };
  } catch { return account.quota_snapshot_key ? missing() : null; }
}
