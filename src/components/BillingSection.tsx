'use client';

import { Fragment, type ReactNode } from 'react';
import type { BillingLedger, BillingSnapshot } from '@/lib/billing';
import { fmtDate, fmtMoney, fmtNumber, fmtTokens } from './format';
import { Pill, Sparkline, StatTile, Table, TileGrid, toneOf, type Column } from './ui';

type Cells = ReactNode[];

/** Titled table whose rows are plain cell arrays; columns after the second are right-aligned like the legacy ledger tables. */
function BillingTable({ title, heads, rows, mono = [] }: { title: string; heads: string[]; rows: Cells[]; mono?: number[] }) {
  const columns: Column[] = heads.map((label, index) => ({ key: String(index), label, align: index > 1 ? 'right' : 'left', mono: mono.includes(index) }));
  return (
    <div className="table-section">
      <h3 className="t-h3">{title}</h3>
      <Table columns={columns} rows={rows} rowKey={(_, index) => String(index)} renderCell={(row, column) => row[Number(column.key)]} empty="No data." />
    </div>
  );
}

function LedgerTables({ ledger }: { ledger: BillingLedger }) {
  const rows = (groups: BillingLedger['byClient']): Cells[] =>
    groups.map((g) => [g.name, fmtTokens(g.tokens), String(g.requests), fmtMoney(g.apiEquivalentUsd), fmtMoney(g.marginalUsd)]);
  const unpriced = Object.entries(ledger.unpriced);
  return (
    <Fragment>
      <BillingTable title={`Token estimates today — by client (${ledger.requests} requests, ${ledger.failed} failed)`} heads={['Client', 'Tokens', 'Req', 'If billed by API', 'Marginal estimate']} rows={rows(ledger.byClient)} mono={[1, 2, 3, 4]} />
      <BillingTable title="Token estimates today — by model" heads={['Model', 'Tokens', 'Req', 'If billed by API', 'Marginal estimate']} rows={rows(ledger.byModel)} mono={[1, 2, 3, 4]} />
      <BillingTable title="Token mix today" heads={['Kind', 'Tokens']} rows={[
        ['Input (uncached)', fmtTokens(ledger.tokens.inUncached)],
        ['Cache read', fmtTokens(ledger.tokens.cacheRead)],
        ['Cache write', fmtTokens(ledger.tokens.cacheWrite)],
        ['Output', fmtTokens(ledger.tokens.outTotal)],
      ]} mono={[1]} />
      {unpriced.length ? <BillingTable title="Unpriced models — tokens counted, cost unknown" heads={['Model', 'Tokens']} rows={unpriced.map(([m, t]) => [m, fmtTokens(t)])} mono={[1]} /> : null}
    </Fragment>
  );
}

export function BillingSection({ data, tz }: { data?: BillingSnapshot; tz: string }) {
  if (!data) {
    return (
      <section className="table-section" aria-label="Billing dashboard">
        <h3 className="t-h3">Billing</h3>
        <p className="t-small">Billing data unavailable in API response.</p>
      </section>
    );
  }
  const trendComplete = data.ledger?.trend.every((point) => point.apiEquivalentUsd !== null);
  return (
    <section className="stack stack--loose" aria-label="Billing dashboard" style={{ gap: 24 }}>
      <div className="section-head">
        <div className="section-head__text"><h2 className="t-h1">Billing month {data.month || 'n/a'}</h2><span className="t-small">Snapshot source · generated {fmtDate(data.generatedAt, tz)}</span></div>
        <div className="lights">{data.lights.map((l, i) => <Pill key={i} tone={toneOf(l.state)} dot>{l.label}{l.value ? ` ${l.value}` : ''}</Pill>)}</div>
      </div>
      <TileGrid minWidth={200}>
        <StatTile label="Monthly fixed subscriptions" value={fmtMoney(data.summary.monthlyFixedUsd)} note="Scheduled cost, not proof of payment" />
        <StatTile label="Payments logged this month" value={fmtMoney(data.summary.paymentsThisMonthUsd)} note="Payments log" />
        <StatTile label="If billed by API today" value={fmtMoney(data.ledger?.apiEquivalentUsd ?? null)} note="List price for today's tokens" />
        <StatTile label="Estimated marginal cost today" value={fmtMoney(data.ledger?.marginalUsd ?? null)} note="Token-price calculation, not provider charges" />
        <StatTile label="API-equivalent, daily" value={data.ledger && trendComplete ? <Sparkline values={data.ledger.trend.map((point) => point.apiEquivalentUsd as number)} /> : <span className="t-small">Incomplete pricing history</span>} note={data.ledger ? `${data.ledger.trend.length}d of ledger history` : 'ledger unavailable'} />
      </TileGrid>

      {data.ledger ? <LedgerTables ledger={data.ledger} /> : null}

      <BillingTable title="Balances" heads={['Provider', 'Now', '30d']} rows={data.balances.map((b) => [b.provider, fmtMoney(b.balanceUsd), <Sparkline key="s" values={b.sparkline} />])} mono={[1]} />
      <BillingTable title="Provider subscriptions" heads={['Provider', 'Plan', '$/mo', 'Verified']} rows={data.subscriptions.map((s) => [s.provider, s.plan, fmtMoney(s.monthlyUsd), s.verified || ''])} mono={[2]} />
      <BillingTable title="OAuth health" heads={['Provider', 'Account', 'Status', 'ok today', 'failed']} rows={data.oauthHealth.map((o) => [o.provider, o.account, <Pill key="p" tone={toneOf(o.status) ?? 'warn'}>{o.status || 'unknown'}</Pill>, fmtNumber(o.okToday), fmtNumber(o.failed)])} mono={[3, 4]} />
      <BillingTable title="Upstream usage" heads={['Backend', 'Tokens', 'Est. $', 'Pricing']} rows={data.upstreamUsage.map((u) => [u.backend, fmtNumber(u.tokens), fmtMoney(u.estimatedUsd), u.pricing])} mono={[1, 2]} />
      <BillingTable title="Payments" heads={['Date', 'Provider', 'Amount', 'Kind', 'Note']} rows={data.payments.map((p) => [p.date, p.provider, fmtMoney(p.amountUsd), p.kind || '', p.note || ''])} mono={[0, 2]} />
      <BillingTable title="Diagnostics" heads={['Level', 'Message', 'Source']} rows={data.diagnostics.map((d) => [<Pill key="l" tone={d.level === 'warn' ? 'warn' : d.level === 'danger' ? 'bad' : 'info'}>{d.level}</Pill>, d.message, <span key="s" className="t-small">{d.source || ''}</span>])} />
    </section>
  );
}
