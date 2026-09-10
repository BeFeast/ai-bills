'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProductOverview } from '@/lib/overview';
import type { ProviderUsage } from '@/lib/usage';
import { kimiCodingUsage, kimiUsagePercent, cursorLegacyPercent, type ClaudeUsagePayload, type CodexUsagePayload, type KimiUsagePayload, type CursorUsagePayload } from '@/lib/usage';
import { fmtMoney, fmtTokens, fmtDate } from './format';
import { ProviderIcon } from './ProviderIcon';
import { AccountBrowserAccess } from './AccountBrowserAccess';
import type { RegistryAccount } from '@/lib/accounts';

type View = 'overview' | 'subscriptions' | 'accounts' | 'usage' | 'routing' | 'details';
type SubscriptionDraft = { id: string; label: string; amount: string; currency: string; period: 'month' | 'year' | 'unknown'; renewsAt: string; endsAt: string; status: string };
const money = (amount: number | null, currency = 'USD') => amount === null ? 'Price not recorded' : new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
function date(value: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jerusalem' }) : null; }
function highestKnown(values: Array<number | null | undefined>) {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? Math.max(...known) : null;
}
function quotaUsed(account: ProviderUsage): number | null {
  if (account.account.provider === 'claude') {
    const data = account.data as ClaudeUsagePayload | undefined;
    return highestKnown([data?.five_hour?.utilization, data?.seven_day?.utilization, ...(data?.limits ?? []).filter(limit => limit.kind === 'session' || limit.kind === 'weekly_all').map(limit => limit.percent)]);
  }
  if (account.account.provider === 'codex') {
    const data = account.data as CodexUsagePayload | undefined;
    if (data?.rate_limit?.limit_reached || data?.rate_limit?.allowed === false) return 100;
    return highestKnown([data?.rate_limit?.primary_window?.used_percent, data?.rate_limit?.secondary_window?.used_percent]);
  }
  if (account.account.provider === 'kimi') {
    const data = account.data as KimiUsagePayload | undefined;
    const coding = Array.isArray(data?.usages) ? kimiCodingUsage(data) : null;
    return highestKnown([kimiUsagePercent(coding?.detail), ...(coding?.limits ?? []).map(window => kimiUsagePercent(window.detail))]);
  }
  if (account.account.provider === 'cursor') {
    const data = account.data as CursorUsagePayload | undefined;
    const plan = data?.currentPeriod?.planUsage;
    if (typeof plan?.totalPercentUsed === 'number' && Number.isFinite(plan.totalPercentUsed)) return plan.totalPercentUsed;
    if (typeof plan?.limit === 'number' && plan.limit > 0) {
      if (typeof plan.used === 'number') return highestKnown([plan.used / plan.limit * 100]);
      if (typeof plan.remaining === 'number') return highestKnown([(plan.limit - plan.remaining) / plan.limit * 100]);
    }
    return cursorLegacyPercent(data);
  }
  return null;
}

export function ProductOverviewPanel({ data, accounts, registry = [], view, onView, onUpdated, error }: { data: ProductOverview | null; accounts: ProviderUsage[]; registry?: RegistryAccount[]; view: View; onView: (view: View) => void; onUpdated?: () => void | Promise<void>; error?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    if (draft && !dialog.current?.open) dialog.current?.showModal();
    else if (!draft && dialog.current?.open) dialog.current.close();
  }, [draft]);
  async function saveSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true); setSaveError('');
    try {
      const { label: _label, ...values } = draft;
      const response = await fetch('/api/overview', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, amount: draft.amount === '' ? null : Number(draft.amount), renewsAt: draft.renewsAt || null, endsAt: draft.endsAt || null }) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Unable to save subscription.');
      await onUpdated?.(); setDraft(null);
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Unable to save subscription.'); }
    finally { setSaving(false); }
  }
  if (!data) return <section className="product-panel"><h2>Your subscriptions and usage</h2><p>{error || 'Loading subscription prices and usage…'}</p></section>;
  const subscriptions = data.subscriptions.filter(s => s.status !== 'cancelled' && s.status !== 'expired');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
  const upcoming = subscriptions.filter(s => (s.renewsAt || s.endsAt || '').slice(0,10) >= today).sort((a,b) => (a.renewsAt || a.endsAt || '').localeCompare(b.renewsAt || b.endsAt || ''));
  const costs = data.summary.knownMonthlyCosts.map(c => money(c.amount,c.currency)).join(' + ') || 'Not recorded';
  const api = data.usage.apiEquivalentUsd ?? data.usage.pricedApiEquivalentUsd;
  const partialApi = data.usage.apiEquivalentUsd === null && api !== null;
  const month = new Date(`${data.month}-15T12:00:00Z`).toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  const otherAccounts = registry.filter(account => !['claude', 'codex'].includes(account.provider));
  const shownAccounts = view === 'overview' ? otherAccounts.filter(account => /meta|muse|kimi|xai|x.ai|cursor|ollama/i.test(account.provider)) : otherAccounts;
  return <>
    {view === 'overview' ? <section className="product-panel" aria-label="Account availability">
      <div className="section-heading"><div><h2>Account availability</h2><p>Automatic quota observations. Website sign-in is only needed when a source asks for it.</p></div><button className="small-button" onClick={() => onView('accounts')}>Accounts & sign-in →</button></div>
      <div className="quota-strip">{!accounts.length ? <p className="data-note">Loading account quotas…</p> : null}{accounts.map(a => {
        const observed = Date.parse(a.fetchedAt); const age = Date.now() - observed;
        const fresh = a.ok && Number.isFinite(age) && age >= -60_000 && age <= 600_000;
        const used = quotaUsed(a); const remaining = fresh && used !== null ? Math.max(0, Math.min(100, 100-used)) : null;
        const detail = !a.ok ? a.status === 401 || a.status === 403 ? 'Sign-in needs attention' : a.error?.includes('first quota') ? 'First observation pending' : 'Source unavailable · other accounts continue updating' : !fresh ? 'Observation stale · availability unknown' : remaining === 0 ? 'Allowance exhausted · see reset windows' : remaining === null ? 'Quota not reported by this source' : 'Most restricted observed window';
        return <button className="quota-mini" key={a.account.key} onClick={() => onView('accounts')}><span className="provider-identity"><ProviderIcon provider={a.account.provider} /><span><small>{a.account.provider}</small>{a.account.email || 'Email not recorded'}</span></span><strong>{remaining === null ? 'Quota unknown' : remaining === 0 ? 'Exhausted' : `${Number(remaining.toFixed(1))}% left`}</strong><div className="quota-track"><i style={{width:`${remaining ?? 0}%`,background:remaining !== null && remaining < 15 ? 'var(--warn)' : 'var(--accent)'}} /></div><small>{detail}</small>{Number.isFinite(observed) ? <small>Observed {fmtDate(a.fetchedAt,'Asia/Jerusalem')}</small> : null}</button>;
      })}</div>
      {subscriptions.filter(s => !s.accountKeys.some(key => accounts.some(a => a.account.key === key))).length ? <p className="data-note">{subscriptions.filter(s => !s.accountKeys.some(key => accounts.some(a => a.account.key === key))).length} plans have no linked automatic quota source. Their allowance is unknown. <button className="text-button" onClick={() => onView('subscriptions')}>View source coverage →</button></p> : null}
    </section> : null}
    {view === 'overview' ? <section className="product-summary" aria-label="Subscription overview">
      <button className="summary-answer" onClick={() => onView('subscriptions')}><span>Active subscriptions</span><strong>{data.summary.activeSubscriptionCount}{data.summary.subscriptionCountComplete === false ? '+' : ''}</strong><small>{data.summary.subscriptionCountComplete ? 'Plans and accounts' : 'Some plan statuses need checking'} →</small></button>
      <button className="summary-answer" onClick={() => onView('subscriptions')}><span>Subscription cost / month</span><strong>{data.summary.unknownPriceCount && data.summary.knownMonthlyCosts.length ? '≥ ' : ''}{costs}{data.summary.monthlyCostEvidence === 'estimated' ? ' est.' : ''}</strong><small>{data.summary.unknownPriceCount ? `${data.summary.unknownPriceCount} prices still need checking` : data.summary.monthlyCostEvidence === 'estimated' ? 'Includes estimated plan prices' : 'Recurring plan prices'} →</small></button>
      <button className="summary-answer" onClick={() => onView('usage')}><span>If paid by API · {month}</span><strong>{data.usage.tokens === null ? 'Usage unavailable' : api === null ? 'Pricing incomplete' : `${partialApi ? '≥ ' : ''}${fmtMoney(api)}`}</strong><small>{data.usage.reconciliation?.status === 'partial' ? 'Native observations may overlap; see confirmed subtotal' : data.usage.tokens === null ? 'Monthly usage has not been imported' : partialApi ? 'Known prices; some models unpriced' : `${fmtTokens(data.usage.tokens)} tokens measured`} →</small></button>
      <button className="summary-answer" onClick={() => onView('subscriptions')}><span>Next renewal / expiry</span><strong>{upcoming[0] ? date(upcoming[0].renewsAt || upcoming[0].endsAt) : 'Dates need checking'}</strong><small>{upcoming[0] ? `${upcoming[0].provider} · ${upcoming[0].label}` : 'Open billing beside each plan'} →</small></button>
    </section> : null}
    {view === 'overview' || view === 'accounts' ? <section className="product-panel"><div className="section-heading"><div><h2>Other accounts</h2><p>Accounts are tracked independently of CLIProxyAPI. A model listing does not prove available quota or funds.</p></div>{view === 'overview' ? <button className="small-button" onClick={() => onView('accounts')}>All {registry.length} accounts →</button> : null}</div><div className="quota-strip">
      {shownAccounts.map(account => {
        const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
        const subscription = data.subscriptions.find(plan => normalize(plan.provider) === normalize(account.provider));
        const website = account.websiteUrl || subscription?.manageUrl || subscription?.loginUrl;
        const observed = account.quota.observedAt ? Date.parse(account.quota.observedAt) : NaN;
        const fresh = account.quota.status === 'fresh' && Number.isFinite(observed) && Date.now() - observed <= 600_000;
        return <article className="quota-mini" key={account.id}><span className="provider-identity"><ProviderIcon provider={account.provider} /><span><small>{account.provider}</small>{account.label}</span></span><strong>{fresh && account.quota.remaining !== null ? account.quota.remaining === 0 ? 'Exhausted' : `${account.quota.remaining}${account.quota.unit === 'percent' ? '%' : ''} left` : 'Quota unknown'}</strong><small>{account.quota.status === 'error' ? 'Automatic source failed; other sources continue' : account.quota.status === 'stale' ? 'Source observation is stale' : fresh ? 'Recent provider observation' : 'No current automatic quota observation'}</small><small>{account.routingEnrolled === true ? 'Proxy routing linked' : account.routingEnrolled === false ? 'Independent account · not enrolled in proxy routing' : 'Proxy linkage unknown'}</small>{Number.isFinite(observed) ? <small>Observed {fmtDate(account.quota.observedAt!,'Asia/Jerusalem')}</small> : null}{account.operatorNote ? <small>Operator note: {account.operatorNote}</small> : null}{website ? <a className="action-link" href={website} target="_blank" rel="noreferrer" title="Provider website in your current browser; verify the signed-in account">Provider website ↗</a> : null}</article>;
      })}
      {!shownAccounts.length ? <p className="data-note">Account inventory has not supplied additional accounts yet.</p> : null}
    </div></section> : null}

    {view === 'overview' || view === 'subscriptions' ? <section className="product-panel" id="subscriptions">
      <div className="section-heading"><div><h2>Subscriptions</h2><p>What you pay, when it renews, and where to manage it.</p></div>{view === 'overview' ? <button className="small-button" onClick={() => onView('subscriptions')}>All plans →</button> : null}</div>
      <div className="table-wrap"><table className="subscription-table"><thead><tr><th>Subscription / account</th><th>Plan</th><th>Cost</th><th>Renewal or expiry</th><th>Access</th></tr></thead><tbody>
      {(view === 'overview' ? subscriptions.slice(0,4) : data.subscriptions).map(s => <tr key={s.id}>
        <td data-label="Subscription"><div className="provider-identity"><ProviderIcon provider={s.provider} /><div><strong>{s.label}</strong><small>{s.provider}{s.status === 'cancelled' || s.status === 'expired' ? ` · ${s.status}` : s.status !== 'active' ? ' · status unverified' : ''}</small></div></div></td>
        <td data-label="Plan">{s.plan || 'Plan not recorded'}</td>
        <td data-label="Cost"><strong>{money(s.amount,s.currency)}</strong>{s.amount !== null ? <small>per {s.period === 'year' ? 'year' : s.period === 'month' ? 'month' : 'billing period'}{s.costEvidence === 'estimated' ? ' · estimate' : ''}</small> : null}</td>
        <td data-label="Renewal / expiry">{s.renewsAt ? <><strong>{date(s.renewsAt)}</strong><small>{s.renewsAt.slice(0,10) < today ? 'Past renewal; check billing' : 'Renews'}</small></> : s.endsAt ? <><strong>{date(s.endsAt)}</strong><small>{s.endsAt.slice(0,10) < today ? 'Recorded end date' : 'Ends'}</small></> : <><span className="date-missing">Date not recorded</span><small>Check account billing</small></>}</td>
        <td data-label="Access"><AccountBrowserAccess subscription={s}>{view === 'subscriptions' ? <button className="small-button" aria-label={`Edit ${s.label} subscription`} onClick={() => { setSaveError(''); setDraft({ id: s.id, label: s.label, amount: s.amount === null ? '' : String(s.amount), currency: s.currency, period: s.period, renewsAt: s.renewsAt?.slice(0,10) || '', endsAt: s.endsAt?.slice(0,10) || '', status: s.status }); }}>Edit</button> : null}</AccountBrowserAccess></td>
      </tr>)}</tbody></table></div>
      {view === 'overview' && subscriptions.length > 4 ? <button className="text-button" onClick={() => onView('subscriptions')}>Show all {subscriptions.length} plan entries →</button> : null}
    </section> : null}

    {view === 'overview' || view === 'usage' ? <section className="product-panel"><div className="section-heading"><div><h2>Who uses the most?</h2><p>{month} · {data.usage.tokens === null ? 'Monthly usage unavailable' : `${fmtTokens(data.usage.tokens)} tokens · ${data.usage.requests?.toLocaleString() ?? 'Unknown'} requests`}</p></div>{view === 'overview' ? <button className="small-button" onClick={() => onView('usage')}>Usage details →</button> : null}</div>
      {data.usage.reconciliation?.status === 'partial' ? <p className="data-note" role="status">Combined usage is unknown: {data.usage.reconciliation.nativeObservations?.toLocaleString()} native observations may overlap with proxy traffic. Rankings below show the confirmed subtotal of {fmtTokens(data.usage.reconciliation.confirmedTokens ?? 0)} tokens and {data.usage.reconciliation.confirmedRequests?.toLocaleString()} requests. No repeated observations are added to that subtotal.</p> : null}
      <div className="rank-columns">{([['By client',data.usage.byClient],['By model',data.usage.byModel],['By account',data.usage.byAccount ?? []]] as const).map(([label,groups]) => {
        const ranked = [...groups].sort((a,b) => b.tokens-a.tokens);const max=ranked[0]?.tokens || 1;
        return <div key={label}><h3>{label}</h3>{(view === 'overview' ? ranked.slice(0,5) : ranked).map((r,i) => <div className="rank-row" key={r.name}><div className="rank-label"><span><b>{i+1}.</b> {r.name}</span><strong>{fmtTokens(r.tokens)}</strong></div><div className="rank-track"><i style={{width:`${r.tokens/max*100}%`}} /></div><small>{r.requests.toLocaleString()} requests · {r.apiEquivalentUsd === null ? r.pricedApiEquivalentUsd === null ? 'API price unknown' : `≥ ${fmtMoney(r.pricedApiEquivalentUsd)} at known API prices` : `${fmtMoney(r.apiEquivalentUsd)} at API prices`}</small></div>)}{!ranked.length ? <p>No monthly usage data available yet.</p> : null}</div>;
      })}</div>
      {Object.keys(data.usage.unpriced).length ? <details className="pricing-note"><summary>{Object.keys(data.usage.unpriced).length} models have no verified API price</summary><p>Tokens are included in usage. Their cost is excluded from the known API subtotal.</p><ul>{Object.entries(data.usage.unpriced).map(([name,tokens]) => <li key={name}>{name}: {fmtTokens(tokens)} tokens</li>)}</ul></details> : null}
      {data.usage.observedAt ? <p className="data-note">Usage updated {fmtDate(data.usage.observedAt,'Asia/Jerusalem')}</p> : null}
    </section> : null}


    <dialog ref={dialog} className="subscription-editor" aria-labelledby="subscription-editor-title" onCancel={event => { if (saving) event.preventDefault(); else setDraft(null); }} onClose={() => setDraft(null)}>
      {draft ? <form onSubmit={saveSubscription}>
        <h2 id="subscription-editor-title">Edit {draft.label}</h2>
        <p>Record the price and dates shown in your billing settings. This does not change the provider subscription.</p>
        <div className="subscription-editor-fields">
          <label className="field">Price<input type="number" min="0" step="0.01" value={draft.amount} placeholder="Unknown" onChange={event => setDraft({ ...draft, amount: event.target.value })} /></label>
          <label className="field">Currency<input required pattern="[A-Z]{3}" maxLength={3} value={draft.currency} onChange={event => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} /></label>
          <label className="field">Billing period<select value={draft.period} onChange={event => setDraft({ ...draft, period: event.target.value as SubscriptionDraft['period'] })}><option value="month">Monthly</option><option value="year">Yearly</option><option value="unknown">Unknown</option></select></label>
          <label className="field">Status<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}><option value="active">Active</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option><option value="unknown">Unknown</option></select></label>
          <label className="field">Renewal date<input type="date" value={draft.renewsAt} onChange={event => setDraft({ ...draft, renewsAt: event.target.value })} /></label>
          <label className="field">End date<input type="date" value={draft.endsAt} onChange={event => setDraft({ ...draft, endsAt: event.target.value })} /></label>
        </div>
        {saveError ? <p role="alert" className="inline-error">{saveError}</p> : null}
        <div className="subscription-editor-actions"><button type="button" className="small-button" disabled={saving} onClick={() => setDraft(null)}>Cancel</button><button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save subscription'}</button></div>
      </form> : null}
    </dialog>
  </>;
}
