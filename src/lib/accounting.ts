import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rmdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveSecret } from './infisical';
import type { SecretRef } from './config';

export type Freshness = { id: string; status: 'fresh' | 'stale' | 'missing' | 'error' | 'unsupported'; observedAt: string | null; maxAgeSeconds: number; message: string };
export type FinancialKind = 'payment' | 'accrual' | 'api-equivalent' | 'balance' | 'subscription';
export type FinancialRecord = { id: string; sourceId: string; sourceRecordId: string; accountId: string; provider: string; kind: FinancialKind; amount: number; currency: string; date: string; observedAt: string; note?: string };
export type FinancialInput = Omit<FinancialRecord, 'id' | 'observedAt'>;
export type DeclaredAccount = { id: string; provider: string; label: string; website_url?: string; operator_note?: string; billing_mode?: 'included' | 'metered' | 'unknown'; origin?: 'external' | 'declared'; source_ids?: string[] };
export type FinancialSource = {
  id: string; kind: 'json-file' | 'json-http' | 'manual' | 'unsupported'; path?: string; url?: string;
  authorization?: SecretRef; max_age_seconds?: number; account_id?: string; provider?: string;
  // Dot paths allow configured read-only provider JSON adapters without copying credentials.
  records_path?: string; observed_at_path?: string; record_kind?: FinancialKind;
  fields?: Partial<Record<keyof FinancialInput, string>>; currency?: string;
};
export type AccountBinding = { id: string; label?: string; members: string[]; quota_account_key?: string; billing_mode?: 'included' | 'metered' | 'unknown' };
export type AccountingConfig = { openrouter_account_id?: string; account_bindings?: AccountBinding[]; declared_inventory_complete?: boolean; journal_path?: string; registry_snapshot_path?: string; proxy_auth_dir?: string; proxy_config_path?: string; declared_accounts?: DeclaredAccount[]; sources?: FinancialSource[] };
export type AccountingOverview = { month: string; currency: 'USD'; paymentsUsd: number | null; accruedUsd: number | null; apiEquivalentUsd: number | null; records: FinancialRecord[]; coverage: Freshness[]; complete: boolean; diagnostics: string[] };

const KINDS = new Set<FinancialKind>(['payment', 'accrual', 'api-equivalent', 'balance', 'subscription']);
export class AccountingInputError extends Error {}
export class AccountingConflictError extends Error {}
export const opaqueId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
export function validateRecord(input: unknown, observedAt = new Date().toISOString()): FinancialRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountingInputError('Record must be an object');
  const r = input as Record<string, unknown>;
  for (const key of ['sourceId', 'sourceRecordId', 'accountId', 'provider', 'date', 'currency']) {
    if (typeof r[key] !== 'string' || !r[key].trim() || (r[key] as string).length > 200) throw new AccountingInputError(`Invalid ${key}`);
  }
  if (!KINDS.has(r.kind as FinancialKind)) throw new AccountingInputError('Invalid financial kind');
  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || Math.abs(r.amount) > 1e12) throw new AccountingInputError('Amount must be a finite number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date as string) || !Number.isFinite(Date.parse(`${r.date}T12:00:00Z`)) || new Date(`${r.date}T12:00:00Z`).toISOString().slice(0, 10) !== r.date) throw new AccountingInputError('Invalid calendar date');
  if (!/^[A-Z]{3}$/.test(r.currency as string)) throw new AccountingInputError('Currency must be an ISO currency code');
  if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 1000)) throw new AccountingInputError('Invalid note');
  const record: FinancialRecord = { id: opaqueId(`${r.sourceId}\0${r.sourceRecordId}`), sourceId: r.sourceId as string, sourceRecordId: r.sourceRecordId as string, accountId: r.accountId as string, provider: r.provider as string, kind: r.kind as FinancialKind, amount: r.amount, currency: r.currency as string, date: r.date as string, observedAt };
  if (typeof r.note === 'string') record.note = r.note;
  return record;
}

function sameRecord(a: FinancialRecord, b: FinancialRecord): boolean {
  const { observedAt: _a, ...left } = a; const { observedAt: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}
export function deduplicateRecords(rows: FinancialRecord[]): FinancialRecord[] {
  const records = new Map<string, FinancialRecord>();
  for (const row of rows) {
    const previous = records.get(row.id);
    if (previous && !sameRecord(previous, row)) throw new AccountingConflictError(`Conflicting source record ${row.id}`);
    if (!previous) records.set(row.id, row);
  }
  return [...records.values()];
}

export async function readFinancialJournal(path: string): Promise<FinancialRecord[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return deduplicateRecords(text.split('\n').filter(Boolean).map(line => {
    const raw = JSON.parse(line); return validateRecord(raw, typeof raw.observedAt === 'string' ? raw.observedAt : new Date(0).toISOString());
  }));
}

/** Cross-process exclusive lock; never reclaim an uncertain owner automatically. */
export async function appendFinancialRecords(path: string, inputs: unknown[]): Promise<{ inserted: number; duplicates: number }> {
  if (!inputs.length || inputs.length > 1000) throw new AccountingInputError('Import must contain 1–1000 records');
  const now = new Date().toISOString();
  const requested = inputs.map(row => validateRecord(row, now));
  const unique = deduplicateRecords(requested);
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let acquired = false;
  for (let n = 0; n < 50; n++) {
    try { await mkdir(lock); acquired = true; break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!acquired) throw new AccountingConflictError('Accounting journal is busy; retry after the writer completes');
  try {
    const existing = await readFinancialJournal(path);
    const combined = deduplicateRecords([...existing, ...unique]);
    const known = new Set(existing.map(row => row.id));
    const added = combined.filter(row => !known.has(row.id));
    if (added.length) {
      const file = await open(path, 'a', 0o600);
      try { await file.writeFile(added.map(row => JSON.stringify(row)).join('\n') + '\n'); await file.sync(); } finally { await file.close(); }
    }
    return { inserted: added.length, duplicates: requested.length - added.length };
  } finally { await rmdir(lock); }
}

export function freshness(id: string, observedAt: string | null, maxAgeSeconds = 300, now = Date.now()): Freshness {
  const ms = observedAt === null ? NaN : Date.parse(observedAt);
  const valid = Number.isFinite(ms) && ms <= now + 60_000;
  return { id, observedAt: valid ? observedAt : null, maxAgeSeconds, status: !valid ? 'missing' : now - ms > maxAgeSeconds * 1000 ? 'stale' : 'fresh', message: !valid ? 'No valid source observation time' : now - ms > maxAgeSeconds * 1000 ? 'Source observation is stale' : 'Source observation is current' };
}
function at(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined, value);
}
export async function readFinancialSource(source: FinancialSource): Promise<{ records: FinancialRecord[]; freshness: Freshness }> {
  const maxAge = source.max_age_seconds ?? 300;
  const unavailable = (status: Freshness['status'], message: string) => ({ records: [], freshness: { id: source.id, status, observedAt: null, maxAgeSeconds: maxAge, message } });
  if (source.kind === 'unsupported') return unavailable('unsupported', 'No supported financial adapter; manual records may be added');
  if (source.kind === 'manual') return unavailable('missing', 'Manual source: completeness requires operator reconciliation');
  try {
    let payload: unknown;
    if (source.kind === 'json-file' && source.path) payload = JSON.parse(await readFile(source.path, 'utf8'));
    else if (source.kind === 'json-http' && source.url) {
      const authorization = await resolveSecret(source.authorization);
      const response = await fetch(source.url, { method: 'GET', headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store' });
      if (!response.ok) return unavailable('error', `Provider read failed (HTTP ${response.status})`);
      payload = await response.json();
    } else return unavailable('unsupported', 'Adapter configuration is incomplete');
    const observed = at(payload, source.observed_at_path ?? 'observedAt');
    // File mtime/HTTP success is not a substitute for provider data freshness.
    const observedAt = typeof observed === 'string' ? observed : null;
    const rows = at(payload, source.records_path ?? 'records');
    if (!Array.isArray(rows)) return unavailable('error', 'Expected provider record array');
    const records = rows.map(raw => {
      if (!raw || typeof raw !== 'object') throw new AccountingInputError('Malformed provider record');
      const row = raw as Record<string, unknown>;
      const value = (key: keyof FinancialInput) => source.fields?.[key] ? at(row, source.fields[key]) : row[key];
      return validateRecord({ sourceId: source.id, sourceRecordId: value('sourceRecordId'), accountId: value('accountId') ?? source.account_id, provider: value('provider') ?? source.provider, kind: value('kind') ?? source.record_kind, amount: value('amount'), currency: value('currency') ?? source.currency, date: value('date'), note: value('note') }, observedAt ?? new Date(0).toISOString());
    });
    return { records: deduplicateRecords(records), freshness: freshness(source.id, observedAt, maxAge) };
  } catch { return unavailable('error', 'Source could not be read or validated; no records imported'); }
}

export function currentMonth(timezone = 'Asia/Jerusalem', date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`;
}
export async function accountingOverview(config: AccountingConfig = {}, month = currentMonth()): Promise<AccountingOverview> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AccountingInputError('Invalid month');
  const results = await Promise.all((config.sources ?? []).map(readFinancialSource));
  const coverage = results.map(result => result.freshness);
  const diagnostics: string[] = [];
  let journal: FinancialRecord[] = [];
  if (config.journal_path) {
    try {
      journal = await readFinancialJournal(config.journal_path);
      const observedAt = (await stat(config.journal_path)).mtime.toISOString();
      coverage.push({ id: 'manual-journal', status: 'fresh', observedAt, maxAgeSeconds: 0, message: 'Journal readable; entries are not proof of complete provider history' });
    } catch (error) { coverage.push({ id: 'manual-journal', status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error', observedAt: null, maxAgeSeconds: 0, message: 'Journal unavailable or invalid' }); }
  }
  const collected = [...journal, ...results.flatMap(result => result.records)];
  let records: FinancialRecord[];
  try { records = deduplicateRecords(collected).filter(row => row.date.startsWith(`${month}-`)); }
  catch { records = journal.filter(row => row.date.startsWith(`${month}-`)); diagnostics.push('Conflicting source records: provider records excluded until reconciliation'); }
  const currencies = new Set(records.filter(row => row.currency !== 'USD').map(row => row.currency));
  if (currencies.size) diagnostics.push(`Not included in USD totals: ${[...currencies].join(', ')}; no verified conversion supplied`);
  if (!coverage.length) coverage.push({ id: 'financial-coverage', status: 'missing', observedAt: null, maxAgeSeconds: 0, message: 'No financial sources configured' });
  const sum = (kind: FinancialKind) => { const rows = records.filter(row => row.kind === kind && row.currency === 'USD'); return rows.length ? rows.reduce((total, row) => total + row.amount, 0) : null; };
  // Readable sources cannot prove declared-account and full-period coverage.
  return { month, currency: 'USD', paymentsUsd: sum('payment'), accruedUsd: sum('accrual'), apiEquivalentUsd: sum('api-equivalent'), records, coverage, complete: false, diagnostics };
}
