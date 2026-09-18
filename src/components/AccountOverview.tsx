'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { fmtDate, fmtMoney } from './format';
import { Button, Cell, Input, Notice, Pill, Select, StatTile, Table, TileGrid, type Column } from './ui';

type CoverageSource = import('@/lib/accounting').Freshness;
type Inventory = import('@/lib/accounts').AccountRegistry;
type RegistryAccount = import('@/lib/accounts').RegistryAccount;
type FinancialRecord = import('@/lib/accounting').FinancialInput;
type StoredRecord = import('@/lib/accounting').FinancialRecord;
type Accounting = import('@/lib/accounting').AccountingOverview;

export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`);
  return data as T;
}

export function CoverageList({ sources, tz, labels = {} }: { sources: CoverageSource[]; tz: string; labels?: Record<string, string> }) {
  return <div className="stack" style={{ gap: 0 }}>{sources.length ? sources.map((source) => <div className="coverage-row" key={source.id}>
    <strong>{labels[source.id] || source.id.replaceAll('-', ' ')}</strong>
    <Pill tone={source.status === 'fresh' ? 'ok' : source.status === 'error' ? 'bad' : 'warn'}>{source.status}</Pill>
    <span className="mono-faint" style={{ marginLeft: 'auto' }}>{source.observedAt ? fmtDate(source.observedAt, tz) : 'Never observed'}{source.message ? ` · ${source.message}` : ''}</span>
  </div>) : <p className="t-small">No source receipts available. Completeness is unknown.</p>}</div>;
}

const inventoryColumns: Column<'account' | 'origin' | 'routing' | 'quota' | 'coverage'>[] = [
  { key: 'account', label: 'Account' }, { key: 'origin', label: 'Origin / billing' }, { key: 'routing', label: 'Routing' }, { key: 'quota', label: 'Quota remaining' }, { key: 'coverage', label: 'Coverage' },
];
const recordColumns: Column<'date' | 'who' | 'kind' | 'amount' | 'source'>[] = [
  { key: 'date', label: 'Date', mono: true }, { key: 'who', label: 'Provider / account' }, { key: 'kind', label: 'Type' }, { key: 'amount', label: 'Amount', mono: true, align: 'right' }, { key: 'source', label: 'Source / note' },
];
const kindOptions = [
  { value: 'payment', label: 'Actual payment / refund' }, { value: 'accrual', label: 'Provider accrued consumption' }, { value: 'balance', label: 'Prepaid balance' }, { value: 'subscription', label: 'Subscription schedule' }, { value: 'api-equivalent', label: 'API-equivalent estimate' },
];

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

  function inventoryCell(account: RegistryAccount, column: Column<typeof inventoryColumns[number]['key']>): ReactNode {
    switch (column.key) {
      case 'account': return <Cell main={account.label || account.id} sub={account.provider} />;
      case 'origin': return <Cell main={account.origin} sub={account.billingMode} />;
      case 'routing': return account.routingEnrolled === null ? 'Unknown' : account.routingEnrolled ? 'Enrolled' : 'Accounting only';
      case 'quota': return <Cell main={<span className="tabular">{account.quota.remaining === null ? 'Unknown' : `${account.quota.remaining.toLocaleString(undefined, { maximumFractionDigits: 1 })}${account.quota.unit === 'percent' ? '%' : ''}`}</span>} sub={`${account.quota.status}${account.quota.resetAt ? ` · resets ${fmtDate(account.quota.resetAt, tz)}` : ''}`} />;
      case 'coverage': return <div className="cell" style={{ alignItems: 'flex-start', gap: 4 }}><Pill tone={account.coverage.status === 'available' ? 'ok' : 'warn'}>{account.coverage.status}</Pill><span className="cell__sub">{account.coverage.reason}</span></div>;
    }
  }
  function recordCell(record: StoredRecord, column: Column<typeof recordColumns[number]['key']>): ReactNode {
    switch (column.key) {
      case 'date': return record.date;
      case 'who': return <Cell main={record.provider} sub={inventory?.accounts.find((a) => a.id === record.accountId)?.label || record.accountId} />;
      case 'kind': return record.kind;
      case 'amount': return `${record.currency} ${record.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
      case 'source': return <Cell main={record.sourceId} sub={record.note} />;
    }
  }

  return <section className="stack stack--loose" aria-label="Monthly accounting and accounts" style={{ gap: 24 }}>
    <div className="section-head">
      <div className="section-head__text"><span className="t-micro">Your AI accounts</span><h2 className="t-h1">Month overview</h2><span className="t-small">Payments and accrued consumption are separate views of money. Estimates are hypothetical.</span></div>
      <Input label="Month" aria-label="Accounting month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} fieldStyle={{ width: 180 }} />
    </div>
    {error ? <Notice tone="bad" role="status">{error} Previous observations remain visible.</Notice> : null}
    <TileGrid>
      <StatTile label="Payments this month" value={fmtMoney(accounting?.paymentsUsd ?? null)} note="Recorded payments; not added to consumption" />
      <StatTile label="Provider accrued consumption" value={fmtMoney(accounting?.accruedUsd ?? null)} note="Provider charges reported for this month" />
      <StatTile label="API-equivalent estimate" value={fmtMoney(accounting?.apiEquivalentUsd ?? null)} note="Hypothetical list-price value, not cash spent" />
      <StatTile label="Account coverage" value={inventory ? `${inventory.accounts.length} tracked` : 'Unknown'} note={inventory ? `${inventory.accounts.filter(a => a.quota.status === 'fresh').length} current quotas · financial coverage partial` : 'Coverage unknown'} />
    </TileGrid>
    <details className="bf-card details-card">
      <summary><span>Source freshness and coverage</span><span className="details-hint">missing is not zero</span></summary>
      <CoverageList labels={Object.fromEntries((inventory?.accounts || []).map(account => [`quota:${account.id}`, `${account.label} quota`]))} sources={[...(inventory?.sources || []), ...(accounting?.coverage || []).filter((s) => !inventory?.sources.some((i) => i.id === s.id))]} tz={tz} />
    </details>
    <Table caption="Account inventory, routing enrollment and quota evidence" columns={inventoryColumns} rows={inventory?.accounts ?? []} rowKey={(account) => account.id} renderCell={inventoryCell} empty="No accounts observed yet. Check source coverage above." />
    <details className="bf-card details-card">
      <summary><span>Add a manual financial record</span><span className="details-hint">payments, consumption, balances or subscription schedule</span></summary>
      <form className="stack stack--loose" onSubmit={saveRecord} onChange={() => { pendingRecord.current = null; }}>
        <div className="record-grid">
          <Select label="Account" required value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)} options={[{ value: '', label: 'Choose account' }, ...(inventory?.accounts ?? []).map((a) => ({ value: a.id, label: `${a.label} · ${a.provider}` }))]} />
          <Select label="Record type" value={kind} onChange={(e) => setKind(e.target.value as import('@/lib/accounting').FinancialKind)} options={kindOptions} />
          <Input label="Amount" name="amount" type="number" step="0.000001" required placeholder="0.00" />
          <Input label="Currency" name="currency" required defaultValue="USD" pattern="[A-Z]{3}" maxLength={3} />
          <Input label="Effective date" name="date" type="date" required />
        </div>
        <Input label="Note" name="note" placeholder="Invoice reference, credit or explanation" maxLength={1000} />
        <p className="t-small">Use a negative payment for a refund. A prepaid top-up is a payment; its consumption is an accrual. They are never summed into one expense.</p>
        <div className="toolbar" style={{ gap: 12 }}>
          <Button type="submit" disabled={busy || !inventory?.accounts.length}>{busy ? 'Saving…' : 'Save record'}</Button>
          {notice ? <span role="status" className="t-small" style={{ color: 'var(--ok)' }}>{notice}</span> : null}
        </div>
      </form>
    </details>
    <details className="bf-card details-card" open>
      <summary><span>Financial records</span><span className="details-hint">{accounting?.records.length ?? 0} in selected month</span></summary>
      <Table columns={recordColumns} rows={accounting?.records ?? []} rowKey={(record) => record.id || `${record.sourceId}:${record.sourceRecordId}`} renderCell={recordCell} empty="No records in this period. Totals may be unknown." />
    </details>
  </section>;
}
