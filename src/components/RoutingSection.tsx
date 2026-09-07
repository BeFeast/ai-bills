'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { policyChanges, remainingAllowance, reorderCandidate, routingRequest, type RoutingPolicy, type RoutingState, type Validation } from '@/lib/routing-client';
import { fmtDate, fmtMoney } from './format';
import { Metric } from './ui';
import type { AccountRegistry } from '@/lib/accounts';

const microMoney = (amount: number | null | undefined) => fmtMoney(amount == null ? null : amount / 1e6);
type Tab = 'requests' | 'models' | 'roles' | 'clients' | 'accounts' | 'suggestions';

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

  return <section className="billing" aria-label="Routing controls">
    <div className="bill-head"><div><p className="eyebrow">Request routing</p><h2>Models, roles and daily allowance</h2><p className="muted">{state ? `Active policy v${state.policy.version} · ${state.policy.timezone}` : 'Connecting to the routing service…'}</p></div><span className="meta">Request updates every 3s · provider quotas refresh separately</span></div>
    {error ? <p className="status warn" role="status">{error}{lastObserved ? ` Last observation: ${fmtDate(lastObserved, tz)}.` : ''}</p> : null}
    {state ? <>
      {!state.capabilities.native_managed_attempt ? <p className="status warn">Exact upstream attempt enforcement is not available. Paid routes must remain blocked until the request service verifies admission support.</p> : null}
      <div className="bill-grid mini">
        <Metric label="Additional API allowance" value={microMoney(state.budget.limit_microusd)} note={`${state.budget.date} · ${state.policy.timezone}`} />
        <Metric label="Settled admission cost" value={microMoney(state.budget.spent_microusd)} note="Proxy attempts; separate from monthly payments" />
        <Metric label="Reserved / unresolved" value={microMoney(state.budget.reserved_microusd)} note="Possible charges remain reserved after failures" />
        <Metric tone={remainingAllowance(state.budget) == null ? undefined : "live"} label="Available allowance" value={microMoney(remainingAllowance(state.budget))} note="Shared across clients, accounts and retries" />
      </div>
      {remainingAllowance(state.budget) == null ? <p className="status warn" role="status">Budget unavailable. Paid requests are blocked; included routes continue with the saved policy.</p> : <div className="routing-budget-bar" role="img" aria-label={`${microMoney(state.budget.spent_microusd)} settled and ${microMoney(state.budget.reserved_microusd)} reserved of ${microMoney(state.budget.limit_microusd)}`}><span className="settled" style={{ width: `${Math.min(100, (state.budget.spent_microusd ?? 0) / Math.max(1, state.budget.limit_microusd) * 100)}%` }} /><span className="reserved" style={{ width: `${Math.min(100, (state.budget.reserved_microusd ?? 0) / Math.max(1, state.budget.limit_microusd) * 100)}%` }} /></div>}
      <div className="routing-tabs" role="tablist" aria-label="Routing views">{(['requests', 'models', 'roles', 'clients', 'accounts', 'suggestions'] as Tab[]).map((item) => <button className="small-button" id={`routing-tab-${item}`} type="button" role="tab" aria-selected={tab === item} aria-controls={`routing-panel-${item}`} key={item} onClick={() => setTab(item)}>{item === 'suggestions' ? `Weekly suggestions (${state.suggestions.filter((s) => !s.status || s.status === 'pending').length})` : item[0].toUpperCase() + item.slice(1)}</button>)}</div>
      <div role="tabpanel" id={`routing-panel-${tab}`} aria-labelledby={`routing-tab-${tab}`}>
      {tab === 'requests' ? <><label className="field">Filter requests<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client, role, model, account or request ID" /></label><div className="table-wrap"><table><thead><tr><th>Time / client</th><th>Requested → actual</th><th>Account / outcome</th><th>Budget liability</th></tr></thead><tbody>{state.requests.filter((r) => [r.id, r.client_id, r.role, r.model, r.requested_model, r.account_id].join(' ').toLowerCase().includes(query.toLowerCase())).map((request) => <tr className="routing-request" key={request.id}><td>{fmtDate(request.created_at, tz)}<div>{request.client_id}</div><details><summary className="muted">Request details</summary><div className="meta">{request.id}<br />Session: {request.session_id || 'Not supplied'}<br />Budget date: {request.admitted_date}</div></details></td><td>{request.role || request.requested_model}<div><strong>→ {request.model || 'No upstream selected'}</strong></div>{request.fallback_reason ? <div className="status warn">Fallback: {request.fallback_reason}</div> : null}</td><td>{state.policy.accounts.find((a) => a.id === request.account_id)?.label || request.account_id || '—'}<div><span className={`pill ${['settled', 'completed', 'success'].includes(request.status) ? 'ok' : 'warn'}`}>{request.status}</span></div></td><td>{microMoney(request.cost_microusd)} settled<div className="muted">{microMoney(request.reserved_microusd)} reserved</div></td></tr>)}{!state.requests.length ? <tr><td colSpan={4} className="muted">No managed requests observed. Existing traffic outside this service is not included in the allowance.</td></tr> : null}</tbody></table></div></> : null}
      {tab === 'models' && draft ? <div className="policy-rows"><p className="muted">Hide removes a model from new sessions. Deny blocks subsequent requests, including existing sessions. In-flight attempts retain their liability.</p>{draft.models.map((model, index) => <article className="policy-row" key={model.id}><div className="control-toolbar"><strong>{model.label}</strong><code className="muted">{model.id}</code></div><div className="record-form"><label className="field">Display name<input disabled={busy} value={model.label} onChange={(e) => edit((p) => { p.models[index].label = e.target.value; })} /></label><label className="field">Availability<select disabled={busy} value={model.status} onChange={(e) => edit((p) => { p.models[index].status = e.target.value as typeof model.status; })}><option value="approved">Approved</option><option value="hidden">Hidden for new sessions</option><option value="denied">Denied for all subsequent requests</option></select></label></div><p className="muted">{model.capabilities.join(' · ')} · input {model.input_limit_tokens?.toLocaleString() ?? 'Unknown'} / output {model.output_limit_tokens?.toLocaleString() ?? 'Unknown'} tokens</p><details><summary>Account routes and pricing evidence</summary><ul>{model.routes.map((route, i) => <li key={i}>{draft.accounts.find((a) => a.id === route.account_id)?.label || route.account_id} · {route.upstream_model} · {route.billing}{route.price_version ? ` · pricing ${route.price_version}` : ''}{route.price_evidence ? <div className="muted">{route.price_evidence}</div> : null}{route.prices ? <div className="muted">{Object.entries(route.prices).map(([kind, amount]) => `${kind}: ${microMoney(amount)} / 1M tokens`).join(' · ')}</div> : null}</li>)}</ul><p className="muted">Prices: {Object.entries(model.prices ?? {}).map(([key, value]) => `${key}: ${value == null ? 'unknown' : `${microMoney(value)} / 1M tokens`}`).join(' · ')}</p></details></article>)}{!draft.models.length ? <p className="muted">No approved model inventory yet. Candidates enter through the private policy or a reviewed suggestion.</p> : null}</div> : null}
      {tab === 'roles' && draft ? <div className="policy-rows">{draft.roles.map((role, index) => <article className="policy-row" key={role.id}><h3>{role.id}</h3><p className="muted">Candidate order within eligible routes. Included quota is tried before additional paid API.</p>{role.candidates.map((id, position) => <div className="control-toolbar" key={id}><span>{position + 1}. {draft.models.find((m) => m.id === id)?.label || id}</span><button disabled={busy || position === 0} type="button" className="small-button" aria-label={`Move ${id} up in ${role.id}`} onClick={() => edit((p) => { p.roles[index].candidates = reorderCandidate(role.candidates, position, -1); })}>↑</button><button disabled={busy || position === role.candidates.length - 1} type="button" className="small-button" aria-label={`Move ${id} down in ${role.id}`} onClick={() => edit((p) => { p.roles[index].candidates = reorderCandidate(role.candidates, position, 1); })}>↓</button><button disabled={busy} type="button" className="small-button" onClick={() => edit((p) => { p.roles[index].candidates = role.candidates.filter((m) => m !== id); })}>Remove</button></div>)}<label className="field">Add candidate<select disabled={busy} value="" onChange={(e) => { if (e.target.value) edit((p) => { p.roles[index].candidates.push(e.target.value); }); }}><option value="">Choose an approved model</option>{draft.models.filter((m) => m.status === 'approved' && !role.candidates.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label></article>)}</div> : null}
      {tab === 'clients' && draft ? <div className="policy-rows"><p className="muted">These subsets apply to both model listings and request dispatch. Client identity comes from its authenticated connection.</p>{draft.clients.map((client, index) => <article className="policy-row" key={client.id}><h3>{client.id}</h3>{(['roles', 'models'] as const).map((kind) => <div key={kind}><p className="eyebrow">{kind}</p><div className="model-options">{draft[kind].map((item) => <label className="check-label" key={item.id}><input type="checkbox" disabled={busy} checked={client[kind].includes(item.id)} onChange={(e) => edit((p) => { p.clients[index][kind] = e.target.checked ? [...client[kind], item.id] : client[kind].filter((id) => id !== item.id); })} />{'label' in item ? item.label : item.id}</label>)}</div></div>)}</article>)}</div> : null}
      {tab === 'accounts' && draft ? <div className="policy-rows"><p className="muted">Discovered accounts enter accounting automatically and remain unenrolled. Enable a configured account route explicitly, then validate and apply the policy. Credentials and upstream bindings remain on the server.</p>{draft.accounts.map((account, index) => {
        const discovered = registry?.accounts.find((item) => item.id === account.id);
        const routes = draft.models.flatMap((model) => model.routes.filter((route) => route.account_id === account.id).map((route) => ({ model: model.label, billing: route.billing })));
        return <article className="policy-row" key={account.id}><div className="control-toolbar"><h3>{account.label}</h3><label className="check-label"><input type="checkbox" checked={account.enabled} disabled={busy || (!routes.length && !account.enabled)} onChange={(event) => edit((policy) => { policy.accounts[index].enabled = event.target.checked; })} />Enroll in routing</label><span className="muted">{state.policy.accounts.find((item) => item.id === account.id)?.enabled ? 'Active: enrolled' : 'Active: accounting only'}</span></div><p>{discovered ? `${discovered.provider} · ${discovered.origin} · billing ${discovered.billingMode}` : 'Configured routing account'}</p>{routes.length ? <p className="muted">Configured routes: {routes.map((route) => `${route.model} (${route.billing})`).join(' · ')}</p> : <p className="muted">No managed upstream binding. This account stays accounting-only until a private binding is configured.</p>}{discovered ? <p className="muted">Quota: {discovered.quota.status} · {discovered.coverage.reason}</p> : null}</article>;
      })}</div> : null}
      {tab === 'suggestions' ? <div className="policy-rows"><p className="muted">Suggestions never activate themselves. Accept adds a proposal to the draft for validation and explicit Apply.</p>{state.suggestions.map((suggestion) => <article className="policy-row" key={suggestion.id}><h3>{suggestion.title || suggestion.id}</h3><p>{suggestion.reason || 'No comparison evidence supplied.'}</p><p className="muted">{suggestion.status || 'pending'}{suggestion.created_at ? ` · ${fmtDate(suggestion.created_at, tz)}` : ''}</p><div className="control-toolbar"><button className="small-button" type="button" disabled={busy || changes.length > 0 || (suggestion.status !== undefined && suggestion.status !== 'pending')} onClick={() => void decideSuggestion(suggestion.id, 'accept')}>Accept into draft</button><button className="small-button" type="button" disabled={busy || (suggestion.status !== undefined && suggestion.status !== 'pending')} onClick={() => void decideSuggestion(suggestion.id, 'reject')}>Reject</button></div>{changes.length ? <p className="muted">Apply or discard your current draft before accepting another suggestion.</p> : null}</article>)}{!state.suggestions.length ? <p className="muted">No suggestions available. The active catalog stays unchanged.</p> : null}</div> : null}
      </div>
      {changes.length || conflict || validation ? <div className="policy-rows"><h3>Review draft changes</h3>{conflict ? <p className="status warn">Active policy changed to v{state.policy.version}; this draft started from v{draft?.version}. Reload the active policy and reapply your intended edits.</p> : null}<div className="policy-preview">{changes.length ? changes.map((line) => `• ${line}`).join('\n') : 'No policy changes.'}</div>{validation ? <div className={`status ${validation.valid ? 'ok' : 'danger'}`} role="status">{validation.valid ? 'Draft validation passed. Apply explicitly to change routing.' : <><strong>Validation failed</strong><ul>{validation.errors.map((issue, i) => <li key={i}>{typeof issue === 'string' ? issue : JSON.stringify(issue)}</li>)}</ul></>}</div> : null}<div className="control-toolbar"><button type="button" disabled={busy || conflict || !changes.length} onClick={() => void validate()}>Validate draft</button><button type="button" disabled={busy || !canApply} onClick={() => void apply()}>Apply policy</button><button className="small-button" type="button" disabled={busy} onClick={() => { setDraft(structuredClone(state.policy)); setValidation(null); setValidatedDraft(''); setNotice('Draft discarded. Active policy loaded.'); }}>Discard draft / reload active</button><span className="muted">Applies only after the service confirms the active version</span></div></div> : null}
    </> : null}
    {notice ? <p className="status" role="status">{notice}</p> : null}
  </section>;
}
