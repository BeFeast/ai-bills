import type { FinancialRecord, FxRate } from './accounting';

/**
 * Month reconciliation: what the provider charged (statement records) against what the usage ledger
 * priced at public list prices (API-equivalent). Per provider, because that is the granularity both
 * sides share without guessing. Differences are shown, never corrected.
 */
export type ReconciliationStatus = 'matched' | 'partial' | 'no-usage-evidence' | 'no-invoice';
export type ReconciliationRow = {
  provider: string; month: string;
  /** Sum of provider-reported charges for the month; accruals when present, otherwise payments. */
  invoicedUsd: number | null; invoiceBasis: 'accrual' | 'payment' | null; invoiceRecords: number;
  /** API-equivalent from the usage ledger for the same month; null when unpriced or not evidenced. */
  usageUsd: number | null; unpricedRequests: number;
  differenceUsd: number | null; status: ReconciliationStatus; note: string;
};
export type Reconciliation = { month: string; rows: ReconciliationRow[]; usagePeriod: { start: string | null; end: string | null } | null; tolerance: { fraction: number; minimumUsd: number } };

export const RECONCILIATION_TOLERANCE = { fraction: 0.05, minimumUsd: 1 };

/** Ledger and statement providers meet on one key: lowercase, gateway prefixes dropped. */
export function providerKey(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase().replace(/^openai-compatible-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

type LedgerMonth = { period_start?: unknown; period_end?: unknown; date?: unknown; by_upstream?: unknown; unpriced?: unknown };
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

/** Usage side per provider from the ledger's month rollup; only when the rollup is for the requested month. */
export function usageByProvider(ledgerMonth: unknown, month: string): { rows: Map<string, { usd: number | null; requests: number; unpriced: number }>; period: Reconciliation['usagePeriod'] } {
  const ledger = (ledgerMonth && typeof ledgerMonth === 'object' ? ledgerMonth : {}) as LedgerMonth;
  const start = typeof ledger.period_start === 'string' ? ledger.period_start : typeof ledger.date === 'string' ? ledger.date : null;
  const end = typeof ledger.period_end === 'string' ? ledger.period_end : null;
  const rows = new Map<string, { usd: number | null; requests: number; unpriced: number }>();
  if (!start || !start.startsWith(month)) return { rows, period: start ? { start, end } : null };
  for (const raw of Array.isArray(ledger.by_upstream) ? ledger.by_upstream : []) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const key = providerKey(typeof row.provider === 'string' ? row.provider : null);
    const current = rows.get(key) ?? { usd: null, requests: 0, unpriced: 0 };
    const usd = number(row.api_equivalent_usd);
    const requests = number(row.requests) ?? 0;
    // A provider whose rows are all unpriced has no usage figure, not a zero one.
    if (usd !== null) current.usd = (current.usd ?? 0) + usd; else current.unpriced += requests;
    current.requests += requests;
    rows.set(key, current);
  }
  return { rows, period: { start, end } };
}

export function reconcileMonth(records: FinancialRecord[], ledgerMonth: unknown, month: string, options: { tolerance?: typeof RECONCILIATION_TOLERANCE; rates?: Map<string, FxRate> } = {}): Reconciliation {
  const tolerance = options.tolerance ?? RECONCILIATION_TOLERANCE; const rates = options.rates ?? new Map<string, FxRate>();
  const usage = usageByProvider(ledgerMonth, month);
  const ledgerForMonth = Boolean(usage.period?.start?.startsWith(month));
  const invoices = new Map<string, { accrual: number | null; payment: number | null; count: number; other: number; foreign: Set<string>; converted: Set<string> }>();
  for (const record of records) {
    if (!record.date.startsWith(`${month}-`)) continue;
    const key = providerKey(record.provider);
    const entry = invoices.get(key) ?? { accrual: null, payment: null, count: 0, other: 0, foreign: new Set<string>(), converted: new Set<string>() };
    // Balances, subscription schedules and our own estimates are not statement charges; they are counted so their absence from the figure is explained.
    if (record.kind !== 'accrual' && record.kind !== 'payment') { entry.other++; invoices.set(key, entry); continue; }
    entry.count++;
    // Same rule as the accounting totals: declared rates convert, anything else stays out and is named.
    const declared = rates.get(record.currency)?.rate_to_usd;
    const rate = record.currency === 'USD' ? 1 : typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : undefined;
    if (rate === undefined) entry.foreign.add(record.currency);
    else { entry[record.kind] = (entry[record.kind] ?? 0) + record.amount * rate; if (rate !== 1) entry.converted.add(record.currency); }
    invoices.set(key, entry);
  }
  const providers = [...new Set([...invoices.keys(), ...usage.rows.keys()])].sort();
  const rows: ReconciliationRow[] = providers.map(provider => {
    const invoice = invoices.get(provider); const used = usage.rows.get(provider);
    const basis: ReconciliationRow['invoiceBasis'] = invoice?.accrual !== null && invoice?.accrual !== undefined ? 'accrual' : invoice?.payment !== null && invoice?.payment !== undefined ? 'payment' : null;
    const invoicedUsd = basis ? invoice![basis] : null;
    const usageUsd = used?.usd ?? null;
    const notes: string[] = [];
    if (invoice?.converted.size) notes.push(`${[...invoice.converted].join(', ')} converted at declared rates`);
    if (invoice?.foreign.size) notes.push(`${[...invoice.foreign].join(', ')} records excluded (no verified conversion)`);
    if (invoice?.other) notes.push(`${invoice.other} balance/subscription/estimate record${invoice.other === 1 ? '' : 's'} not counted as statement charges`);
    if (used?.unpriced) notes.push(`${used.unpriced} unpriced requests not in the usage figure`);
    let status: ReconciliationStatus; let differenceUsd: number | null = null;
    if (invoicedUsd !== null && usageUsd !== null) {
      differenceUsd = Math.round((invoicedUsd - usageUsd) * 100) / 100;
      const limit = Math.max(tolerance.minimumUsd, Math.abs(invoicedUsd) * tolerance.fraction);
      status = Math.abs(differenceUsd) <= limit ? 'matched' : 'partial';
      notes.unshift(status === 'matched' ? `within ${Math.round(tolerance.fraction * 100)}% / $${tolerance.minimumUsd}` : 'statement and list-price usage differ; both figures kept');
    } else if (invoicedUsd !== null) {
      status = 'no-usage-evidence';
      notes.unshift(!ledgerForMonth ? 'ledger rollup is not for this month' : used ? 'usage rows exist but none are priced' : 'no usage rows for this provider in the ledger month');
    } else {
      status = 'no-invoice';
      notes.unshift(invoice?.count ? 'only non-USD statement records' : 'no statement charges (payments or accruals) for this provider and month');
    }
    return { provider, month, invoicedUsd, invoiceBasis: basis, invoiceRecords: invoice?.count ?? 0, usageUsd, unpricedRequests: used?.unpriced ?? 0, differenceUsd, status, note: notes.join(' · ') };
  });
  return { month, rows, usagePeriod: usage.period, tolerance };
}
