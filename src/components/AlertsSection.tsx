'use client';

import type { AlertCondition, AlertEvent, AlertsReport } from '@/lib/alerts';
import { countdown, fmtDate } from './format';
import { Card, Cell, Notice, Pill, Table, type Column, type PillTone } from './ui';

const tone: Record<AlertCondition['state'], PillTone> = { bad: 'bad', warn: 'warn', ok: 'ok' };
const eventTone: Record<AlertEvent['kind'], PillTone> = { raised: 'warn', escalated: 'bad', eased: 'info', recovered: 'ok' };
const group = (key: string) => ({ quota: 'Quota', source: 'Source', ratelimit: 'Rate limit', renewal: 'Renewal', balance: 'Balance' }[key.split(':')[0]] ?? key.split(':')[0]);
const eventColumns: Column<'at' | 'kind' | 'what'>[] = [{ key: 'at', label: 'When', mono: true }, { key: 'kind', label: 'Event' }, { key: 'what', label: 'What' }];

/** Shows what the collector-side alerts process decided; it never evaluates rules or sends anything itself. */
export function AlertsSection({ report, now, tz }: { report: AlertsReport | null; now: number; tz: string }) {
  if (!report) return <Card title="Alerts"><p className="t-small">Loading alert state…</p></Card>;
  if (!report.available) return <Card title="Alerts" subtitle="Edge-triggered notifications evaluated beside the collector."><Notice tone="info" role="status">The alerts process has not reported yet. Configure <code>ai-bills-alerts</code> on the collector host; until then no rule is evaluated and nothing is silent by mistake.</Notice></Card>;
  const stale = report.generatedAt ? now - Date.parse(report.generatedAt) > 30 * 60_000 : true;
  return <>
    <Card title="Alerts" subtitle={`${report.active.length ? `${report.active.length} active` : 'Nothing active'} · evaluated ${report.generatedAt ? fmtDate(report.generatedAt, tz) : 'never'}${stale ? ' · stale' : ''}`} aria-label="Active alert conditions">
      {stale ? <Notice tone="warn" role="status">The last evaluation is older than 30 minutes; current conditions are unknown until the alerts process runs again.</Notice> : null}
      {report.conditions.length ? <ul className="alert-list" aria-label="Conditions">{report.conditions.map(c => <li className={`alert-row alert-row--${c.state}`} key={c.key}>
        <Pill tone={tone[c.state]} dot>{c.state === 'ok' ? 'ok' : c.state === 'warn' ? 'warning' : 'critical'}</Pill>
        <div className="alert-row__text"><span className="alert-row__title">{c.title}</span><span className="t-small">{c.message}</span></div>
        <span className="alert-row__meta mono-faint">{group(c.key)} · {c.severity}{c.since ? ` · ${countdown(c.since, now).replace(/ left$/, ' ahead')}` : ''}</span>
      </li>)}</ul> : <p className="t-small">No rules evaluated.</p>}
    </Card>
    <Card title="Recent events" subtitle="Each notification sent: raised, escalated, eased or recovered. History is append-only on the collector host.">
      <Table columns={eventColumns} rows={report.events} rowKey={e => `${e.at}:${e.key}:${e.kind}`} empty="No notifications yet." renderCell={(e, column) => {
        switch (column.key) {
          case 'at': return fmtDate(e.at, tz);
          case 'kind': return <Pill tone={eventTone[e.kind]}>{e.kind}</Pill>;
          case 'what': return <Cell main={e.title} sub={e.message} />;
        }
      }} />
    </Card>
  </>;
}
