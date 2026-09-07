import type WebSocket from 'ws';
import { CdpStartupBudget, connectCdpBrowser } from './cdp-startup';

export type BrowserTarget = { targetId: string; type: string; url: string };
export interface AccountBrowserConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, any>>;
  close(): void;
}

/** Reuse the existing bounded, redirect-rejecting CDP startup transport. Unlike
 * usage collection, closing this socket never closes or navigates a browser tab. */
export async function connectAccountBrowser(endpoint: string): Promise<AccountBrowserConnection> {
  const signal = AbortSignal.timeout(12_000);
  const ws = await connectCdpBrowser(endpoint, new CdpStartupBudget('Account browser', signal));
  let nextId = 1;
  const pending = new Map<number, { method: string; reject: (error: Error) => void; resolve: (value: Record<string, any>) => void }>();
  const fail = () => { for (const item of [...pending.values()]) item.reject(new Error('Account browser connection closed')); };
  const receive = (event: WebSocket.MessageEvent) => {
    let message: { id?: number; result?: Record<string, any>; error?: unknown };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const item = message.id === undefined ? undefined : pending.get(message.id);
    if (!item) return;
    if (message.error) item.reject(new Error(`Account browser ${item.method} failed`));
    else item.resolve(message.result ?? {});
  };
  ws.addEventListener('message', receive);
  ws.addEventListener('close', fail);
  ws.addEventListener('error', fail);
  signal.addEventListener('abort', fail, { once: true });
  return {
    send(method, params = {}, sessionId) {
      if (signal.aborted) return Promise.reject(new Error('Account browser deadline exceeded'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const finish = (error?: Error, value?: Record<string, any>) => {
          clearTimeout(timer); pending.delete(id);
          if (error) reject(error); else resolve(value ?? {});
        };
        const timer = setTimeout(() => finish(new Error(`Account browser ${method} timed out`)), method === 'Target.createTarget' ? 8_000 : 3_000);
        pending.set(id, { method, reject: error => finish(error), resolve: value => finish(undefined, value) });
        try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { finish(new Error('Account browser send failed')); }
      });
    },
    close() {
      fail(); signal.removeEventListener('abort', fail);
      ws.removeEventListener('message', receive);
      // Termination affects this transport only, not browser targets/profile.
      ws.terminate();
    },
  };
}
