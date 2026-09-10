import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { readCodexAccessToken, refreshCodexAuth } from './codex-auth';
import { loadConfig } from './config';
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
import { parseCursorUsagePayload, parseKimiUsagePayload, type ClaudeUsagePayload, type CodexUsagePayload, type CursorUsagePayload, type KimiUsagePayload, type ProviderConfig, type ProviderUsage, usageUrl } from './usage';

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
};

const sessions = new Map<string, CdpSession>();
const sessionStarts = new Map<string, SessionStart>();
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
  try {
    if (account.provider === 'codex') {
      const proxyQuota = fetchCodexFromSnapshot(account);
      if (proxyQuota) return proxyQuota;
      return await fetchCodexStatus(account, fetchedAt, sourceUrl);
    }
    if (account.provider === 'claude') return fetchClaudeFromSnapshot(account);
    lease = await acquireBrowserLease(account.cdp_profile_id, 'quota');
    const session = await getSession(account, options.signal);
    throwIfCdpStartupCancelled(options.signal, cdpName(account));

    // This is the provider action boundary. Startup transport may retry before this
    // point; provider fetch/evaluation is deliberately dispatched exactly once.
    const result = account.provider === 'cursor'
      ? await evaluateCursorFetch(session)
      : await evaluateKimiFetch(session, sourceUrl);
    return {
      account,
      ok: Boolean(result.ok),
      status: result.status,
      statusText: result.statusText,
      data: normalizePayload(account, result.data),
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
  } finally { await releaseBrowserLease(lease); }
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
    const target = await startupSend('Target.createTarget', { url: 'about:blank', background: false });
    if (typeof target?.targetId !== 'string' || !target.targetId) {
      throw new Error(`${cdpName(account)}: Target.createTarget returned no targetId`);
    }
    session.targetId = target.targetId;
    const attached = await startupSend('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    if (typeof attached?.sessionId !== 'string' || !attached.sessionId) {
      throw new Error(`${cdpName(account)}: Target.attachToTarget returned no sessionId`);
    }
    session.sessionId = attached.sessionId;
    await startupSend('Page.enable', {}, session.sessionId);
    await startupSend('Runtime.enable', {}, session.sessionId);
    const navUrl = account.provider === 'kimi' ? 'https://www.kimi.com/' : 'https://cursor.com';
    await startupSend('Page.navigate', { url: navUrl }, session.sessionId);
    await waitForReady(session, budget);
    await waitForExecutionContext(session, budget);
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
      const authCookie = document.cookie
        .split('; ')
        .find((part) => part.startsWith('kimi-auth='));
      if (!authCookie) throw new Error('Missing kimi-auth cookie');
      const authValue = decodeURIComponent(authCookie.slice('kimi-auth='.length));
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
    }
  } finally {
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

/** Claude usage comes from snapshot.json, fetched on the collector host by ai-bill-collect.sh with
 *  cliproxy-refreshed OAuth tokens. The browser/CDP transport died with the example-host
 *  workstation (2026-08-20); the endpoint returns the same shape as the old claude.ai one. */
function fetchClaudeFromSnapshot(account: ProviderConfig): ProviderUsage {
  const fetchedAt = ""; // Missing observation time is unknown, never a fresh fetch.
  const sourceUrl = CLAUDE_SNAPSHOT_SOURCE;
  try {
    const raw = readFileSync(loadConfig().billing.snapshot_path, 'utf8');
    const snapshot = JSON.parse(raw) as {
      claude_usage?: Record<string, { ok?: boolean; fetched_at?: string; error?: string; data?: ClaudeUsagePayload }>;
    };
    const entry = snapshot.claude_usage?.[account.email ?? ''];
    if (!entry) return { account, ok: false, error: 'no claude_usage entry in snapshot', fetchedAt, sourceUrl };
    if (!entry.ok || !entry.data) {
      return { account, ok: false, error: entry.error ?? 'collector fetch failed', fetchedAt: entry.fetched_at ?? fetchedAt, sourceUrl };
    }
    return { account, ok: true, status: 200, data: entry.data, fetchedAt: entry.fetched_at ?? fetchedAt, sourceUrl };
  } catch (error) {
    return { account, ok: false, error: error instanceof Error ? error.message : String(error), fetchedAt, sourceUrl };
  }
}

/** Prefer proxy-owned quota observations when a matching or explicitly bound source exists.
 * An error observation must not trigger a second credential refresh owner. */
export function fetchCodexFromSnapshot(account: ProviderConfig): ProviderUsage | null {
  const sourceUrl = 'proxy-collector:codex-quota';
  const missing = (): ProviderUsage => ({ account, ok: false, error: 'Configured proxy quota observation is missing', fetchedAt: '', sourceUrl });
  try {
    const snapshot = JSON.parse(readFileSync(loadConfig().billing.snapshot_path, 'utf8')) as {
      codex_usage?: Record<string, { ok?: boolean; status?: number; fetched_at?: string; error?: string; data?: CodexUsagePayload }>;
    };
    const entry = snapshot.codex_usage?.[account.quota_snapshot_key || account.email];
    if (!entry) return account.quota_snapshot_key ? missing() : null;
    return { account, ok: entry.ok === true && !!entry.data, status: entry.status, data: entry.ok ? entry.data : undefined,
      error: entry.ok && entry.data ? undefined : entry.error || 'Proxy quota collector failed', fetchedAt: entry.fetched_at || '', sourceUrl };
  } catch { return account.quota_snapshot_key ? missing() : null; }
}
