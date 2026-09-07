'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProductSubscription } from '@/lib/overview';

import type { AccountBrowserState as BrowserState } from '@/lib/account-browser-types';

const labels: Record<BrowserState['status'], string> = {
  unconfigured: 'Account browser not configured', login_required: 'Sign-in required',
  identity_unknown: 'Identity unverified', mismatch: 'Different account signed in',
  ready: 'Verified account', unavailable: 'Account browser unavailable',
};

type AccessProps = ({ subscription: ProductSubscription; account?: never } | { subscription?: never; account: { key: string; provider: string; email: string } }) & { children?: ReactNode };
export function AccountBrowserAccess({ subscription, account, children }: AccessProps) {
  const provider = subscription?.provider || account?.provider || '';
  const label = subscription?.label || account?.email || 'Email not recorded';
  const selector: Record<string, string> = subscription ? { subscriptionId: subscription.id } : { accountKey: account!.key };
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const generation = useRef(0);
  const opening = useRef(false);
  const endpoint = `/api/account-browser?${new URLSearchParams(selector).toString()}`;
  const refresh = useCallback(async () => {
    if (opening.current) return;
    const request = ++generation.current;
    setNow(Date.now());
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('Account browser status unavailable.');
      const next: BrowserState = await response.json();
      if (request === generation.current) { setState(next); setError(''); }
    } catch {
      if (request === generation.current) { setState(null); setError('Account browser status unavailable.'); }
    }
  }, [endpoint]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { clearInterval(timer); generation.current++; };
  }, [refresh]);

  async function openAccount() {
    if (opening.current) return;
    // Reserve the tab in the click handler so an asynchronous status check is popup-safe.
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('Allow a new tab, then try again.'); return; }
    tab.opener = null;
    tab.document.title = 'Opening account browser';
    tab.document.body.textContent = `Opening ${provider} for ${state?.intendedEmail || label}…`;
    opening.current = true; generation.current++; setBusy(true); setError('');
    try {
      const response = await fetch('/api/account-browser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...selector, action: state?.status === 'ready' ? 'manage' : 'login' }) });
      const next: BrowserState & { error?: string } = await response.json();
      if (next.status) setState(next);
      setNow(Date.now());
      if (!next.remoteUrl) throw new Error(next.message || next.error || 'The account browser could not be opened.');
      const url = new URL(next.remoteUrl, window.location.origin);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The account browser address is unavailable.');
      tab.location.replace(url.href);
      if (!response.ok) setError(next.message || 'The account page could not be opened automatically.');
    } catch (cause) {
      tab.close(); setError(cause instanceof Error ? cause.message : 'The account browser could not be opened.');
    } finally { opening.current = false; setBusy(false); }
  }

  const age = state?.observedAt ? now - Date.parse(state.observedAt) : NaN;
  const fresh = Number.isFinite(age) && age >= -60_000 && age <= (state?.maxAgeSeconds ?? 30) * 1000;
  const ready = state?.status === 'ready' && fresh;
  const status = state?.status === 'ready' && !fresh ? 'Verification needs refreshing' : state ? labels[state.status] : error || 'Checking account browser…';
  return <div className="account-browser-access">
    {account ? <small>Provider website · separate browser sign-in</small> : null}
    <div className="row-actions">
      {state?.configured ? <button className="small-button" disabled={busy || state.status === 'unavailable'} onClick={openAccount} title={`${provider} · ${state.intendedEmail || label}`}>
        {busy ? 'Opening…' : ready ? 'Manage account ↗' : subscription ? 'Open browser ↗' : 'Open account browser ↗'}
      </button> : state?.status === 'unconfigured' ? <>
        {subscription?.loginUrl ? <a className="action-link" href={subscription?.loginUrl} target="_blank" rel="noreferrer">Sign in ↗</a> : null}
        {subscription?.manageUrl ? <a href={subscription?.manageUrl} target="_blank" rel="noreferrer" title={`Current browser session. Check the signed-in account: ${label}.`}>Billing ↗</a> : null}
      </> : null}
      {children}
    </div>
    <div className="account-browser-meta">
      <small className={`account-browser-status ${ready ? 'verified' : ''}`} role="status">{state?.status === 'unconfigured' && (subscription?.loginUrl || subscription?.manageUrl) ? 'Current browser session' : status}</small>
      <button className="account-browser-refresh" onClick={() => void refresh()} disabled={busy} aria-label={`Refresh ${provider} account browser status`} title="Check account status again">↻</button>
      {state ? <details className="account-browser-details"><summary>Details</summary><div>
        {state.configured && state.intendedEmail ? <small>For {provider} · {state.intendedEmail}</small> : null}
        {state.status === 'unconfigured' ? <small>{labels.unconfigured}</small> : null}
        {state.observedAt ? <small title={state.observedAt}>Checked {fresh ? 'just now' : 'earlier'} · {new Date(state.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small> : null}
        {state.proxyAccountId && state.proxy ? <>
          <small>Proxy · {state.proxy.status === 'linked' ? 'linked' : state.proxy.status === 'not_found' ? 'not in policy' : state.proxy.status === 'unavailable' ? 'status unavailable' : 'not linked'}</small>
          <small>Routing {state.proxy.enabled === null ? 'unknown' : state.proxy.enabled ? 'enabled' : 'disabled'}{state.proxy.policyVersion === null ? '' : ` · policy ${state.proxy.policyVersion}`}</small>
          <small>{state.proxy.nativeBound === null ? 'Proxy binding unknown' : state.proxy.nativeBound ? 'Proxy binding configured' : 'Proxy binding missing'} · quota {state.proxy.quotaState || 'unknown'}</small>
          {state.proxy.observedAt ? <small>Proxy checked {new Date(state.proxy.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small> : null}
        </> : null}
      </div></details> : null}
    </div>
    {state?.status === 'mismatch' && state.verifiedEmail ? <small className="account-browser-mismatch">Signed in as {state.verifiedEmail}</small> : null}
    {error && state ? <small role="alert">{error}</small> : null}
  </div>;
}
