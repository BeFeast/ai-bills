'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { OverviewUsageGroup, ProductOverview, ProductSubscription } from '@/lib/overview';
import type { ProviderUsage } from '@/lib/usage';
import { kimiCodingUsage, kimiUsagePercent, cursorLegacyPercent, codexWindowResetIso, cursorCycleEnd, type ClaudeUsagePayload, type CodexUsagePayload, type KimiUsagePayload, type CursorUsagePayload } from '@/lib/usage';
import { fmtMoney, fmtTokens, fmtDate } from './format';
import { ProviderIcon } from './ProviderIcon';
import { AccountBrowserAccess } from './AccountBrowserAccess';
import type { RegistryAccount } from '@/lib/accounts';
import { Button, ButtonLink, Card, Cell, Dialog, Input, Notice, Panel, Pill, Progress, Select, StatTile, Table, TileGrid, type Column } from './ui';

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

/** Client ids are free-form; map the known CLIs onto a provider mark, a display name and a share-bar colour. */
function clientIdentity(name: string): { display: string; provider: string; color: string } {
  const id = name.toLowerCase();
  if (id.includes('codex')) return { display: 'Codex', provider: 'codex', color: 'var(--brand-a)' };
  if (id.includes('claude')) return { display: 'Claude Code', provider: 'claude', color: 'var(--warn)' };
  if (id.includes('opencode')) return { display: 'OpenCode', provider: 'opencode', color: 'var(--text-faint)' };
  if (id.includes('cursor')) return { display: 'Cursor', provider: 'cursor', color: 'var(--text-faint)' };
  if (id.includes('kimi')) return { display: 'Kimi', provider: 'kimi', color: 'var(--text-faint)' };
  if (id.includes('gemini')) return { display: 'Gemini', provider: 'gemini', color: 'var(--text-faint)' };
  return { display: name, provider: name, color: 'var(--text-faint)' };
}

const subscriptionColumns: Column<'sub' | 'plan' | 'cost' | 'renew' | 'access'>[] = [
  { key: 'sub', label: 'Subscription / account' }, { key: 'plan', label: 'Plan' }, { key: 'cost', label: 'Cost' }, { key: 'renew', label: 'Renewal or expiry' }, { key: 'access', label: 'Access' },
];

export function ProductOverviewPanel({ data, accounts, registry = [], view, onView, onUpdated, error }: { data: ProductOverview | null; accounts: ProviderUsage[]; registry?: RegistryAccount[]; view: View; onView: (view: View) => void; onUpdated?: () => void | Promise<void>; error?: string }) {
  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
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
  if (!data) return <Card title="Your subscriptions and usage"><p className="t-small">{error || 'Loading subscription prices and usage…'}</p></Card>;
  const subscriptions = data.subscriptions.filter(s => s.status !== 'cancelled' && s.status !== 'expired');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
  const upcoming = subscriptions.filter(s => (s.renewsAt || s.endsAt || '').slice(0,10) >= today).sort((a,b) => (a.renewsAt || a.endsAt || '').localeCompare(b.renewsAt || b.endsAt || ''));
  const costs = data.summary.knownMonthlyCosts.map(c => money(c.amount,c.currency)).join(' + ') || 'Not recorded';
  const api = data.usage.apiEquivalentUsd ?? data.usage.pricedApiEquivalentUsd;
  const partialApi = data.usage.apiEquivalentUsd === null && api !== null;
  // Partial reconciliation withholds a combined total; the confirmed subset is still a real lower bound, not "unavailable".
  const confirmedTokens = data.usage.reconciliation?.confirmedTokens ?? null;
  const confirmedSubset = data.usage.tokens === null && confirmedTokens !== null;
  const month = new Date(`${data.month}-15T12:00:00Z`).toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  const otherAccounts = registry.filter(account => !accounts.some(row => row.account.provider === account.provider));
  // A card needs evidence: an automatic observation or a CLIProxyAPI credential. Declared-only rows get one compact line instead.
  const liveAccounts = otherAccounts.filter(account => account.funds || account.proxyCredential || account.quota.status !== 'unknown');
  const declaredOnly = otherAccounts.filter(account => !liveAccounts.includes(account));
  const shownAccounts = view === 'overview' ? liveAccounts.filter(account => /meta|muse|kimi|xai|x.ai|cursor|ollama|openrouter|antigravity/i.test(account.provider)) : liveAccounts;
  const unlinkedPlans = subscriptions.filter(s => !s.accountKeys.some(key => accounts.some(a => a.account.key === key))).length;
  const usageSubtitle = data.usage.tokens === null ? (confirmedSubset ? `≥ ${fmtTokens(confirmedTokens ?? 0)} tokens · ≥ ${data.usage.reconciliation?.confirmedRequests?.toLocaleString() ?? 'Unknown'} requests · confirmed subset` : 'Monthly usage unavailable') : `${fmtTokens(data.usage.tokens)} tokens · ${data.usage.requests?.toLocaleString() ?? 'Unknown'} requests`;
  const shownSubscriptions = view === 'overview' ? subscriptions.slice(0, 4) : data.subscriptions;

  function subscriptionCell(s: ProductSubscription, column: Column<typeof subscriptionColumns[number]['key']>): ReactNode {
    switch (column.key) {
      case 'sub': return <div className="identity"><ProviderIcon provider={s.provider} /><Cell main={s.label} sub={`${s.provider}${s.status === 'cancelled' || s.status === 'expired' ? ` · ${s.status}` : s.status !== 'active' ? ' · status unverified' : ''}`} /></div>;
      case 'plan': return s.plan || 'Plan not recorded';
      case 'cost': return <Cell main={<span className="tabular">{money(s.amount, s.currency)}</span>} sub={s.amount !== null ? `per ${s.period === 'year' ? 'year' : s.period === 'month' ? 'month' : 'billing period'}${s.costEvidence === 'estimated' ? ' · estimate' : ''}` : null} />;
      case 'renew': return s.renewsAt ? <Cell main={date(s.renewsAt)} sub={s.renewsAt.slice(0,10) < today ? 'Past renewal; check billing' : 'Renews'} /> : s.endsAt ? <Cell main={date(s.endsAt)} sub={s.endsAt.slice(0,10) < today ? 'Recorded end date' : 'Ends'} /> : <Cell main={<span className="date-missing">Date not recorded</span>} sub="Check account billing" />;
      case 'access': return <AccountBrowserAccess subscription={s}>{view === 'subscriptions' ? <Button variant="ghost" size="sm" aria-label={`Edit ${s.label} subscription`} onClick={() => { setSaveError(''); setDraft({ id: s.id, label: s.label, amount: s.amount === null ? '' : String(s.amount), currency: s.currency, period: s.period, renewsAt: s.renewsAt?.slice(0,10) || '', endsAt: s.endsAt?.slice(0,10) || '', status: s.status }); }}>Edit</Button> : null}</AccountBrowserAccess>;
    }
  }

  function rankColumn(label: string, groups: OverviewUsageGroup[]) {
    const ranked = [...groups].sort((a,b) => b.tokens-a.tokens); const max = ranked[0]?.tokens || 1;
    const rows = view === 'overview' ? ranked.slice(0,5) : ranked;
    return <div className="rank-col" key={label}>
      <h3 className="t-h3">{label}</h3>
      {rows.map((r,i) => <div className="rank-row" key={r.name}>
        <div className="rank-row__top"><span className="rank-row__name"><span className="rank-row__pos">{String(i+1).padStart(2,'0')}</span>{r.name}</span><strong className="rank-row__tokens">{fmtTokens(r.tokens)}</strong></div>
        <Progress value={r.tokens/max*100} label={`${r.name} share of the largest ${label.toLowerCase()} entry`} />
        <span className="t-small">{r.requests.toLocaleString()} requests · {r.apiEquivalentUsd === null ? r.pricedApiEquivalentUsd === null ? 'API price unknown' : `≥ ${fmtMoney(r.pricedApiEquivalentUsd)} at known API prices` : `${fmtMoney(r.apiEquivalentUsd)} at API prices`}</span>
      </div>)}
      {!ranked.length ? <p className="t-small">No monthly usage data available yet.</p> : null}
    </div>;
  }

  return <>
    {view === 'overview' ? <TileGrid>
      <StatTile label="Active subscriptions" value={<>{data.summary.activeSubscriptionCount}{data.summary.subscriptionCountComplete === false ? '+' : ''}</>} note={data.summary.subscriptionCountComplete ? 'Plans and accounts' : 'Some plan statuses need checking'} onClick={() => onView('subscriptions')} />
      <StatTile label="Subscription cost / month" value={`${data.summary.unknownPriceCount && data.summary.knownMonthlyCosts.length ? '≥ ' : ''}${costs}${data.summary.monthlyCostEvidence === 'estimated' ? ' est.' : ''}`} note={data.summary.unknownPriceCount ? `${data.summary.unknownPriceCount} prices still need checking` : data.summary.monthlyCostEvidence === 'estimated' ? 'Includes estimated plan prices' : 'Recurring plan prices'} onClick={() => onView('subscriptions')} />
      <StatTile label={`If paid by API · ${month}`} value={data.usage.tokens === null ? (confirmedSubset && api !== null ? `≥ ${fmtMoney(api)}` : 'Usage unavailable') : api === null ? 'Pricing incomplete' : `${partialApi ? '≥ ' : ''}${fmtMoney(api)}`} note={confirmedSubset ? `Confirmed subset · ≥ ${fmtTokens(confirmedTokens ?? 0)} tokens; native observations may overlap` : data.usage.reconciliation?.status === 'partial' ? 'Native observations may overlap; see confirmed subtotal' : data.usage.tokens === null ? 'Monthly usage has not been imported' : partialApi ? 'Known prices; some models unpriced' : `${fmtTokens(data.usage.tokens)} tokens measured`} onClick={() => onView('usage')} />
      <StatTile label="Next renewal / expiry" value={upcoming[0] ? date(upcoming[0].renewsAt || upcoming[0].endsAt) : 'Dates need checking'} note={upcoming[0] ? `${upcoming[0].provider} · ${upcoming[0].label}` : 'Open billing beside each plan'} onClick={() => onView('subscriptions')} />
    </TileGrid> : null}

    {view === 'overview' || view === 'subscriptions' ? <Card id="subscriptions" title="Subscriptions" subtitle="What you pay, when it renews, and where to manage it." actions={view === 'overview' ? <Button variant="secondary" size="sm" onClick={() => onView('subscriptions')}>All plans →</Button> : null}>
      <Table className="subs-table" columns={subscriptionColumns} rows={shownSubscriptions} rowKey={s => s.id} renderCell={subscriptionCell} empty="No subscriptions recorded yet." />
      {view === 'overview' && subscriptions.length > 4 ? <p style={{ marginTop: 12 }}><button type="button" className="text-link" onClick={() => onView('subscriptions')}>Show all {subscriptions.length} plan entries →</button></p> : null}
    </Card> : null}

    {view === 'usage' ? (() => {
      const clients = [...data.usage.byClient].sort((a, b) => (b.pricedApiEquivalentUsd ?? b.apiEquivalentUsd ?? 0) - (a.pricedApiEquivalentUsd ?? a.apiEquivalentUsd ?? 0));
      const priced = clients.reduce((total, c) => total + (c.apiEquivalentUsd ?? c.pricedApiEquivalentUsd ?? 0), 0);
      const unpricedTokens = Object.values(data.usage.unpriced).reduce((total, tokens) => total + tokens, 0);
      const total = data.usage.tokens === null ? (confirmedSubset && api !== null ? `≥ ${fmtMoney(api)}` : 'Usage unavailable') : api === null ? 'Pricing incomplete' : `${partialApi ? '≥ ' : ''}${fmtMoney(api)}`;
      return <Card title="Spending" subtitle={`${month} · API-equivalent at list prices · derived from by-client usage`} actions={<Pill tone="info">new layout</Pill>}>
        <div className="spend">
          <div className="stack stack--tight" style={{ gap: 4 }}>
            <span className="spend__total tabular">{total}</span>
            <span className="t-small">{usageSubtitle}{unpricedTokens ? ` · excludes ${fmtTokens(unpricedTokens)} unpriced tokens` : ''}</span>
          </div>
          {priced > 0 ? <div className="spend__bar" role="img" aria-label="Share of API-equivalent cost by client">{clients.map(c => { const amount = c.apiEquivalentUsd ?? c.pricedApiEquivalentUsd; if (amount === null || amount <= 0) return null; return <div key={c.name} className="spend__seg" style={{ width: `${amount / priced * 100}%`, background: clientIdentity(c.name).color, minWidth: 2 }} />; })}</div> : null}
          <div className="panel-grid panel-grid--wide">{clients.map(c => {
            const identity = clientIdentity(c.name); const amount = c.apiEquivalentUsd ?? c.pricedApiEquivalentUsd;
            return <Panel className="spend-row" key={c.name}>
              <div className="spend-row__top">
                <span className="spend-row__dot" style={{ background: identity.color }} aria-hidden="true" />
                <ProviderIcon provider={identity.provider} size={20} />
                <span className="spend-row__name">{identity.display}</span>
                <span className="mono-faint">{c.requests.toLocaleString()} requests</span>
                <strong className="spend-row__amount">{amount === null ? 'Unpriced' : `${c.apiEquivalentUsd === null ? '≥ ' : ''}${fmtMoney(amount)}`}</strong>
              </div>
              <span className="t-small">{amount === null ? 'excluded from subtotal' : `${priced > 0 ? (amount / priced * 100).toFixed(1) : '0.0'}% of cost`} · {fmtTokens(c.tokens)} tokens · {c.name}</span>
            </Panel>;
          })}</div>
          {!clients.length ? <p className="t-small">No monthly usage data available yet.</p> : null}
        </div>
      </Card>;
    })() : null}

    {view === 'overview' || view === 'usage' ? <Card title="Who uses the most?" subtitle={`${month} · ${usageSubtitle}`} actions={view === 'overview' ? <Button variant="secondary" size="sm" onClick={() => onView('usage')}>Usage details →</Button> : null}>
      <div className="stack stack--loose">
        {data.usage.reconciliation?.status === 'partial' ? <Notice tone="info" role="status">Combined usage is unknown: {data.usage.reconciliation.nativeObservations?.toLocaleString()} native observations may overlap with proxy traffic. Rankings below show the confirmed subtotal of {fmtTokens(data.usage.reconciliation.confirmedTokens ?? 0)} tokens and {data.usage.reconciliation.confirmedRequests?.toLocaleString()} requests. No repeated observations are added to that subtotal.</Notice> : null}
        <div className="rank-grid">
          {rankColumn('By client', data.usage.byClient)}
          {rankColumn('By model', data.usage.byModel)}
          {data.usage.byAccount?.length ? rankColumn('By account', data.usage.byAccount) : null}
        </div>
        {view === 'usage' && Object.keys(data.usage.unpriced).length ? <details className="details-panel">
          <summary><span>{Object.keys(data.usage.unpriced).length} models have no verified API price</span><span className="details-hint">expand</span></summary>
          <p className="t-small">Tokens are included in usage. Their cost is excluded from the known API subtotal.</p>
          <div className="unpriced-list">{Object.entries(data.usage.unpriced).map(([name,tokens]) => <div key={name}>{name}: {fmtTokens(tokens)} tokens</div>)}</div>
        </details> : null}
        {data.usage.observedAt ? <p className="t-small">Usage updated {fmtDate(data.usage.observedAt,'Asia/Jerusalem')}</p> : null}
      </div>
    </Card> : null}

    {view === 'overview' ? <Card title="Quota remaining" subtitle="Current allowance across your connected accounts." actions={<Button variant="secondary" size="sm" onClick={() => onView('accounts')}>Accounts & sign-in →</Button>} aria-label="Account availability">
      <div className="stack">
        {!accounts.length ? <p className="t-small">Loading account quotas…</p> : null}
        <div className="panel-grid">{accounts.map(a => {
          const observed = Date.parse(a.fetchedAt); const age = Date.now() - observed;
          const fresh = a.ok && Number.isFinite(age) && age >= -60_000 && age <= 600_000;
          const used = quotaUsed(a); const remaining = fresh && used !== null ? Math.max(0, Math.min(100, 100-used)) : null;
          const detail = !a.ok ? a.status === 401 || a.status === 403 ? 'Sign-in needs attention' : a.error?.includes('first quota') ? 'First observation pending' : 'Source unavailable · other accounts continue updating' : !fresh ? 'Observation stale · availability unknown' : remaining === 0 ? 'Allowance exhausted · see reset windows' : remaining === null ? 'Quota not reported by this source' : 'Most restricted observed window';
          const subscription = subscriptions.find(plan => plan.accountKeys.includes(a.account.key));
          const payload = a.data;
          const reset = a.account.provider === 'claude' ? (payload as ClaudeUsagePayload)?.seven_day?.resets_at || (payload as ClaudeUsagePayload)?.five_hour?.resets_at
            : a.account.provider === 'codex' ? codexWindowResetIso((payload as CodexUsagePayload)?.rate_limit?.primary_window ?? null)
            : a.account.provider === 'cursor' ? cursorCycleEnd(payload as CursorUsagePayload)
            : kimiCodingUsage(payload as KimiUsagePayload)?.detail?.resetTime;
          const title = a.account.label.toLowerCase().startsWith(a.account.provider.toLowerCase()) ? a.account.label : `${a.account.provider} · ${a.account.label}`;
          return <Panel className="quota" key={a.account.key}>
            <button type="button" className="quota__nav" onClick={() => onView('accounts')} title={`${title} · ${detail}`}>
              <div className="quota__head"><ProviderIcon provider={a.account.provider} /><div className="quota__id"><span className="t-micro">{a.account.provider}</span><span className="quota__email">{a.account.email || 'Email not recorded'}</span></div></div>
              <strong className="quota__value">{remaining === null ? 'Quota unknown' : remaining === 0 ? 'Exhausted' : `${Number(remaining.toFixed(1))}% left`}</strong>
              <Progress value={remaining ?? 0} tone={remaining !== null && remaining < 15 ? 'warn' : undefined} label={`${title} allowance remaining`} />
              <span className="t-small">{remaining === null ? 'View account and sign-in options' : detail} →</span>
              <span className="cell__sub">{reset ? `Reset ${fmtDate(reset,'Asia/Jerusalem')}` : 'Reset unknown'} · {Number.isFinite(observed) ? `Observed ${fmtDate(a.fetchedAt,'Asia/Jerusalem')}` : 'No observation yet'}</span>
            </button>
            <div className="quota__access">{subscription ? <AccountBrowserAccess subscription={subscription} /> : <AccountBrowserAccess account={a.account} />}</div>
          </Panel>;
        })}</div>
        {unlinkedPlans ? <p className="t-small">{unlinkedPlans} plans have no linked automatic quota source. Their allowance is unknown. <button type="button" className="text-link" onClick={() => onView('subscriptions')}>View source coverage →</button></p> : null}
      </div>
    </Card> : null}

    {view === 'overview' || view === 'accounts' ? <Card title="Other subscriptions & accounts" subtitle="Live CLIProxyAPI credentials and API observations. Declared accounts without an automatic source are listed below." actions={view === 'overview' ? <Button variant="secondary" size="sm" onClick={() => onView('accounts')}>All {registry.length} accounts →</Button> : null}>
      <div className="stack">
        <div className="panel-grid">
          {shownAccounts.map(account => {
            const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
            const subscription = data.subscriptions.find(plan => normalize(plan.provider) === normalize(account.provider));
            const website = account.websiteUrl || subscription?.manageUrl || subscription?.loginUrl;
            const observed = account.quota.observedAt ? Date.parse(account.quota.observedAt) : NaN;
            const fresh = account.quota.status === 'fresh' && Number.isFinite(observed) && Date.now() - observed <= 600_000;
            return <Panel className="other-account" key={account.id}>
              <div className="identity"><ProviderIcon provider={account.provider} /><Cell main={account.label} sub={account.provider} /></div>
              {account.funds ? <>
                <strong className="other-account__value">{account.funds.accountBalance.usd === null ? 'Account balance unknown' : `${fmtMoney(account.funds.accountBalance.usd)} account balance`}</strong>
                <small>Account usage: {account.funds.accountSpentUsd === null ? 'unknown' : `$${account.funds.accountSpentUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`}</small>
                <small>This key usage: {account.funds.keyUsage.usd === null ? 'unknown' : `$${account.funds.keyUsage.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`} · {account.funds.keyLimitKnown ? account.funds.keyLimitUsd === null ? 'No key cap' : `Key cap ${fmtMoney(account.funds.keyLimitUsd)}` : 'Key cap unknown'}</small>
                <small>Credits source: {account.funds.accountBalance.freshness.status} · Key source: {account.funds.keyUsage.freshness.status}</small>
                {account.funds.accountBalance.freshness.observedAt ? <small>Observed {fmtDate(account.funds.accountBalance.freshness.observedAt, 'Asia/Jerusalem')}</small> : null}
                <small>API observations · no browser sign-in needed. Model availability is not tested.</small>
              </> : account.proxyCredential && account.quota.status === 'unknown' ? <>
                <strong className="other-account__value">CLIProxyAPI · {account.proxyCredential.status}</strong>
                <small>{account.proxyCredential.successToday} ok · {account.proxyCredential.failedToday} failed today{account.proxyCredential.email ? ` · ${account.proxyCredential.email}` : ''}</small>
                <small>No quota API for this provider; the proxy's request outcomes are the availability evidence.</small>
                {account.proxyCredential.observedAt ? <small>Observed {fmtDate(account.proxyCredential.observedAt, 'Asia/Jerusalem')}</small> : null}
              </> : <><strong className="other-account__value">{fresh && account.quota.remaining !== null ? account.quota.remaining === 0 ? 'Exhausted' : `${account.quota.remaining}${account.quota.unit === 'percent' ? '%' : ''} left` : 'Quota unknown'}</strong><small>{account.quota.status === 'error' ? 'Automatic source failed; other sources continue' : account.quota.status === 'stale' ? 'Source observation is stale' : fresh ? 'Recent provider observation' : 'No current automatic quota observation'}</small></>}
              <small>{account.funds ? account.proxyConfigured ? 'CLIProxyAPI account linked' : 'CLIProxyAPI account association not observed' : account.proxyCredential ? account.proxyCredential.kind === 'oauth' ? 'CLIProxyAPI OAuth credential' : 'CLIProxyAPI upstream API key' : 'Direct account · not a CLIProxyAPI credential'}</small>
              {Number.isFinite(observed) ? <small>Observed {fmtDate(account.quota.observedAt!,'Asia/Jerusalem')}</small> : null}
              {account.operatorNote ? <small>Operator note: {account.operatorNote}</small> : null}
              {website ? <div><ButtonLink variant="ghost" size="sm" href={website} target="_blank" rel="noreferrer" title="Provider website in your current browser; verify the signed-in account">Provider website ↗</ButtonLink></div> : null}
            </Panel>;
          })}
        </div>
        {!shownAccounts.length ? <p className="t-small">Account inventory has not supplied additional accounts yet.</p> : null}
        {view === 'accounts' && declaredOnly.length ? <div className="stack stack--tight"><h3 className="t-h3">Declared, no automatic source · {declaredOnly.length}</h3><ul className="declared">{declaredOnly.map(account => <li key={account.id}><ProviderIcon provider={account.provider} /><Cell main={account.label} sub={`${account.provider}${account.billingMode !== 'unknown' ? ` · ${account.billingMode}` : ''}${account.operatorNote ? ` · ${account.operatorNote}` : ''}`} />{account.websiteUrl ? <ButtonLink variant="ghost" size="sm" href={account.websiteUrl} target="_blank" rel="noreferrer">Website ↗</ButtonLink> : null}</li>)}</ul></div> : null}
        {view === 'overview' && declaredOnly.length ? <p className="t-small">{declaredOnly.length} declared accounts have no automatic source. <button type="button" className="text-link" onClick={() => onView('accounts')}>See the list →</button></p> : null}
      </div>
    </Card> : null}

    <Dialog open={!!draft} title={draft ? `Edit ${draft.label}` : ''} titleId="subscription-editor-title" description="Record the price and dates shown in your billing settings. This does not change the provider subscription." onClose={() => setDraft(null)} busy={saving}>
      {draft ? <form onSubmit={saveSubscription}>
        <div className="dialog-grid">
          <Input label="Price" type="number" min="0" step="0.01" value={draft.amount} placeholder="Unknown" onChange={event => setDraft({ ...draft, amount: event.target.value })} />
          <Input label="Currency" required pattern="[A-Z]{3}" maxLength={3} value={draft.currency} onChange={event => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} />
          <Select label="Billing period" value={draft.period} onChange={event => setDraft({ ...draft, period: event.target.value as SubscriptionDraft['period'] })} options={[{ value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }, { value: 'unknown', label: 'Unknown' }]} />
          <Select label="Status" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })} options={[{ value: 'active', label: 'Active' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'expired', label: 'Expired' }, { value: 'unknown', label: 'Unknown' }]} />
          <Input label="Renewal date" type="date" value={draft.renewsAt} onChange={event => setDraft({ ...draft, renewsAt: event.target.value })} />
          <Input label="End date" type="date" value={draft.endsAt} onChange={event => setDraft({ ...draft, endsAt: event.target.value })} />
        </div>
        {saveError ? <p role="alert" className="bf-hint bf-hint--error" style={{ marginTop: 10 }}>{saveError}</p> : null}
        <div className="bf-dialog__footer"><Button variant="secondary" disabled={saving} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save subscription'}</Button></div>
      </form> : null}
    </Dialog>
  </>;
}
