import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`;
});

import { closeAllSessions, fetchUsageThroughCdp } from '../src/lib/cdp';
import { setCdpWebSocketConstructorForTests } from '../src/lib/cdp-startup';
import { loadConfig, type AccountConfig } from '../src/lib/config';

type WsPlan =
  | { kind: 'open' }
  | { kind: 'hang' }
  | { kind: 'error'; code?: string; message?: string }
  | { kind: 'probe-error'; code?: string; message?: string }
  | { kind: 'gap-error'; at: 'after-open' | 'after-probe'; code?: string; message?: string };

type Listener = EventListenerOrEventListenerObject;

const state = {
  wsPlans: [] as WsPlan[],
  sockets: [] as FakeWebSocket[],
  methods: [] as string[],
  providerDispatches: 0,
  providerError: undefined as string | undefined,
  browserProbeErrors: [] as string[],
  browserProbeRaw: undefined as string | undefined,
  attachError: undefined as string | undefined,
  closedSockets: 0,
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  private readonly plan: WsPlan;
  private gapErrorEmitted = false;
  private readonly listeners = new Map<string, Array<{ listener: Listener; once: boolean }>>();

  constructor(url: string | URL) {
    this.url = String(url);
    state.sockets.push(this);
    const plan = state.wsPlans.shift() ?? { kind: 'open' };
    this.plan = plan;
    queueMicrotask(() => {
      if (plan.kind === 'hang') return;
      if (plan.kind === 'open' || plan.kind === 'probe-error' || plan.kind === 'gap-error') {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open', { type: 'open' });
        if (plan.kind === 'gap-error' && plan.at === 'after-open') this.emitGapError();
        return;
      }
      const error = Object.assign(new Error(plan.message ?? 'connection failed'), plan.code ? { code: plan.code } : {});
      this.emit('error', { type: 'error', error });
    });
  }

  addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void {
    const once = typeof options === 'object' && Boolean(options.once);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((entry) => entry.listener !== listener));
  }

  send(raw: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
    const message = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
    state.methods.push(message.method);

    if (message.method === 'Browser.getVersion' && this.plan.kind === 'probe-error') {
      const error = Object.assign(
        new Error(this.plan.message ?? 'Browser.getVersion transport failed'),
        this.plan.code ? { code: this.plan.code } : {},
      );
      queueMicrotask(() => this.emit('error', { type: 'error', error }));
      return;
    }
    if (message.method === 'Browser.getVersion' && state.browserProbeRaw !== undefined) {
      const rawResponse = state.browserProbeRaw;
      state.browserProbeRaw = undefined;
      queueMicrotask(() => this.emit('message', { type: 'message', data: rawResponse }));
      return;
    }

    let response: Record<string, unknown>;
    if (message.method === 'Target.createTarget') response = { id: message.id, result: { targetId: 'target-1' } };
    else if (message.method === 'Target.attachToTarget') {
      response = state.attachError
        ? { id: message.id, error: { message: state.attachError } }
        : { id: message.id, result: { sessionId: 'session-1' } };
    }
    else if (message.method === 'Browser.getVersion') {
      const browserProbeError = state.browserProbeErrors.shift();
      response = browserProbeError
        ? { id: message.id, error: { message: browserProbeError } }
        : { id: message.id, result: { product: 'Chrome/140.0.0.0' } };
    } else if (message.method === 'Runtime.evaluate' && message.params?.expression === 'document.readyState') {
      response = { id: message.id, result: { result: { value: 'complete' } } };
    } else if (message.method === 'Runtime.evaluate' && message.params?.expression === 'location.origin') {
      response = { id: message.id, result: { result: { value: 'https://cursor.com' } } };
    } else if (message.method === 'Runtime.evaluate') {
      state.providerDispatches += 1;
      response = state.providerError
        ? { id: message.id, error: { message: state.providerError } }
        : {
            id: message.id,
            result: {
              result: {
                value: {
                  ok: true,
                  status: 200,
                  statusText: 'OK',
                  data: {
                    stripe: { membershipType: 'pro', subscriptionStatus: 'active' },
                    usage: null,
                    usageSummary: {},
                  },
                },
              },
            },
          };
    } else response = { id: message.id, result: {} };

    queueMicrotask(() => {
      this.emit('message', { type: 'message', data: JSON.stringify(response) });
      if (message.method === 'Browser.getVersion' && this.plan.kind === 'gap-error' && this.plan.at === 'after-probe') {
        this.emitGapError();
      }
    });
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    state.closedSockets += 1;
    queueMicrotask(() => this.emit('close', { type: 'close' }));
  }

  private emit(type: string, event: Record<string, unknown>): void {
    const listeners = [...(this.listeners.get(type) ?? [])];
    if (type === 'error' && listeners.length === 0) {
      throw event.error instanceof Error ? event.error : new Error('Unhandled WebSocket error');
    }
    for (const entry of listeners) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      if (typeof entry.listener === 'function') entry.listener(event as unknown as Event);
      else entry.listener.handleEvent(event as unknown as Event);
    }
  }

  private emitGapError(): void {
    if (this.gapErrorEmitted || this.plan.kind !== 'gap-error') return;
    this.gapErrorEmitted = true;
    const error = Object.assign(
      new Error(this.plan.message ?? 'handoff transport error'),
      this.plan.code ? { code: this.plan.code } : {},
    );
    this.emit('error', { type: 'error', error });
  }
}

const account = (overrides: Partial<AccountConfig> = {}): AccountConfig => ({
  key: 'cursor-test',
  provider: 'cursor',
  label: 'Cursor test',
  email: 'test@example.com',
  cdp_http: 'http://127.0.0.1:18802',
  ...overrides,
});

const browserWsUrl = 'ws://127.0.0.1:18802/devtools/browser/test-browser';

function versionResponse(
  body: unknown = { webSocketDebuggerUrl: browserWsUrl },
  status = 200,
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  state.wsPlans = [];
  state.sockets = [];
  state.methods = [];
  state.providerDispatches = 0;
  state.providerError = undefined;
  state.browserProbeErrors = [];
  state.browserProbeRaw = undefined;
  state.attachError = undefined;
  state.closedSockets = 0;
  vi.useRealTimers();
  setCdpWebSocketConstructorForTests(FakeWebSocket as never);
});

afterEach(async () => {
  await closeAllSessions();
  setCdpWebSocketConstructorForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CDP startup retry boundary', () => {
  test('keeps the startup window open until multi-second EHOSTUNREACH recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
    const fetchMock = vi.fn(() => Date.now() < 2_500
      ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause }))
      : Promise.resolve(versionResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchUsageThroughCdp(account());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.providerDispatches).toBe(1);
  });

  test('keeps the startup window open until multi-second WebSocket ECONNREFUSED recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(() => Promise.resolve(versionResponse()));
    vi.stubGlobal('fetch', fetchMock);
    state.wsPlans.push(
      { kind: 'error', code: 'ECONNREFUSED' },
      { kind: 'error', code: 'ECONNREFUSED' },
      { kind: 'error', code: 'ECONNREFUSED' },
      { kind: 'error', code: 'ECONNREFUSED' },
      { kind: 'open' },
    );

    const pending = fetchUsageThroughCdp(account());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(state.sockets.slice(0, 4).every((socket) => socket.readyState === FakeWebSocket.CLOSED)).toBe(true);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.providerDispatches).toBe(1);
  });

  test('retries transient Browser.getVersion transport failure before target creation', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(versionResponse()));
    vi.stubGlobal('fetch', fetchMock);
    state.wsPlans.push(
      { kind: 'probe-error', code: 'ECONNRESET' },
      { kind: 'open' },
    );

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.sockets[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(state.methods.filter((method) => method === 'Browser.getVersion')).toHaveLength(2);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.providerDispatches).toBe(1);
  });

  test.each(['after-open', 'after-probe'] as const)(
    'keeps an error guard across the %s ownership handoff',
    async (at) => {
      const fetchMock = vi.fn(() => Promise.resolve(versionResponse()));
      vi.stubGlobal('fetch', fetchMock);
      state.wsPlans.push({ kind: 'gap-error', at, code: 'ECONNRESET' });

      const result = await fetchUsageThroughCdp(account());

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(state.methods.filter((method) => method === 'Browser.getVersion')).toHaveLength(1);
      expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
      expect(state.providerDispatches).toBe(1);

      await closeAllSessions();
      expect(state.methods.filter((method) => method === 'Target.closeTarget')).toHaveLength(1);
      expect(state.closedSockets).toBe(1);
      expect(state.sockets.every((socket) => socket.readyState === FakeWebSocket.CLOSED)).toBe(true);
    },
  );

  test('retries EHOSTUNREACH discovery and succeeds without repeating the provider action', async () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause }))
      .mockResolvedValueOnce(versionResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.sockets).toHaveLength(1);
    expect(state.providerDispatches).toBe(1);
  });

  test('re-runs discovery after a refused WebSocket handshake and then succeeds', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(versionResponse()));
    vi.stubGlobal('fetch', fetchMock);
    state.wsPlans.push(
      { kind: 'error', code: 'ECONNREFUSED' },
      { kind: 'open' },
    );

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.sockets).toHaveLength(2);
    expect(state.sockets[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.providerDispatches).toBe(1);
  });

  test('retries a transient discovery 503', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(versionResponse({}, 503))
      .mockResolvedValueOnce(versionResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.providerDispatches).toBe(1);
  });

  test('retries a WebSocket handshake 503', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(versionResponse()));
    vi.stubGlobal('fetch', fetchMock);
    state.wsPlans.push(
      { kind: 'error', message: 'Unexpected server response: 503' },
      { kind: 'open' },
    );

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.sockets).toHaveLength(2);
    expect(state.providerDispatches).toBe(1);
  });

  test('does not retry a permanent WebSocket handshake response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse());
    vi.stubGlobal('fetch', fetchMock);
    state.wsPlans.push({ kind: 'error', message: 'Unexpected server response: 404' });

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('WebSocket handshake failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(1);
    expect(state.providerDispatches).toBe(0);
  });

  test('does not retry a permanent WebSocket transport error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse());
    vi.stubGlobal('fetch', fetchMock);
    state.wsPlans.push({ kind: 'error', code: 'CERT_HAS_EXPIRED', message: 'certificate expired' });

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('WebSocket handshake failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(1);
    expect(state.providerDispatches).toBe(0);
  });

  test('fails fast on a real WebSocket HTTP 404 handshake', async () => {
    setCdpWebSocketConstructorForTests();
    const server = createServer((_request, response) => {
      response.writeHead(404);
      response.end('not a WebSocket endpoint');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${port}`;
      const fetchMock = vi.fn().mockResolvedValue(versionResponse({
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/not-cdp`,
      }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchUsageThroughCdp(account({ key: 'ws-404', cdp_http: endpoint }));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('WebSocket handshake failed');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe('CDP startup fail-fast validation', () => {
  test.each([
    ['malformed Browser.getVersion JSON', '{broken', 'malformed Browser.getVersion response'],
    ['invalid Browser.getVersion product', JSON.stringify({ id: 0, result: { product: 'Safari/18' } }), 'invalid Browser.getVersion product'],
  ])('does not retry %s', async (_caseName, rawResponse, expectedError) => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse());
    vi.stubGlobal('fetch', fetchMock);
    state.browserProbeRaw = rawResponse;

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(false);
    expect(result.error).toContain(expectedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(state.methods).not.toContain('Target.createTarget');
    expect(state.providerDispatches).toBe(0);
  });

  test('uses only synthetic local CDP endpoints in test configuration', () => {
    const endpoints = loadConfig().accounts
      .map((configuredAccount) => configuredAccount.cdp_http)
      .filter((endpoint): endpoint is string => Boolean(endpoint));

    expect(endpoints).not.toContainEqual(expect.stringContaining('retired.example.com'));
    expect(new Set(endpoints)).toEqual(new Set(['http://127.0.0.1:18802']));
  });

  test.each([
    ['HTTP 400', () => versionResponse({}, 400), 'HTTP 400'],
    ['HTTP 500', () => versionResponse({}, 500), 'HTTP 500'],
    ['HTTP redirect', () => versionResponse('', 302), 'HTTP 302'],
    ['malformed JSON', () => versionResponse('{broken'), 'malformed /json/version JSON'],
    ['trailing JSON', () => versionResponse(`${JSON.stringify({ webSocketDebuggerUrl: browserWsUrl })} trailing`), 'malformed /json/version JSON'],
    ['oversized JSON', () => versionResponse('x'.repeat((64 * 1024) + 1)), 'response exceeds 65536 bytes'],
    ['missing WebSocket URL', () => versionResponse({ Browser: 'Chrome' }), 'missing browser WebSocket URL'],
    ['non-CDP WebSocket URL', () => versionResponse({ webSocketDebuggerUrl: 'http://127.0.0.1:18802/json' }), 'invalid CDP browser WebSocket URL'],
    ['cross-endpoint WebSocket URL', () => versionResponse({ webSocketDebuggerUrl: 'ws://127.0.0.1:18803/devtools/browser/other' }), 'invalid CDP browser WebSocket URL'],
  ])('fails fast on %s', async (_caseName, response, expectedError) => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(false);
    expect(result.error).toContain(expectedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(state.sockets).toHaveLength(0);
    expect(state.providerDispatches).toBe(0);
  });

  test('rejects invalid cdp_http before touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUsageThroughCdp(account({ cdp_http: 'ws://127.0.0.1:18802' }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('cdp_http must be an absolute HTTP(S) origin');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.sockets).toHaveLength(0);
  });

  test('does not retry a permanent discovery transport error', async () => {
    const cause = Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' });
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(0);
  });
});

describe('CDP startup lifetime and ownership', () => {
  test('enforces one startup deadline and aborts each hanging discovery attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchUsageThroughCdp(account());
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('startup deadline exceeded after 30000ms');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(state.sockets).toHaveLength(0);
  });

  test('keeps WebSocket handshake retries inside the same startup deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(versionResponse()));
    vi.stubGlobal('fetch', fetchMock);
    state.wsPlans.push(
      { kind: 'hang' },
      { kind: 'hang' },
      { kind: 'hang' },
      { kind: 'hang' },
      { kind: 'hang' },
    );

    const pending = fetchUsageThroughCdp(account());
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('startup deadline exceeded after 30000ms');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(state.sockets).toHaveLength(5);
    expect(state.sockets.every((socket) => socket.readyState === FakeWebSocket.CLOSED)).toBe(true);
  });

  test('cancels startup without retrying and leaves no socket or target', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const pending = fetchUsageThroughCdp(account(), { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('CDP startup cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(0);
    expect(state.methods).not.toContain('Target.createTarget');
  });

  test('keeps shared startup alive when only one concurrent waiter cancels', async () => {
    let resolveDiscovery!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveDiscovery = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const cancelled = fetchUsageThroughCdp(account(), { signal: controller.signal });
    const continuing = fetchUsageThroughCdp(account());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await cancelled).error).toContain('CDP startup cancelled');
    resolveDiscovery(versionResponse());
    const result = await continuing;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(1);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.providerDispatches).toBe(1);
  });

  test('shares one in-flight establishment per account and closes one target/socket', async () => {
    let resolveDiscovery!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveDiscovery = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const requests = Array.from({ length: 16 }, () => fetchUsageThroughCdp(account()));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveDiscovery(versionResponse());
    const results = await Promise.all(requests);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(1);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.providerDispatches).toBe(16);

    await closeAllSessions();
    expect(state.methods.filter((method) => method === 'Target.closeTarget')).toHaveLength(1);
    expect(state.closedSockets).toBe(1);
    expect(state.sockets.every((socket) => socket.readyState === FakeWebSocket.CLOSED)).toBe(true);
  });

  test('rebuilds a half-dead cached session before the next provider dispatch', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(versionResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchUsageThroughCdp(account());
    state.browserProbeErrors.push('connection is gone');
    const second = await fetchUsageThroughCdp(account());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.methods.filter((method) => method === 'Browser.getVersion')).toHaveLength(3);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(2);
    expect(state.providerDispatches).toBe(2);
    expect(state.closedSockets).toBe(1);
  });

  test('closes a target and socket when session attachment fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse());
    vi.stubGlobal('fetch', fetchMock);
    state.attachError = 'attach failed';

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('attach failed');
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.methods.filter((method) => method === 'Target.attachToTarget')).toHaveLength(1);
    expect(state.methods.filter((method) => method === 'Target.closeTarget')).toHaveLength(1);
    expect(state.providerDispatches).toBe(0);
    expect(state.closedSockets).toBe(1);
  });

  test('never retries after provider evaluation dispatch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse());
    vi.stubGlobal('fetch', fetchMock);
    state.providerError = 'Cannot find context with specified id';

    const result = await fetchUsageThroughCdp(account());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cannot find context');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.sockets).toHaveLength(1);
    expect(state.providerDispatches).toBe(1);
    expect(state.methods.filter((method) => method === 'Target.createTarget')).toHaveLength(1);
    expect(state.methods.filter((method) => method === 'Target.closeTarget')).toHaveLength(1);
    expect(state.closedSockets).toBe(1);
  });
});
