'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReauthJob } from '@/lib/proxy-reauth';
import { Button, ButtonLink, Dialog, Pill } from './ui';

type Status = { configured: boolean; job: ReauthJob | null };
const running = (job: ReauthJob | null) => Boolean(job && !job.finishedAt);

/** One button for the proxy's OAuth re-login through the account's signed-in browser profile; confirmed, then polled. */
export function ProxyReconnect({ accountKey }: { accountKey: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endpoint = `/api/proxy-reauth?${new URLSearchParams({ accountKey }).toString()}`;
  const poll = useCallback(async () => {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) return;
      const next = (await response.json()) as Status;
      setStatus(next);
      if (running(next.job)) timer.current = setTimeout(() => void poll(), 2_000);
    } catch { /* keep the last state */ }
  }, [endpoint]);
  useEffect(() => { void poll(); return () => clearTimeout(timer.current); }, [poll]);

  async function start() {
    setConfirming(false); setError('');
    try {
      const response = await fetch('/api/proxy-reauth', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountKey }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(typeof body.error === 'string' ? body.error : `Reconnect failed (HTTP ${response.status})`); return; }
      setStatus(body as Status);
      clearTimeout(timer.current); timer.current = setTimeout(() => void poll(), 1_000);
    } catch { setError('Reconnect could not be started'); }
  }

  if (!status?.configured) return null;
  const job = status.job;
  const tone = !job ? 'idle' : job.state === 'succeeded' ? 'ok' : job.state === 'failed' ? 'bad' : 'warn';
  return <div className="proxy-reconnect">
    <Button size="sm" variant="primary" disabled={running(job)} onClick={() => setConfirming(true)}>{running(job) ? 'Reconnecting…' : 'Reconnect proxy'}</Button>
    {job ? <Pill tone={tone} title={job.message}>{job.state.replace(/_/g, ' ')}</Pill> : null}
    {job ? <span className="t-small">{job.message}{job.finishedAt ? ` · ${new Date(job.finishedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</span> : null}
    {job?.suggestAccountBrowser && job.remoteUrl ? <ButtonLink size="sm" variant="secondary" href={job.remoteUrl} target="_blank" rel="noreferrer">Open account browser ↗</ButtonLink> : null}
    {error ? <span className="t-small" role="alert">{error}</span> : null}
    <Dialog open={confirming} title="Reconnect the proxy credential?" titleId={`proxy-reconnect-${accountKey}`}
      description="Zecori opens the proxy's Claude sign-in in this account's browser profile. If claude.ai asks you to log in, do it in the account browser. Authorize is clicked only when claude.ai shows this account's e-mail; the tab closes when the flow ends."
      onClose={() => setConfirming(false)}
      footer={<><Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button><Button variant="primary" onClick={() => void start()}>Start reconnect</Button></>} />
  </div>;
}
