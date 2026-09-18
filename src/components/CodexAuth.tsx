'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexDeviceFlowPublicState } from '@/lib/codex-auth';
import { countdown, fmtDate } from './format';
import { Button } from './ui';

type AuthState = CodexDeviceFlowPublicState;

/** Codex device-authorization flow: start, then poll status until it settles. */
export function useCodexAuth(identity: string, onAuthorized: () => void) {
  const [state, setState] = useState<AuthState | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onAuthorizedRef = useRef(onAuthorized);
  onAuthorizedRef.current = onAuthorized;

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPoll, [stopPoll]);

  const poll = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/codex-auth/${encodeURIComponent(identity)}/status`, { cache: 'no-store' });
        const next = (await res.json()) as AuthState;
        setState(next);
        if (next.state !== 'pending') {
          stopPoll();
          if (next.state === 'authorized') setTimeout(() => onAuthorizedRef.current(), 750);
        }
      } catch (error) {
        setState({
          identity,
          state: 'failed',
          verificationUrl: null,
          userCode: null,
          expiresAt: null,
          startedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        });
        stopPoll();
      }
    }, 2500);
  }, [identity, stopPoll]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const res = await fetch(`/api/codex-auth/${encodeURIComponent(identity)}/start`, { method: 'POST', cache: 'no-store' });
      const next = (await res.json()) as AuthState;
      setState(next);
      poll();
    } catch (error) {
      setState({
        identity,
        state: 'failed',
        verificationUrl: null,
        userCode: null,
        expiresAt: null,
        startedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  }, [identity, poll]);

  return { state, start, starting };
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function CodexAuthBox({ state, now, tz }: { state: AuthState | null; now: number; tz: string }) {
  if (!state) return null;
  return (
    <div className="codex-auth">
      <section className={`codex-device ${state.state}`}>
        <div>
          <strong>Codex authorization: {state.state}</strong>
          {state.message ? <p className="t-small">{state.message}</p> : null}
        </div>
        {state.verificationUrl ? (
          <div className="codex-device-row">
            <span>Open</span>
            <a href={state.verificationUrl} target="_blank" rel="noopener noreferrer">
              {state.verificationUrl}
            </a>
            <Button variant="ghost" size="sm" onClick={() => copy(state.verificationUrl!)}>Copy link</Button>
          </div>
        ) : null}
        {state.userCode ? (
          <div className="codex-device-row">
            <span>Code</span>
            <code>{state.userCode}</code>
            <Button variant="ghost" size="sm" onClick={() => copy(state.userCode!)}>Copy code</Button>
          </div>
        ) : null}
        {state.expiresAt ? (
          <div className="t-small">
            Expires {fmtDate(state.expiresAt, tz)} · {countdown(state.expiresAt, now)}
          </div>
        ) : null}
      </section>
    </div>
  );
}
