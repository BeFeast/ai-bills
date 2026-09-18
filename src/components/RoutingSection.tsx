'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { policyChanges, remainingAllowance, reorderCandidate, routingRequest, type RoutingPolicy, type RoutingRequest, type RoutingState, type Validation } from '@/lib/routing-client';
import { fmtDate, fmtMoney } from './format';
import type { AccountRegistry } from '@/lib/accounts';
import { Button, Cell, Checkbox, Input, Notice, Pill, Select, StatTile, Table, Tabs, TileGrid, type Column } from './ui';

const microMoney = (amount: number | null | undefined) => fmtMoney(amount == null ? null : amount / 1e6);
type Tab = 'requests' | 'models' | 'roles' | 'clients' | 'accounts' | 'suggestions';
const requestColumns: Column<'time' | 'route' | 'outcome' | 'liability'>[] = [
  { key: 'time', label: 'Time / client' }, { key: 'route', label: 'Requested → actual' }, { key: 'outcome', label: 'Account / outcome' }, { key: 'liability', label: 'Budget liability', align: 'right' },
];
const statusOptions = [{ value: 'approved', label: 'Approved' }, { value: 'hidden', label: 'Hidden for new sessions' }, { value: 'denied', label: 'Denied for all subsequent requests' }];

export function RoutingSection({ tz }: { tz: string }) {
  const [state, setState] = useState<RoutingState | null>(null);
  const [draft, setDraft] = useState<RoutingPolicy | null>(null);
  const [tab, setTab] = useState<Tab>('requests');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [registry, setRegistry] = useState<AccountRegistry | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validatedDraft, setValidatedDraft] = useState('');
  const [lastObserved, setLastObserved] = useState<string | null>(null);
  const fetching = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const data = await routingRequest<RoutingState>('state');
      if (mounted.current) { setState(data); setDraft((current) => current ?? structuredClone(data.policy)); setLastObserved(new Date().toISOString()); setError(''); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { fetching.current = false; }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); const id = setInterval(() => void refresh(), 3_000); return () => { mounted.current = false; clearInterval(id); }; }, [refresh]);

  useEffect(() => {
    let active = true;
    async function discover() {
      try { const response = await fetch('/api/accounts', { cache: 'no-store' }); if (response.ok && active) setRegistry(await response.json() as AccountRegistry); } catch { /* The account overview owns source errors. */ }
    }
    void discover(); const id = setInterval(() => void discover(), 60_000);
    return () => { active = false; clearInterval(id); };
  }, []);
  useEffect(() => {
    if (!registry || !draft) return;
    const missing = registry.accounts.filter((account) => !draft.accounts.some((known) => known.id === account.id));
    if (!missing.length) return;
    setDraft((current) => current ? { ...current, accounts: [...current.accounts, ...missing.map((account) => ({ id: account.id, label: account.label, enabled: false }))] } : current);
    setValidation(null); setValidatedDraft('');
  }, [registry, state?.policy.version]);

  function edit(update: (policy: RoutingPolicy) => void) {
    if (!draft) return;
    const next = structuredClone(draft); update(next); setDraft(next); setValidation(null); setValidatedDraft(''); setNotice('');
  }
  const changes = state && draft ? policyChanges(state.policy, draft) : [];
  const conflict = !!state && !!draft && state.policy.version !== draft.version;
  const canApply = !!validation?.valid && validatedDraft === JSON.stringify(draft) && !conflict && changes.length > 0;

  async function validate() {
    if (!draft) return;
    setBusy(true); setNotice('');
    const snapshot = JSON.stringify(draft);
    try { const result = await routingRequest<Validation>('policy/validate', { policy: draft }); setValidation(result); setValidatedDraft(snapshot); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!draft || !canApply) return;
    setBusy(true); setNotice('');
    try {
      const result = await routingRequest<{ policy: RoutingPolicy }>('policy/apply', { policy: draft, expected_version: draft.version });
      // An apply response alone is not evidence that the request executor loaded it.
      const observed = await routingRequest<RoutingState>('state');
      setState(observed); setDraft(structuredClone(observed.policy)); setValidation(null); setValidatedDraft('');
      setNotice(observed.policy.version === result.policy.version ? `Applied policy v${observed.policy.version}; the routing service confirms this version.` : 'Policy accepted, but the active version is not confirmed. Refresh before another change.');
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function decideSuggestion(id: string, action: 'accept' | 'reject') {
    if (!state) return;
    setBusy(true); setNotice('');
    try {
      const result = await routingRequest<{ proposed_policy?: RoutingPolicy }>(`suggestions/${encodeURIComponent(id)}`, { action, expected_version: state.policy.version });
      if (action === 'accept' && result.proposed_policy) { setDraft(result.proposed_policy); setValidation(null); setValidatedDraft(''); setNotice('Suggestion copied into the draft. Review, validate and apply to activate it.'); setTab('models'); }
      else setNotice(action === 'reject' ? 'Suggestion rejected.' : 'Suggestion accepted for review; no active policy change was confirmed.');
      await refresh();
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const available = state ? remainingAllowance(state.budget) : null;
  const pending = state?.suggestions.filter((s) => !s.status || s.status === 'pending').length ?? 0;
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'requests', label: 'Requests' }, { value: 'models', label: 'Models' }, { value: 'roles', label: 'Roles' }, { value: 'clients', label: 'Clients' }, { value: 'accounts', label: 'Accounts' }, { value: 'suggestions', label: 'Weekly suggestions', count: pending },
  ];
  const share = (amount: number | null | undefined) => `${Math.min(100, (amount ?? 0) / Math.max(1, state?.budget.limit_microusd ?? 1) * 100)}%`;

  function requestCell(request: RoutingRequest, column: Column<typeof requestColumns[number]['key']>): ReactNode {
    switch (column.key) {
      case 'time': return <Cell main={fmtDate(request.created_at, tz)} sub={`${request.client_id} · ${request.id}${request.session_id ? ` · ${request.session_id}` : ''}${request.admitted_date ? ` · budget date ${request.admitted_date}` : ''}`} />;
      case 'route': return <div className="cell"><span className="mono">{request.role || request.requested_model}</span><strong className="mono cell__main">→ {request.model || 'No upstream selected'}</strong>{request.fallback_reason ? <span className="cell__sub" style={{ color: 'var(--warn)' }}>Fallback: {request.fallback_reason}</span> : null}</div>;
      case 'outcome': return <div className="cell" style={{ alignItems: 'flex-start', gap: 4 }}><span>{state?.policy.accounts.find((a) => a.id === request.account_id)?.label || request.account_id || '—'}</span><Pill tone={['settled', 'completed', 'success'].includes(request.status) ? 'ok' : request.status === 'rejected' ? 'bad' : 'warn'}>{request.status}</Pill></div>;
      case 'liability': return <div className="request-liability mono"><span>{microMoney(request.cost_microusd)} settled</span><span className="cell__sub">{microMoney(request.reserved_microusd)} reserved</span></div>;
    }
  }

  return <section className="stack stack--loose" aria-label="Routing controls" style={{ gap: 24 }}>
    <div className="section-head">
      <div className="section-head__text"><span className="t-micro">Request routing</span><h2 className="t-h1">Models, roles and daily allowance</h2><span className="t-small">{state ? `Active policy v${state.policy.version} · ${state.policy.timezone}` : 'Connecting to the routing service…'}</span></div>
      <span className="mono-faint">Request updates every 3s · provider quotas refresh separately</span>
    </div>
    {error ? <Notice tone="warn" role="status">{error}{lastObserved ? ` Last observation: ${fmtDate(lastObserved, tz)}.` : ''}</Notice> : null}
    {state ? <>
      {!state.capabilities.native_managed_attempt ? <Notice tone="warn">Exact upstream attempt enforcement is not available. Paid routes must remain blocked until the request service verifies admission support.</Notice> : null}
      <TileGrid>
        <StatTile label="Additional API allowance" value={microMoney(state.budget.limit_microusd)} note={`${state.budget.date} · ${state.policy.timezone}`} />
        <StatTile label="Settled admission cost" value={microMoney(state.budget.spent_microusd)} note="Proxy attempts; separate from monthly payments" />
        <StatTile label="Reserved / unresolved" value={microMoney(state.budget.reserved_microusd)} note="Possible charges remain reserved after failures" />
        <StatTile label="Available allowance" value={microMoney(available)} note="Shared across clients, accounts and retries" />
      </TileGrid>
      {available == null ? <Notice tone="warn" role="status">Budget unavailable. Paid requests are blocked; included routes continue with the saved policy.</Notice> : <div className="budget">
        <div className="budget__bar" role="img" aria-label={`${microMoney(state.budget.spent_microusd)} settled and ${microMoney(state.budget.reserved_microusd)} reserved of ${microMoney(state.budget.limit_microusd)}`}><div className="budget__settled" style={{ width: share(state.budget.spent_microusd) }} /><div className="budget__reserved" style={{ width: share(state.budget.reserved_microusd) }} /></div>
        <span className="mono-faint">{microMoney(state.budget.spent_microusd)} settled · {microMoney(state.budget.reserved_microusd)} reserved · {microMoney(available)} available of {microMoney(state.budget.limit_microusd)}</span>
      </div>}
      <div className="tabs-scroll"><Tabs items={tabs} value={tab} onChange={setTab} idPrefix="routing" aria-label="Routing views" /></div>
      <div role="tabpanel" id={`routing-panel-${tab}`} aria-labelledby={`routing-tab-${tab}`} className="stack">
      {tab === 'requests' ? <div className="stack stack--loose">
        <Input label="Filter requests" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client, role, model, account or request ID" fieldStyle={{ maxWidth: 420 }} />
        <Table columns={requestColumns} rows={state.requests.filter((r) => [r.id, r.client_id, r.role, r.model, r.requested_model, r.account_id].join(' ').toLowerCase().includes(query.toLowerCase()))} rowKey={(r) => r.id} renderCell={requestCell} empty="No managed requests observed. Existing traffic outside this service is not included in the allowance." />
      </div> : null}
      {tab === 'models' && draft ? <>
        <p className="t-small">Hide removes a model from new sessions. Deny blocks subsequent requests, including existing sessions. In-flight attempts retain their liability.</p>
        {draft.models.map((model, index) => <div key={model.id} className="bf-card policy-card">
          <div className="policy-card__title"><strong>{model.label}</strong><code className="code-chip">{model.id}</code><Pill tone={model.status === 'approved' ? 'ok' : model.status === 'hidden' ? 'idle' : 'bad'}>{model.status}</Pill></div>
          <div className="form-grid">
            <Input label="Display name" disabled={busy} value={model.label} onChange={(e) => edit((p) => { p.models[index].label = e.target.value; })} />
            <Select label="Availability" disabled={busy} value={model.status} options={statusOptions} onChange={(e) => edit((p) => { p.models[index].status = e.target.value as typeof model.status; })} />
          </div>
          <span className="t-small">{model.capabilities.join(' · ')} · input {model.input_limit_tokens?.toLocaleString() ?? 'Unknown'} / output {model.output_limit_tokens?.toLocaleString() ?? 'Unknown'} tokens</span>
          <details>
            <summary className="t-small" style={{ fontWeight: 600 }}>Account routes and pricing evidence</summary>
            <div className="route-list">
              {model.routes.map((route, i) => <div className="route-row" key={i}>
                <span><strong>{draft.accounts.find((a) => a.id === route.account_id)?.label || route.account_id}</strong> · {route.upstream_model} · {route.billing}{route.price_version ? ` · pricing ${route.price_version}` : ''}</span>
                {route.price_evidence ? <span className="cell__sub">{route.price_evidence}</span> : null}
                {route.prices ? <span className="mono-faint">{Object.entries(route.prices).map(([kind, amount]) => `${kind}: ${microMoney(amount)} / 1M tokens`).join(' · ')}</span> : null}
              </div>)}
              <span className="mono-faint">Prices: {Object.entries(model.prices ?? {}).map(([key, value]) => `${key}: ${value == null ? 'unknown' : `${microMoney(value)} / 1M tokens`}`).join(' · ') || 'unknown'}</span>
            </div>
          </details>
        </div>)}
        {!draft.models.length ? <p className="t-small">No approved model inventory yet. Candidates enter through the private policy or a reviewed suggestion.</p> : null}
      </> : null}
      {tab === 'roles' && draft ? <div className="card-grid">{draft.roles.map((role, index) => <div key={role.id} className="bf-card policy-card" style={{ gap: 10 }}>
        <h3 className="t-h3 mono">{role.id}</h3>
        <span className="t-small">Candidate order within eligible routes. Included quota is tried before additional paid API.</span>
        {role.candidates.map((id, position) => <div className="candidate" key={id}>
          <span className="candidate__pos">{String(position + 1).padStart(2, '0')}</span>
          <span className="candidate__label">{draft.models.find((m) => m.id === id)?.label || id}</span>
          <Button variant="ghost" size="sm" disabled={busy || position === 0} aria-label={`Move ${id} up in ${role.id}`} onClick={() => edit((p) => { p.roles[index].candidates = reorderCandidate(role.candidates, position, -1); })}>↑</Button>
          <Button variant="ghost" size="sm" disabled={busy || position === role.candidates.length - 1} aria-label={`Move ${id} down in ${role.id}`} onClick={() => edit((p) => { p.roles[index].candidates = reorderCandidate(role.candidates, position, 1); })}>↓</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => edit((p) => { p.roles[index].candidates = role.candidates.filter((m) => m !== id); })}>Remove</Button>
        </div>)}
        <Select label="Add candidate" disabled={busy} value="" onChange={(e) => { if (e.target.value) edit((p) => { p.roles[index].candidates.push(e.target.value); }); }} options={[{ value: '', label: 'Choose an approved model' }, ...draft.models.filter((m) => m.status === 'approved' && !role.candidates.includes(m.id)).map((m) => ({ value: m.id, label: m.label }))]} />
      </div>)}</div> : null}
      {tab === 'clients' && draft ? <>
        <p className="t-small">These subsets apply to both model listings and request dispatch. Client identity comes from its authenticated connection.</p>
        <div className="card-grid">{draft.clients.map((client, index) => <div key={client.id} className="bf-card policy-card" style={{ gap: 14 }}>
          <h3 className="t-h3 mono">{client.id}</h3>
          {(['roles', 'models'] as const).map((kind) => <div className="check-group" key={kind}><span className="t-micro">{kind}</span><div className="check-group__items">{draft[kind].map((item) => <Checkbox key={item.id} disabled={busy} checked={client[kind].includes(item.id)} label={'label' in item ? item.label : item.id} onChange={(e) => edit((p) => { p.clients[index][kind] = e.target.checked ? [...client[kind], item.id] : client[kind].filter((id) => id !== item.id); })} />)}</div></div>)}
        </div>)}</div>
      </> : null}
      {tab === 'accounts' && draft ? <>
        <p className="t-small">Discovered accounts enter accounting automatically and remain unenrolled. Enable a configured account route explicitly, then validate and apply the policy. Credentials and upstream bindings remain on the server.</p>
        {draft.accounts.map((account, index) => {
          const discovered = registry?.accounts.find((item) => item.id === account.id);
          const routes = draft.models.flatMap((model) => model.routes.filter((route) => route.account_id === account.id).map((route) => ({ model: model.label, billing: route.billing })));
          return <div key={account.id} className="bf-card policy-card" style={{ gap: 8 }}>
            <div className="policy-card__title" style={{ gap: 14 }}>
              <h3 className="t-h3">{account.label}</h3>
              <Checkbox label="Enroll in routing" checked={account.enabled} disabled={busy || (!routes.length && !account.enabled)} onChange={(event) => edit((policy) => { policy.accounts[index].enabled = event.target.checked; })} />
              <span className="mono-faint" style={{ marginLeft: 'auto' }}>{state.policy.accounts.find((item) => item.id === account.id)?.enabled ? 'Active: enrolled' : 'Active: accounting only'}</span>
            </div>
            <span style={{ fontSize: 13 }}>{discovered ? `${discovered.provider} · ${discovered.origin} · billing ${discovered.billingMode}` : 'Configured routing account'}</span>
            <span className="t-small">{routes.length ? `Configured routes: ${routes.map((route) => `${route.model} (${route.billing})`).join(' · ')}` : 'No managed upstream binding. This account stays accounting-only until a private binding is configured.'}</span>
            {discovered ? <span className="t-small">Quota: {discovered.quota.status} · {discovered.coverage.reason}</span> : null}
          </div>;
        })}
      </> : null}
      {tab === 'suggestions' ? <>
        <p className="t-small">Suggestions never activate themselves. Accept adds a proposal to the draft for validation and explicit Apply.</p>
        {state.suggestions.map((suggestion) => <div key={suggestion.id} className="bf-card policy-card" style={{ gap: 8 }}>
          <h3 className="t-h3">{suggestion.title || suggestion.id}</h3>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{suggestion.reason || 'No comparison evidence supplied.'}</span>
          <span className="mono-faint">{suggestion.status || 'pending'}{suggestion.created_at ? ` · ${fmtDate(suggestion.created_at, tz)}` : ''}</span>
          <div className="toolbar" style={{ marginTop: 4 }}>
            <Button variant="secondary" size="sm" disabled={busy || changes.length > 0 || (suggestion.status !== undefined && suggestion.status !== 'pending')} onClick={() => void decideSuggestion(suggestion.id, 'accept')}>Accept into draft</Button>
            <Button variant="ghost" size="sm" disabled={busy || (suggestion.status !== undefined && suggestion.status !== 'pending')} onClick={() => void decideSuggestion(suggestion.id, 'reject')}>Reject</Button>
          </div>
          {changes.length ? <span className="t-small">Apply or discard your current draft before accepting another suggestion.</span> : null}
        </div>)}
        {!state.suggestions.length ? <p className="t-small">No suggestions available. The active catalog stays unchanged.</p> : null}
      </> : null}
      </div>
      {changes.length || conflict || validation ? <div className="bf-card bf-card--selected policy-card review">
        <h3 className="t-h3">Review draft changes</h3>
        {conflict ? <Notice tone="warn">Active policy changed to v{state.policy.version}; this draft started from v{draft?.version}. Reload the active policy and reapply your intended edits.</Notice> : null}
        <pre className="code-box">{changes.length ? changes.map((line) => `• ${line}`).join('\n') : 'No policy changes.'}</pre>
        {validation ? <Notice tone={validation.valid ? 'ok' : 'warn'} role="status">{validation.valid ? 'Draft validation passed. Apply explicitly to change routing.' : <><strong>Validation failed</strong><ul>{validation.errors.map((issue, i) => <li key={i}>{typeof issue === 'string' ? issue : JSON.stringify(issue)}</li>)}</ul></>}</Notice> : null}
        <div className="toolbar">
          <Button size="sm" disabled={busy || conflict || !changes.length} onClick={() => void validate()}>Validate draft</Button>
          <Button size="sm" disabled={busy || !canApply} onClick={() => void apply()}>Apply policy</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft(structuredClone(state.policy)); setValidation(null); setValidatedDraft(''); setNotice('Draft discarded. Active policy loaded.'); }}>Discard draft / reload active</Button>
          <span className="t-small">Applies only after the service confirms the active version</span>
        </div>
      </div> : null}
    </> : null}
    {notice ? <Notice tone="info" role="status">{notice}</Notice> : null}
  </section>;
}
