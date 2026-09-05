import WebSocket from 'ws';
import type { ProviderConfig } from './usage';

export const CDP_STARTUP_TIMEOUT_MS = 30_000;

const ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_VERSION_RESPONSE_BYTES = 64 * 1024;
const INITIAL_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 2_000;
const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

type WebSocketConstructor = new (url: string | URL) => WebSocket;
const defaultWebSocketConstructor: WebSocketConstructor = WebSocket;
let webSocketConstructor = defaultWebSocketConstructor;
const ignoreWebSocketError = () => undefined;

/** Test hook for deterministic handshake failures without opening network sockets. */
export function setCdpWebSocketConstructorForTests(constructor?: WebSocketConstructor): void {
  webSocketConstructor = constructor ?? defaultWebSocketConstructor;
}

class CdpHttpStatusError extends Error {
  constructor(readonly status: number, url: string) {
    super(`${url}: HTTP ${status}`);
    this.name = 'CdpHttpStatusError';
  }
}

class CdpTransportError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options?: ErrorOptions & { status?: number; code?: string }) {
    super(message, options);
    this.name = 'CdpTransportError';
    this.status = options?.status;
    this.code = options?.code;
  }
}

export class CdpStartupCancelledError extends Error {
  constructor(name: string, options?: ErrorOptions) {
    super(`${name}: CDP startup cancelled`, options);
    this.name = 'CdpStartupCancelledError';
  }
}

export class CdpStartupDeadlineError extends Error {
  constructor(name: string, lastError?: unknown) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    super(
      `${name}: CDP startup deadline exceeded after ${CDP_STARTUP_TIMEOUT_MS}ms${detail}`,
      lastError instanceof Error ? { cause: lastError } : undefined,
    );
    this.name = 'CdpStartupDeadlineError';
  }
}

export class CdpStartupBudget {
  readonly deadline: number;

  constructor(
    readonly name: string,
    readonly signal: AbortSignal,
  ) {
    this.deadline = Date.now() + CDP_STARTUP_TIMEOUT_MS;
  }

  remaining(lastError?: unknown): number {
    this.throwIfCancelled();
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new CdpStartupDeadlineError(this.name, lastError);
    return remaining;
  }

  throwIfCancelled(): void {
    throwIfCdpStartupCancelled(this.signal, this.name);
  }

  async sleep(ms: number): Promise<void> {
    this.throwIfCancelled();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cdpStartupCancellationError(this.name, this.signal));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, Math.max(0, ms));
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted) onAbort();
    });
  }
}

export function cdpAccountName(account: ProviderConfig): string {
  return account.label || account.key;
}

export function validateCdpEndpoint(account: ProviderConfig): string {
  const name = cdpAccountName(account);
  const raw = account.cdp_http;
  if (typeof raw !== 'string' || !raw || raw.trim() !== raw) {
    throw new Error(`${name}: cdp_http must be an absolute HTTP(S) origin`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${name}: cdp_http must be an absolute HTTP(S) origin`, { cause: error });
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(`${name}: cdp_http must be an absolute HTTP(S) origin`);
  }
  return url.origin;
}

export function cdpStartupCancellationError(name: string, signal?: AbortSignal): CdpStartupCancelledError {
  if (signal?.reason instanceof CdpStartupCancelledError) return signal.reason;
  return new CdpStartupCancelledError(name, signal?.reason instanceof Error ? { cause: signal.reason } : undefined);
}

export function throwIfCdpStartupCancelled(signal: AbortSignal | undefined, name: string): void {
  if (signal?.aborted) throw cdpStartupCancellationError(name, signal);
}

export async function waitForCdpStartup<T>(promise: Promise<T>, signal: AbortSignal | undefined, name: string): Promise<T> {
  if (!signal) return await promise;
  throwIfCdpStartupCancelled(signal, name);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cdpStartupCancellationError(name, signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export async function connectCdpBrowser(endpoint: string, budget: CdpStartupBudget): Promise<WebSocket> {
  const versionUrl = `${endpoint}/json/version`;
  let lastError: unknown;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;

  for (;;) {
    budget.throwIfCancelled();
    budget.remaining(lastError);
    let socket: WebSocket | undefined;
    try {
      const browserWsUrl = await fetchBrowserWsUrl(versionUrl, endpoint, budget);
      socket = await connectWs(browserWsUrl, budget, Math.min(ATTEMPT_TIMEOUT_MS, budget.remaining()));
      await probeBrowserVersion(socket, budget);
      return socket;
    } catch (error) {
      if (socket) closeFailedSocket(socket);
      if (error instanceof CdpStartupCancelledError) throw error;
      if (!isTransientStartupError(error)) throw error;
      lastError = error;
      if (Date.now() >= budget.deadline) throw new CdpStartupDeadlineError(budget.name, error);
      const delay = Math.min(retryDelayMs, Math.max(0, budget.deadline - Date.now()));
      if (Date.now() + delay >= budget.deadline) throw new CdpStartupDeadlineError(budget.name, error);
      await budget.sleep(delay);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

function validateBrowserWsUrl(value: unknown, endpoint: string, name: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${name}: /json/version missing browser WebSocket URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${name}: invalid CDP browser WebSocket URL`, { cause: error });
  }
  const cdp = new URL(endpoint);
  const expectedProtocol = cdp.protocol === 'https:' ? 'wss:' : 'ws:';
  if (
    url.protocol !== expectedProtocol
    || url.host !== cdp.host
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/devtools\/browser\/[^/]+$/.test(url.pathname)
  ) {
    throw new Error(`${name}: invalid CDP browser WebSocket URL`);
  }
  return url.toString();
}

async function fetchBrowserWsUrl(versionUrl: string, endpoint: string, budget: CdpStartupBudget): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, budget.remaining());
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
  }, timeoutMs);
  const onAbort = () => controller.abort(cdpStartupCancellationError(budget.name, budget.signal));
  budget.signal.addEventListener('abort', onAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(versionUrl, { signal: controller.signal, redirect: 'manual' });
    } catch (error) {
      if (budget.signal.aborted) throw cdpStartupCancellationError(budget.name, budget.signal);
      if (timedOut) {
        throw new CdpTransportError(`${budget.name}: /json/version request timed out`, {
          cause: error instanceof Error ? error : undefined,
          code: 'ETIMEDOUT',
        });
      }
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CdpHttpStatusError(response.status, versionUrl);
    }
    let rawVersion: string;
    try {
      rawVersion = await readBoundedResponse(response, MAX_VERSION_RESPONSE_BYTES, budget.name);
    } catch (error) {
      if (budget.signal.aborted) throw cdpStartupCancellationError(budget.name, budget.signal);
      if (timedOut) {
        throw new CdpTransportError(`${budget.name}: /json/version request timed out`, {
          cause: error instanceof Error ? error : undefined,
          code: 'ETIMEDOUT',
        });
      }
      throw error;
    }
    let version: unknown;
    try {
      version = JSON.parse(rawVersion);
    } catch (error) {
      throw new Error(`${budget.name}: malformed /json/version JSON`, { cause: error });
    }
    if (!version || typeof version !== 'object' || Array.isArray(version)) {
      throw new Error(`${budget.name}: /json/version must return a JSON object`);
    }
    return validateBrowserWsUrl((version as Record<string, unknown>).webSocketDebuggerUrl, endpoint, budget.name);
  } finally {
    clearTimeout(timer);
    budget.signal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number, name: string): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${name}: /json/version response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${name}: /json/version response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function connectWs(url: string, budget: CdpStartupBudget, timeoutMs: number): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new webSocketConstructor(url);
    } catch (error) {
      reject(new Error(`${budget.name}: invalid CDP browser WebSocket URL`, { cause: error }));
      return;
    }
    // ws preserves EventEmitter's fatal unhandled-error semantics. Functional
    // listeners change between handshake, liveness probe, and session ownership,
    // so retain one harmless guard for the full socket lifetime across handoffs.
    ws.addEventListener('error', ignoreWebSocketError);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      budget.signal.removeEventListener('abort', onAbort);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('error', () => undefined, { once: true });
      }
      cleanup();
      try { ws.close(); } catch {}
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };
    const onError = (event: WebSocket.ErrorEvent) => {
      const eventError = event.error;
      const cause = eventError instanceof Error ? eventError : undefined;
      fail(new CdpTransportError(`${budget.name}: CDP WebSocket handshake failed`, {
        cause,
        status: websocketErrorStatus(cause),
      }));
    };
    const onAbort = () => fail(cdpStartupCancellationError(budget.name, budget.signal));
    const timer = setTimeout(() => {
      fail(new CdpTransportError(`${budget.name}: CDP WebSocket handshake timed out`, {
        cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        code: 'ETIMEDOUT',
      }));
    }, Math.max(1, timeoutMs));
    budget.signal.addEventListener('abort', onAbort, { once: true });
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
    if (budget.signal.aborted) onAbort();
  });
}

async function probeBrowserVersion(ws: WebSocket, budget: CdpStartupBudget): Promise<void> {
  const requestId = 0;
  const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, budget.remaining());
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      budget.signal.removeEventListener('abort', onAbort);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onMessage = (event: WebSocket.MessageEvent) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        fail(new Error(`${budget.name}: malformed Browser.getVersion response`, { cause: error }));
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        fail(new Error(`${budget.name}: invalid Browser.getVersion response`));
        return;
      }
      const record = message as Record<string, unknown>;
      if (!('id' in record)) return;
      if (record.id !== requestId) {
        fail(new Error(`${budget.name}: invalid Browser.getVersion response id`));
        return;
      }
      if (record.error) {
        fail(new Error(`${budget.name}: Browser.getVersion failed: ${cdpErrorMessage(record.error)}`));
        return;
      }
      const result = record.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        fail(new Error(`${budget.name}: invalid Browser.getVersion result`));
        return;
      }
      const product = (result as Record<string, unknown>).product;
      if (typeof product !== 'string' || !/^(?:Chrome|HeadlessChrome)\/\d/.test(product)) {
        fail(new Error(`${budget.name}: invalid Browser.getVersion product`));
        return;
      }
      succeed();
    };
    const onError = (event: WebSocket.ErrorEvent) => {
      const cause = event.error instanceof Error ? event.error : undefined;
      fail(new CdpTransportError(`${budget.name}: Browser.getVersion transport failed`, {
        cause,
        status: websocketErrorStatus(cause),
        code: transportErrorCode(cause),
      }));
    };
    const onClose = () => fail(new CdpTransportError(`${budget.name}: CDP socket closed during Browser.getVersion`, {
      code: 'ECONNRESET',
    }));
    const onAbort = () => fail(cdpStartupCancellationError(budget.name, budget.signal));
    const timer = setTimeout(() => fail(new CdpTransportError(`${budget.name}: Browser.getVersion timed out`, {
      cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      code: 'ETIMEDOUT',
    })), Math.max(1, timeoutMs));

    budget.signal.addEventListener('abort', onAbort, { once: true });
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
    if (budget.signal.aborted) {
      onAbort();
      return;
    }
    try {
      ws.send(JSON.stringify({ id: requestId, method: 'Browser.getVersion' }));
    } catch (error) {
      fail(new CdpTransportError(`${budget.name}: Browser.getVersion dispatch failed`, {
        cause: error instanceof Error ? error : undefined,
        code: transportErrorCode(error),
      }));
    }
  });
}

function closeFailedSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener('error', () => undefined, { once: true });
  }
  try { ws.terminate(); } catch {
    try { ws.close(); } catch {}
  }
}

function cdpErrorMessage(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'unknown CDP error';
}

function websocketErrorStatus(error: Error | undefined): number | undefined {
  if (!error) return undefined;
  const explicit = (error as Error & { status?: unknown }).status;
  if (typeof explicit === 'number') return explicit;
  const match = error.message.match(/(?:unexpected server response:|HTTP)\s*(\d{3})/i);
  return match ? Number(match[1]) : undefined;
}

function isTransientStartupError(error: unknown): boolean {
  if (error instanceof CdpHttpStatusError) return TRANSIENT_HTTP_STATUSES.has(error.status);
  if (error instanceof CdpTransportError && error.status !== undefined) {
    return TRANSIENT_HTTP_STATUSES.has(error.status);
  }
  const code = transportErrorCode(error);
  return code !== undefined && TRANSIENT_TRANSPORT_CODES.has(code);
}

function transportErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
