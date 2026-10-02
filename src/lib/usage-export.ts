/**
 * CSV export of a ledger period grouped by one dimension. Facts only: what the rollup holds, with the
 * period's reconciliation state on every row so a consumer never mistakes a partial month for a whole one.
 * The two USD columns are verified prices only. Estimates from an earlier version's list price are appended
 * as their own columns (`estimated_api_equivalent_usd`, `estimated_from`), so existing columns keep their position.
 * Account and upstream names that look like keys are exported as a sha256 fingerprint, never as the credential.
 */
import { credentialSafeName } from './redact';
export const EXPORT_DIMENSIONS = ['project', 'client', 'model', 'account', 'upstream'] as const;
export const EXPORT_PERIODS = ['today', 'month', 'last_24h'] as const;
export type ExportDimension = typeof EXPORT_DIMENSIONS[number];
export type ExportPeriod = typeof EXPORT_PERIODS[number];

type Row = Record<string, unknown>;
const text = (v: unknown) => typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
/** "model from source" pairs, e.g. `claude-opus-5-5 from claude-opus-5`; `; ` between models. */
const sources = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.entries(v as Row).filter(([, source]) => typeof source === 'string' && source).map(([model, source]) => `${model} from ${source}`).join('; ') : '';
function pricing(api: number | null, priced: number | null, estimated: number | null, unpricedRequests: number | null): string {
  if (api !== null) return 'complete';
  if (estimated !== null) return unpricedRequests ? 'partial (includes estimates; unpriced models excluded)' : 'includes estimates';
  return priced ? 'partial (unpriced models excluded)' : 'unpriced';
}
/** RFC 4180 cell: quote when needed, double the quotes; never let a cell start a spreadsheet formula. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function usageCsv(ledgerPeriod: unknown, by: ExportDimension): { filename: string; csv: string; rows: number } {
  const period = (ledgerPeriod && typeof ledgerPeriod === 'object' ? ledgerPeriod : {}) as Row;
  const groups = Array.isArray(period[`by_${by}`]) ? period[`by_${by}`] as Row[] : [];
  const reconciliation = (period.reconciliation && typeof period.reconciliation === 'object' ? period.reconciliation : {}) as Row;
  const evidence = text(reconciliation.status) === 'partial' ? 'partial: unreconciled native observations excluded' : 'confirmed observations';
  const label = text(period.period) === 'rolling_24h' ? `rolling-24h-${text(period.period_end).slice(0, 13).replace(/[:T]/g, '')}` : `${text(period.period)}-${text(period.date)}`;
  const header = [by, ...(by === 'upstream' ? ['provider'] : []), 'requests', 'failed', 'rate_limited', 'tokens', 'api_equivalent_usd', 'priced_api_equivalent_usd', 'pricing', 'period', 'period_start', 'period_end', 'evidence', 'estimated_api_equivalent_usd', 'estimated_from'];
  const lines = [header.map(csvCell).join(',')];
  for (const g of groups) {
    const api = num(g.api_equivalent_usd); const priced = num(g.priced_api_equivalent_usd); const estimated = num(g.estimated_api_equivalent_usd);
    lines.push([
      by === 'account' || by === 'upstream' ? credentialSafeName(text(g.name)) : text(g.name), ...(by === 'upstream' ? [text(g.provider)] : []), num(g.requests) ?? 0, num(g.failed) ?? 0, num(g.rate_limited) ?? 0, num(g.tokens) ?? 0,
      api === null ? '' : api.toFixed(6), priced === null ? '' : priced.toFixed(6), pricing(api, priced, estimated, num(g.unpriced_requests)),
      text(period.period), text(period.period_start), text(period.period_end), evidence,
      estimated === null ? '' : estimated.toFixed(6), sources(g.estimated_from),
    ].map(csvCell).join(','));
  }
  const unreconciled = num(reconciliation.unreconciled_native_observations);
  if (unreconciled) lines.push([`(unreconciled native observations)`, ...(by === 'upstream' ? [''] : []), unreconciled, '', '', num(reconciliation.unreconciled_native_token_observations) ?? '', '', '', 'not priced', text(period.period), text(period.period_start), text(period.period_end), 'unreconciled: may overlap with rows above', '', ''].map(csvCell).join(','));
  return { filename: `zecori-usage-${label}-by-${by}.csv`, csv: lines.join('\r\n') + '\r\n', rows: groups.length };
}
