'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Metric } from './ui';
import { fmtDate, fmtMoney } from './format';

type CoverageSource = import('@/lib/accounting').Freshness;
type Inventory = import('@/lib/accounts').AccountRegistry;
type FinancialRecord = import('@/lib/accounting').FinancialInput;
type Accounting = import('@/lib/accounting').AccountingOverview;

export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`);
  return data as T;
}

export function CoverageList({ sources, tz, labels = {} }: { sources: CoverageSource[]; tz: string; labels?: Record<string, string> }) {
  return <div className="coverage-list">{sources.length ? sources.map((source) => <div className="coverage-row" key={source.id}>
    <div><strong>{labels[source.id] || source.id.replaceAll('-', ' ')}</strong><span className={`pill ${source.status === 'fresh' ? 'ok' : source.status === 'error' ? 'danger' : 'warn'}`}>{source.status}</span></div>
    <span className="muted">{source.observedAt ? fmtDate(source.observedAt, tz) : 'Never observed'}{source.message ? ` · ${source.message}` : ''}</span>
  </div>) : <p className="muted">No source receipts available. Completeness is unknown.</p>}</div>;
}

export function AccountOverview({ tz }: { tz: string }) {
  const [month, setMonth] = useState('');
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [accounting, setAccounting] = useState<Accounting | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [kind, setKind] = useState<import('@/lib/accounting').FinancialKind>('payment');
  const pendingRecord = useRef<FinancialRecord | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const parts = new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    setMonth(`${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`);
  }, [tz]);
  const refresh = useCallback(async () => {
    if (!month) return;
    const current = ++generation.current;
    const results = await Promise.allSettled([readJson<Inventory>('/api/accounts'), readJson<Accounting>(`/api/accounts/accounting?month=${encodeURIComponent(month)}`)]);
    if (current !== generation.current) return;
    const errors: string[] = [];
    if (results[0].status === 'fulfilled') setInventory(results[0].value); else errors.push(`Account inventory: ${String(results[0].reason)}`);
    if (results[1].status === 'fulfilled') setAccounting(results[1].value); else errors.push(`Monthly accounting: ${String(results[1].reason)}`);
    setError(errors.join(' · '));
  }, [month]);
  useEffect(() => { setAccounting(null); void refresh(); const interval = setInterval(() => void refresh(), 60_000); return () => { generation.current++; clearInterval(interval); }; }, [refresh]);

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const account = inventory?.accounts.find((item) => item.id === selectedAccount);
    if (!account) { setNotice('Choose a registered account for this record.'); return; }
    const amount = Number(values.get('amount'));
    if (!Number.isFinite(amount)) { setNotice('Enter a valid amount.'); return; }
    // Keep the same source identity on a retry after an ambiguous transport failure.
    pendingRecord.current ??= { sourceId: 'manual', sourceRecordId: crypto.randomUUID(), accountId: account.id, provider: account.provider, kind, amount, currency: String(values.get('currency')), date: String(values.get('date')), note: String(values.get('note') || '') };
    setBusy(true); setNotice('');
    try {
      const result = await readJson<{ inserted: number; duplicates: number }>('/api/accounts/accounting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [pendingRecord.current] }) });
      pendingRecord.current = null;
      setNotice(result.inserted ? 'Record saved. Monthly totals reflect the selected period.' : 'This record was already saved; it was not counted twice.');
      form.reset(); setSelectedAccount(''); setKind('payment'); await refresh();
    } catch (cause) { setNotice(`Record not confirmed: ${cause instanceof Error ? cause.message : String(cause)}. Retry preserves its identity.`); }
    finally { setBusy(false); }
  }

  return <section className="billing" aria-label="Monthly accounting and accounts">
    <div className="bill-head"><div><p className="eyebrow">Your AI accounts</p><h2>Month overview</h2><p className="muted">Payments and accrued consumption are separate views of money. Estimates are hypothetical.</p></div>
      <label className="field">Month<input aria-label="Accounting month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></div>
    {error ? <p className="status danger" role="status">{error} Previous observations remain visible.</p> : null}
    <div className="bill-grid mini monthly-metrics">
      <Metric tone="billing" label="Payments this month" value={fmtMoney(accounting?.paymentsUsd ?? null)} note="Recorded payments; not added to consumption" />
      <Metric tone="billing" label="Provider accrued consumption" value={fmtMoney(accounting?.accruedUsd ?? null)} note="Provider charges reported for this month" />
      <Metric label="API-equivalent estimate" value={fmtMoney(accounting?.apiEquivalentUsd ?? null)} note="Hypothetical list-price value, not cash spent" />
      <Metric tone="live" label="Account coverage" value={inventory ? `${inventory.accounts.length} tracked` : 'Unknown'} note={inventory ? `${inventory.accounts.filter(a => a.quota.status === 'fresh').length} current quotas · financial coverage partial` : 'Coverage unknown'} />
    </div>
    <details className="accordion"><summary>Source freshness and coverage <span className="accordion-hint">Missing is not zero</span></summary><div className="accordion-content"><CoverageList labels={Object.fromEntries((inventory?.accounts || []).map(account => [`quota:${account.id}`, `${account.label} quota`]))} sources={[...(inventory?.sources || []), ...(accounting?.coverage || []).filter((s) => !inventory?.sources.some((i) => i.id === s.id))]} tz={tz} /></div></details>
    <div className="table-wrap"><table><caption className="sr-only">Account inventory, routing enrollment and quota evidence</caption><thead><tr><th>Account</th><th>Origin / billing</th><th>Routing</th><th>Quota remaining</th><th>Coverage</th></tr></thead><tbody>
      {inventory?.accounts.map((account) => <tr key={account.id}><td><strong>{account.label || account.id}</strong><div className="muted">{account.provider}</div></td><td>{account.origin}<div className="muted">{account.billingMode}</div></td><td>{account.routingEnrolled === null ? 'Unknown' : account.routingEnrolled ? 'Enrolled' : 'Accounting only'}</td><td>{account.quota.remaining === null ? 'Unknown' : `${account.quota.remaining.toLocaleString(undefined, { maximumFractionDigits: 1 })}${account.quota.unit === 'percent' ? '%' : ''}`}<div className="muted">{account.quota.status}{account.quota.resetAt ? ` · resets ${fmtDate(account.quota.resetAt, tz)}` : ''}</div></td><td><span className={`pill ${account.coverage.status === 'available' ? 'ok' : 'warn'}`}>{account.coverage.status}</span><div className="muted">{account.coverage.reason}</div></td></tr>)}
      {!inventory?.accounts.length ? <tr><td colSpan={5} className="muted">No accounts observed yet. Check source coverage above.</td></tr> : null}
    </tbody></table></div>
    <details className="accordion"><summary>Add a manual financial record <span className="accordion-hint">Payments, consumption, balances or subscription schedule</span></summary><div className="accordion-content">
      <form className="record-form" onSubmit={saveRecord} onChange={() => { pendingRecord.current = null; }}>
        <label className="field">Account<select required value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}><option value="">Choose account</option>{inventory?.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.provider}</option>)}</select></label>
        <label className="field">Record type<select value={kind} onChange={(e) => setKind(e.target.value as import('@/lib/accounting').FinancialKind)}><option value="payment">Actual payment / refund</option><option value="accrual">Provider accrued consumption</option><option value="balance">Prepaid balance</option><option value="subscription">Subscription schedule</option><option value="api-equivalent">API-equivalent estimate</option></select></label>
        <label className="field">Amount<input name="amount" type="number" step="0.000001" required placeholder="0.00" /></label>
        <label className="field">Currency<input name="currency" required defaultValue="USD" pattern="[A-Z]{3}" maxLength={3} /></label>
        <label className="field">Effective date<input name="date" type="date" required /></label>
        <label className="field record-note">Note<input name="note" placeholder="Invoice reference, credit or explanation" maxLength={1000} /></label>
        <p className="muted record-note">Use a negative payment for a refund. A prepaid top-up is a payment; its consumption is an accrual. They are never summed into one expense.</p>
        <button type="submit" disabled={busy || !inventory?.accounts.length}>{busy ? 'Saving…' : 'Save record'}</button>
      </form>{notice ? <p role="status" className="status">{notice}</p> : null}
    </div></details>
    <details className="accordion"><summary>Financial records <span className="accordion-hint">{accounting?.records.length ?? 0} in selected month</span></summary><div className="table-wrap"><table><thead><tr><th>Date</th><th>Provider / account</th><th>Type</th><th>Amount</th><th>Source / note</th></tr></thead><tbody>{accounting?.records.map((record) => <tr key={record.id || `${record.sourceId}:${record.sourceRecordId}`}><td>{record.date}</td><td>{record.provider}<div className="muted">{inventory?.accounts.find((a) => a.id === record.accountId)?.label || record.accountId}</div></td><td>{record.kind}</td><td>{record.currency} {record.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td><td>{record.sourceId}<div className="muted">{record.note}</div></td></tr>)}{!accounting?.records.length ? <tr><td colSpan={5} className="muted">No records in this period. Totals may be unknown.</td></tr> : null}</tbody></table></div></details>
  </section>;
}
