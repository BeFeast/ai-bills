/**
 * CSV export of a ledger period grouped by one dimension. Facts only: what the rollup holds, with the
 * period's reconciliation state on every row so a consumer never mistakes a partial month for a whole one.
 */
export const EXPORT_DIMENSIONS = ['project', 'client', 'model', 'account', 'upstream'] as const;
export const EXPORT_PERIODS = ['today', 'month', 'last_24h'] as const;
export type ExportDimension = typeof EXPORT_DIMENSIONS[number];
export type ExportPeriod = typeof EXPORT_PERIODS[number];

type Row = Record<string, unknown>;
const text = (v: unknown) => typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
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
  const header = [by, ...(by === 'upstream' ? ['provider'] : []), 'requests', 'failed', 'rate_limited', 'tokens', 'api_equivalent_usd', 'priced_api_equivalent_usd', 'pricing', 'period', 'period_start', 'period_end', 'evidence'];
  const lines = [header.map(csvCell).join(',')];
  for (const g of groups) {
    const api = num(g.api_equivalent_usd); const priced = num(g.priced_api_equivalent_usd);
    lines.push([
      text(g.name), ...(by === 'upstream' ? [text(g.provider)] : []), num(g.requests) ?? 0, num(g.failed) ?? 0, num(g.rate_limited) ?? 0, num(g.tokens) ?? 0,
      api === null ? '' : api.toFixed(6), priced === null ? '' : priced.toFixed(6), api === null ? (priced ? 'partial (unpriced models excluded)' : 'unpriced') : 'complete',
      text(period.period), text(period.period_start), text(period.period_end), evidence,
    ].map(csvCell).join(','));
  }
  const unreconciled = num(reconciliation.unreconciled_native_observations);
  if (unreconciled) lines.push([`(unreconciled native observations)`, ...(by === 'upstream' ? [''] : []), unreconciled, '', '', num(reconciliation.unreconciled_native_token_observations) ?? '', '', '', 'not priced', text(period.period), text(period.period_start), text(period.period_end), 'unreconciled: may overlap with rows above'].map(csvCell).join(','));
  return { filename: `zecori-usage-${label}-by-${by}.csv`, csv: lines.join('\r\n') + '\r\n', rows: groups.length };
}
