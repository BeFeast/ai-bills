'use client';

import type { Guard, GuardsReport } from '@/lib/guards';
import { fmtDate } from './format';
import { Card, Cell, Pill, Table, type Column } from './ui';

const guardNames: Record<keyof GuardsReport['guards'], string> = { stale: 'Quota freshness (5 h)', consistency: 'Proxy vs website cross-check', probe: 'Model probe (hourly)', mapping: 'Configured quota links', credits: 'Codex credits spent while quota is free' };
const checkColumns: Column<'account' | 'verdict' | 'proxy' | 'website' | 'at'>[] = [
  { key: 'account', label: 'Account' }, { key: 'verdict', label: 'Verdict' }, { key: 'proxy', label: 'Proxy' }, { key: 'website', label: 'Website' }, { key: 'at', label: 'Checked', mono: true }];
const probeColumns: Column<'model' | 'outcome'>[] = [{ key: 'model', label: 'Model', mono: true }, { key: 'outcome', label: 'Outcome' }];
const readingText = (reading: { state: string; used: Record<string, number> }) => `${reading.state}${Object.keys(reading.used).length ? ` · ${Object.entries(reading.used).map(([label, used]) => `${label} ${Number(used.toFixed(1))}%`).join(', ')}` : ''}`;

function GuardRow({ name, guard, tz }: { name: string; guard: Guard; tz: string }) {
  return <li className={`alert-row alert-row--${guard.status === 'up' ? 'ok' : 'bad'}`}>
    <Pill tone={guard.status === 'up' ? 'ok' : 'bad'} dot>{guard.status}</Pill>
    <div className="alert-row__text"><span className="alert-row__title">{name}</span><span className="t-small">{guard.message}</span></div>
    <span className="alert-row__meta mono-faint">last run {guard.lastRunAt ? fmtDate(guard.lastRunAt, tz) : 'never'}</span>
  </li>;
}

/** What the quota guards saw: the same up/down the push monitors relay, with the last cross-check and probe behind it. */
export function QuotaGuards({ report, tz }: { report: GuardsReport | null; tz: string }) {
  if (!report) return <Card title="Quota guards"><p className="t-small">Loading quota guards…</p></Card>;
  return <Card title="Quota guards" subtitle={`Evaluated ${fmtDate(report.generatedAt, tz)} · relayed to the push monitors by the collector`} aria-label="Quota guards">
    <div className="stack">
      <ul className="alert-list" aria-label="Guards">{(Object.keys(guardNames) as (keyof GuardsReport['guards'])[]).map((key) => <GuardRow key={key} name={guardNames[key]} guard={report.guards[key]} tz={tz} />)}</ul>
      {report.checks.length ? <Table columns={checkColumns} rows={report.checks} rowKey={(check) => check.accountKey} renderCell={(check, column) => {
        switch (column.key) {
          case 'account': return check.accountKey;
          case 'verdict': return <Cell main={<Pill tone={check.flagged ? 'bad' : check.verdict === 'mismatch' ? 'warn' : check.verdict === 'consistent' ? 'ok' : 'idle'}>{check.flagged ? 'flagged' : check.verdict}</Pill>} sub={check.reason} />;
          case 'proxy': return readingText(check.proxy);
          case 'website': return readingText(check.second);
          case 'at': return fmtDate(check.checkedAt, tz);
        }
      }} /> : null}
      {report.probe.models.length ? <Table columns={probeColumns} rows={report.probe.models} rowKey={(model) => model.model} renderCell={(model, column) => column.key === 'model' ? model.model
        : <Cell main={<Pill tone={model.outcome === 'ok' ? 'ok' : model.outcome === 'rate_limited' || model.outcome === 'retired' || model.outcome === 'skipped' ? 'warn' : 'bad'}>{model.outcome}{model.http_status ? ` · HTTP ${model.http_status}` : ''}</Pill>} sub={model.retried ? `retried once${model.message ? ` · ${model.message}` : ''}` : model.message} />} /> : null}
    </div>
  </Card>;
}
