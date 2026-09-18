'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProductSubscription } from '@/lib/overview';

import { canOpenAccountBrowser, type AccountBrowserSelector, type AccountBrowserState as BrowserState } from '@/lib/account-browser-types';
import { Button, ButtonLink, Pill, type PillTone } from './ui';

const labels: Record<BrowserState['status'], string> = {
  unconfigured: 'Account browser not configured', login_required: 'Sign-in required',
  identity_unknown: 'Identity unverified', mismatch: 'Different account signed in',
  ready: 'Verified account', unavailable: 'Account browser unavailable',
};

type AccessProps = ({ subscription: ProductSubscription; account?: never } | { subscription?: never; account: { key: string; provider: string; email: string } }) & {
  children?: ReactNode;
  showEntranceLink?: boolean;
  browserSelector?: AccountBrowserSelector;
  /** `stack` (default): actions over an 11px status line. `row`: status Pill first, then the actions, for account headers. */
  layout?: 'stack' | 'row';
};

export function AccountBrowserAccess({ subscription, account, children, showEntranceLink = true, browserSelector, layout = 'stack' }: AccessProps) {
  const provider = subscription?.provider || account?.provider || '';
  const label = subscription?.label || account?.email || 'Email not recorded';
  const selected = browserSelector ?? (subscription ? { subscriptionId: subscription.id } : { accountKey: account!.key });
  const selector: Record<string, string> = selected.subscriptionId ? { subscriptionId: selected.subscriptionId } : { accountKey: selected.accountKey! };
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
    // Website identity is supplementary to automatic quota collection. Merely
    // opening the dashboard must not poll every dedicated browser profile.
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => { generation.current++; clearInterval(timer); };
  }, []);

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
      if (!canOpenAccountBrowser(next, response.status) || !next.remoteUrl) throw new Error(next.message || next.error || 'The account browser could not be opened.');
      const url = new URL(next.remoteUrl, window.location.origin);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The account browser address is unavailable.');
      tab.location.replace(url.href);
      if (!response.ok) setError(next.message || 'The account page could not be opened automatically.');
    } catch (cause) {
      tab.close(); setError(cause instanceof Error ? cause.message : 'The account browser could not be opened.');
    } finally { opening.current = false; setBusy(false); }
  }

  async function updateLease(action: 'close' | 'renew') {
    if (opening.current) return;
    opening.current = true; generation.current++; setBusy(true); setError('');
    try {
      const response = await fetch('/api/account-browser', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...selector, action }) });
      const next: BrowserState = await response.json();
      if (next.status) setState(next);
      setNow(Date.now());
      if (!response.ok) throw new Error(next.message || 'Browser action could not be completed.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Browser action failed.'); }
    finally { opening.current = false; setBusy(false); }
  }

  const age = state?.observedAt ? now - Date.parse(state.observedAt) : NaN;
  const fresh = Number.isFinite(age) && age >= -60_000 && age <= (state?.maxAgeSeconds ?? 30) * 1000;
  const ready = state?.status === 'ready' && fresh;
  const status = state?.status === 'ready' && !fresh ? 'Verification needs refreshing' : state ? labels[state.status] : error || 'Browser checked when opened';
  const statusText = state?.status === 'unconfigured' && (subscription?.loginUrl || subscription?.manageUrl) ? 'Current browser session' : status;
  const statusTone: PillTone = ready ? 'ok' : state?.status === 'login_required' || state?.status === 'mismatch' || state?.status === 'unavailable' || (state?.status === 'ready' && !fresh) ? 'warn' : 'idle';
  const hasBrowserAccess = state?.configured || (!state && (account || subscription?.accountKeys.length));
  const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const details = state ? <details className="access__details"><summary>Details</summary><div>
    {account ? <small>Provider website · separate browser sign-in</small> : null}
    {state.configured && state.intendedEmail ? <small>For {provider} · {state.intendedEmail}</small> : null}
    {state.status === 'unconfigured' ? <small>{labels.unconfigured}</small> : null}
    {state.observedAt ? <small title={state.observedAt}>Checked {fresh ? 'just now' : 'earlier'} · {time(state.observedAt)}</small> : null}
    {state.proxyAccountId && state.proxy ? <>
      <small>Proxy · {state.proxy.status === 'linked' ? 'linked' : state.proxy.status === 'not_found' ? 'not in policy' : state.proxy.status === 'unavailable' ? 'status unavailable' : 'not linked'}</small>
      <small>Routing {state.proxy.enabled === null ? 'unknown' : state.proxy.enabled ? 'enabled' : 'disabled'}{state.proxy.policyVersion === null ? '' : ` · policy ${state.proxy.policyVersion}`}</small>
      <small>{state.proxy.nativeBound === null ? 'Proxy binding unknown' : state.proxy.nativeBound ? 'Proxy binding configured' : 'Proxy binding missing'} · quota {state.proxy.quotaState || 'unknown'}</small>
      {state.proxy.observedAt ? <small>Proxy checked {time(state.proxy.observedAt)}</small> : null}
    </> : null}
  </div></details> : null;
  const actions = <div className="access__actions">
    {hasBrowserAccess ? <Button variant="secondary" size="sm" disabled={busy} onClick={openAccount} title={`${provider} · ${state?.intendedEmail || label}`}>
      {busy ? 'Opening…' : ready ? 'Manage account ↗' : subscription ? 'Open browser ↗' : 'Open account browser ↗'}
    </Button> : null}
    {subscription?.manageUrl || subscription?.loginUrl ? <ButtonLink variant="ghost" size="sm" href={subscription.manageUrl || subscription.loginUrl!} target="_blank" rel="noreferrer" title={`Opens the provider website in your current browser. Check which account is signed in: ${label}.`}>Provider website ↗</ButtonLink> : null}
    {showEntranceLink && hasBrowserAccess ? <ButtonLink variant="ghost" size="sm" href={`/account-browser?${new URLSearchParams(selector).toString()}`} title="Bookmark this entrance to start the browser when needed">Bookmark browser access</ButtonLink> : null}
    {children}
  </div>;
  const lease = state?.manualLeaseExpiresAt ? <div className="access__lease">
    <span>{Date.parse(state.manualLeaseExpiresAt) <= now ? 'Browser lease expired at ' : 'Browser access expires at '}{time(state.manualLeaseExpiresAt)}</span>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void updateLease('renew')}>Extend session</Button>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void updateLease('close')}>Close session</Button>
  </div> : null;
  const refreshButton = <button type="button" className="access__refresh" onClick={() => void refresh()} disabled={busy} aria-label={`Refresh ${provider} account browser status`} title="Check account status again">↻</button>;
  const mismatch = state?.status === 'mismatch' && state.verifiedEmail ? <small className="access__mismatch">Signed in as {state.verifiedEmail}</small> : null;
  const failure = error && state ? <small className="access__error" role="alert">{error}</small> : null;

  if (layout === 'row') {
    return <div className="access access--row">
      <Pill tone={statusTone} dot><span role="status">{statusText}</span></Pill>
      {actions}
      {refreshButton}
      {details}
      {lease}
      {mismatch}
      {failure}
    </div>;
  }
  return <div className="access">
    {account && !state ? <small className="access__note">Provider website · separate browser sign-in</small> : null}
    {actions}
    {lease}
    <div className="access__meta">
      <small className={`access__status${ready ? ' access__status--ok' : ''}`} role="status">{statusText}</small>
      {refreshButton}
      {details}
    </div>
    {mismatch}
    {failure}
  </div>;
}
