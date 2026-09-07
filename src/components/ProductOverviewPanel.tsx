'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProductOverview } from '@/lib/overview';
import type { ProviderUsage } from '@/lib/usage';
import { kimiCodingUsage, kimiUsagePercent, cursorLegacyPercent, type ClaudeUsagePayload, type CodexUsagePayload, type KimiUsagePayload, type CursorUsagePayload } from '@/lib/usage';
import { fmtMoney, fmtTokens, fmtDate } from './format';

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

export function ProductOverviewPanel({ data, accounts, view, onView, onUpdated, error }: { data: ProductOverview | null; accounts: ProviderUsage[]; view: View; onView: (view: View) => void; onUpdated?: () => void | Promise<void>; error?: string }) {
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
  return <>
    {view === 'overview' ? <section className="product-summary" aria-label="Subscription overview">
      <button className="summary-answer" onClick={() => onView('subscriptions')}><span>Active subscriptions</span><strong>{data.summary.activeSubscriptionCount}{data.summary.subscriptionCountComplete === false ? '+' : ''}</strong><small>{data.summary.subscriptionCountComplete ? 'Plans and accounts' : 'Some plan statuses need checking'} →</small></button>
      <button className="summary-answer" onClick={() => onView('subscriptions')}><span>Subscription cost / month</span><strong>{data.summary.unknownPriceCount && data.summary.knownMonthlyCosts.length ? '≥ ' : ''}{costs}{data.summary.monthlyCostEvidence === 'estimated' ? ' est.' : ''}</strong><small>{data.summary.unknownPriceCount ? `${data.summary.unknownPriceCount} prices still need checking` : data.summary.monthlyCostEvidence === 'estimated' ? 'Includes estimated plan prices' : 'Recurring plan prices'} →</small></button>
      <button className="summary-answer" onClick={() => onView('usage')}><span>If paid by API · {month}</span><strong>{data.usage.tokens === null ? 'Usage unavailable' : api === null ? 'Pricing incomplete' : `${partialApi ? '≥ ' : ''}${fmtMoney(api)}`}</strong><small>{data.usage.tokens === null ? 'Monthly usage has not been imported' : partialApi ? 'Known prices; some models unpriced' : `${fmtTokens(data.usage.tokens)} tokens measured`} →</small></button>
      <button className="summary-answer" onClick={() => onView('subscriptions')}><span>Next renewal / expiry</span><strong>{upcoming[0] ? date(upcoming[0].renewsAt || upcoming[0].endsAt) : 'Dates need checking'}</strong><small>{upcoming[0]?.label || 'Open billing beside each plan'} →</small></button>
    </section> : null}

    {view === 'overview' || view === 'subscriptions' ? <section className="product-panel" id="subscriptions">
      <div className="section-heading"><div><h2>Subscriptions</h2><p>What you pay, when it renews, and where to manage it.</p></div>{view === 'overview' ? <button className="small-button" onClick={() => onView('subscriptions')}>All plans →</button> : null}</div>
      <div className="table-wrap"><table className="subscription-table"><thead><tr><th>Subscription / account</th><th>Plan</th><th>Cost</th><th>Renewal or expiry</th><th>Access</th></tr></thead><tbody>
      {(view === 'overview' ? subscriptions.slice(0,4) : data.subscriptions).map(s => <tr key={s.id}>
        <td data-label="Subscription"><strong>{s.label}</strong><small>{s.provider}{s.status === 'cancelled' || s.status === 'expired' ? ` · ${s.status}` : s.status !== 'active' ? ' · status unverified' : ''}</small></td>
        <td data-label="Plan">{s.plan || 'Plan not recorded'}</td>
        <td data-label="Cost"><strong>{money(s.amount,s.currency)}</strong>{s.amount !== null ? <small>per {s.period === 'year' ? 'year' : s.period === 'month' ? 'month' : 'billing period'}{s.costEvidence === 'estimated' ? ' · estimate' : ''}</small> : null}</td>
        <td data-label="Renewal / expiry">{s.renewsAt ? <><strong>{date(s.renewsAt)}</strong><small>{s.renewsAt.slice(0,10) < today ? 'Past renewal; check billing' : 'Renews'}</small></> : s.endsAt ? <><strong>{date(s.endsAt)}</strong><small>{s.endsAt.slice(0,10) < today ? 'Recorded end date' : 'Ends'}</small></> : <><span className="date-missing">Date not recorded</span>{s.manageUrl ? <small><a href={s.manageUrl} target="_blank" rel="noreferrer">Check billing ↗</a></small> : null}</>}</td>
        <td data-label="Access"><div className="row-actions">{s.loginUrl ? <a className="action-link" href={s.loginUrl} target="_blank" rel="noreferrer">Sign in ↗</a> : <button className="small-button" onClick={() => onView('accounts')}>Connect</button>}{s.manageUrl ? <a href={s.manageUrl} target="_blank" rel="noreferrer">Manage ↗</a> : null}{view === 'subscriptions' ? <button className="small-button" aria-label={`Edit ${s.label} subscription`} onClick={() => { setSaveError(''); setDraft({ id: s.id, label: s.label, amount: s.amount === null ? '' : String(s.amount), currency: s.currency, period: s.period, renewsAt: s.renewsAt?.slice(0,10) || '', endsAt: s.endsAt?.slice(0,10) || '', status: s.status }); }}>Edit</button> : null}</div></td>
      </tr>)}</tbody></table></div>
      {view === 'overview' && subscriptions.length > 4 ? <button className="text-button" onClick={() => onView('subscriptions')}>Show all {subscriptions.length} plan entries →</button> : null}
    </section> : null}

    {view === 'overview' || view === 'usage' ? <section className="product-panel"><div className="section-heading"><div><h2>Who uses the most?</h2><p>{month} · {data.usage.tokens === null ? 'Monthly usage unavailable' : `${fmtTokens(data.usage.tokens)} tokens · ${data.usage.requests?.toLocaleString() ?? 'Unknown'} requests`}</p></div>{view === 'overview' ? <button className="small-button" onClick={() => onView('usage')}>Usage details →</button> : null}</div>
      <div className="rank-columns">{([['By client',data.usage.byClient],['By model',data.usage.byModel]] as const).map(([label,groups]) => {
        const ranked = [...groups].sort((a,b) => b.tokens-a.tokens);const max=ranked[0]?.tokens || 1;
        return <div key={label}><h3>{label}</h3>{(view === 'overview' ? ranked.slice(0,5) : ranked).map((r,i) => <div className="rank-row" key={r.name}><div className="rank-label"><span><b>{i+1}.</b> {r.name}</span><strong>{fmtTokens(r.tokens)}</strong></div><div className="rank-track"><i style={{width:`${r.tokens/max*100}%`}} /></div><small>{r.requests.toLocaleString()} requests · {r.apiEquivalentUsd === null ? r.pricedApiEquivalentUsd === null ? 'API price unknown' : `≥ ${fmtMoney(r.pricedApiEquivalentUsd)} at known API prices` : `${fmtMoney(r.apiEquivalentUsd)} at API prices`}</small></div>)}{!ranked.length ? <p>No monthly usage data available yet.</p> : null}</div>;
      })}</div>
      {Object.keys(data.usage.unpriced).length ? <details className="pricing-note"><summary>{Object.keys(data.usage.unpriced).length} models have no verified API price</summary><p>Tokens are included in usage. Their cost is excluded from the known API subtotal.</p><ul>{Object.entries(data.usage.unpriced).map(([name,tokens]) => <li key={name}>{name}: {fmtTokens(tokens)} tokens</li>)}</ul></details> : null}
      {data.usage.observedAt ? <p className="data-note">Usage updated {fmtDate(data.usage.observedAt,'Asia/Jerusalem')}</p> : null}
    </section> : null}
    {view === 'overview' ? <section className="product-panel"><div className="section-heading"><div><h2>Quota remaining</h2><p>Current allowance across your connected accounts.</p></div><button className="small-button" onClick={() => onView('accounts')}>Accounts & sign-in →</button></div>
      <div className="quota-strip">{!accounts.length ? <p className="data-note">Loading account quotas…</p> : null}{accounts.map(a => {
        const parsed = Date.parse(a.fetchedAt);const age = Date.now()-parsed;const fresh = a.ok && Number.isFinite(parsed) && age >= -30000 && age < 600000;
        const used = quotaUsed(a);const remaining = fresh && used !== null ? Math.max(0,Math.min(100,100-used)) : null;
        return <button className="quota-mini" key={a.account.key} onClick={() => onView('accounts')}><span>{a.account.label}</span><strong>{remaining === null ? 'Quota unknown' : `${Number(remaining.toFixed(1))}% left`}</strong><div className="quota-track"><i style={{width:`${remaining ?? 0}%`,background:remaining !== null && remaining < 15 ? 'var(--warn)' : 'var(--accent)'}} /></div><small>{remaining === null ? 'View account and sign-in options →' : 'Most restricted observed window →'}</small></button>;
      })}</div>
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
