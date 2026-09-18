'use client';

import { Fragment, type ReactNode } from 'react';
import type { BillingLedger, BillingSnapshot } from '@/lib/billing';
import { fmtDate, fmtMoney, fmtNumber, fmtTokens } from './format';
import { Metric, Sparkline, StatusPill } from './legacy-ui';

function LedgerTables({ ledger }: { ledger: BillingLedger }) {
  const rows = (groups: BillingLedger['byClient']) =>
    groups.map((g) => [g.name, fmtTokens(g.tokens), String(g.requests), fmtMoney(g.apiEquivalentUsd), fmtMoney(g.marginalUsd)]);
  const unpriced = Object.entries(ledger.unpriced);
  return (
    <Fragment>
      <Table
        title={`Token estimates today — by client (${ledger.requests} requests, ${ledger.failed} failed)`}
        heads={['Client', 'Tokens', 'Req', 'If billed by API', 'Marginal estimate']}
        rows={rows(ledger.byClient)}
      />
      <Table
        title="Token estimates today — by model"
        heads={['Model', 'Tokens', 'Req', 'If billed by API', 'Marginal estimate']}
        rows={rows(ledger.byModel)}
      />
      <Table
        title="Token mix today"
        heads={['Kind', 'Tokens']}
        rows={[
          ['Input (uncached)', fmtTokens(ledger.tokens.inUncached)],
          ['Cache read', fmtTokens(ledger.tokens.cacheRead)],
          ['Cache write', fmtTokens(ledger.tokens.cacheWrite)],
          ['Output', fmtTokens(ledger.tokens.outTotal)],
        ]}
      />
      {unpriced.length ? (
        <Table
          title="Unpriced models — tokens counted, cost unknown"
          heads={['Model', 'Tokens']}
          rows={unpriced.map(([m, t]) => [m, fmtTokens(t)])}
        />
      ) : null}
    </Fragment>
  );
}

function Table({ title, heads, rows, body }: { title: string; heads: string[]; rows?: ReactNode[][]; body?: ReactNode }) {
  return (
    <section className="bill-section">
      <h2>{title}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {heads.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body
              ? body
              : rows && rows.length
                ? rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className={ci > 1 ? 'r' : ''}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))
                : (
                  <tr>
                    <td colSpan={heads.length} className="muted">
                      No data.
                    </td>
                  </tr>
                )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function BillingSection({ data, tz }: { data?: BillingSnapshot; tz: string }) {
  if (!data) {
    return (
      <section className="billing">
        <div className="bill-section">
          <h2>Billing</h2>
          <p className="muted">Billing data unavailable in API response.</p>
        </div>
      </section>
    );
  }

  const diagBody =
    data.diagnostics.length ? (
      data.diagnostics.map((d, i) => (
        <tr key={i}>
          <td>
            <span className={`dot ${d.level}`} /> {d.level}
          </td>
          <td>{d.message}</td>
          <td className="muted">{d.source || ''}</td>
        </tr>
      ))
    ) : (
      <tr>
        <td colSpan={3} className="muted">
          No diagnostics.
        </td>
      </tr>
    );

  return (
    <section className="billing" aria-label="Billing dashboard">
      <div className="bill-head">
        <div>
          <h2>Billing month {data.month || 'n/a'}</h2>
          <p className="muted">Snapshot source · generated {fmtDate(data.generatedAt, tz)}</p>
        </div>
        <div className="lights">
          {data.lights.map((l, i) => (
            <span className="item" key={i}>
              <span className={`dot ${l.state}`} />
              {l.label}
              {l.value ? ` ${l.value}` : ''}
            </span>
          ))}
        </div>
      </div>

      <section className="bill-grid mini">
        <Metric label="Monthly fixed subscriptions" value={fmtMoney(data.summary.monthlyFixedUsd)} note="Scheduled cost, not proof of payment" />
        <Metric label="Payments logged this month" value={fmtMoney(data.summary.paymentsThisMonthUsd)} note="Payments log" />
        <Metric label="If billed by API today" value={fmtMoney(data.ledger?.apiEquivalentUsd ?? null)} note="List price for today's tokens" />
        <Metric label="Estimated marginal cost today" value={fmtMoney(data.ledger?.marginalUsd ?? null)} note="Token-price calculation, not provider charges" />
        <div className="metric">
          <div className="label">API-equivalent, daily</div>
          <div>
            {data.ledger?.trend.every((point) => point.apiEquivalentUsd !== null) ? <Sparkline values={data.ledger.trend.map((point) => point.apiEquivalentUsd as number)} /> : <span className="muted">Incomplete pricing history</span>}
          </div>
          <div className="muted">
            {data.ledger ? `${data.ledger.trend.length}d of ledger history` : 'ledger unavailable'}
          </div>
        </div>
      </section>

      {data.ledger ? <LedgerTables ledger={data.ledger} /> : null}

      <Table
        title="Balances"
        heads={['Provider', 'Now', '30d']}
        rows={data.balances.map((b) => [b.provider, fmtMoney(b.balanceUsd), <Sparkline key="s" values={b.sparkline} />])}
      />
      <Table
        title="Provider subscriptions"
        heads={['Provider', 'Plan', '$/mo', 'Verified']}
        rows={data.subscriptions.map((s) => [s.provider, s.plan, fmtMoney(s.monthlyUsd), s.verified || ''])}
      />
      <Table
        title="OAuth health"
        heads={['Provider', 'Account', 'Status', 'ok today', 'failed']}
        rows={data.oauthHealth.map((o) => [o.provider, o.account, <StatusPill key="p" status={o.status} />, fmtNumber(o.okToday), fmtNumber(o.failed)])}
      />
      <Table
        title="Upstream usage"
        heads={['Backend', 'Tokens', 'Est. $', 'Pricing']}
        rows={data.upstreamUsage.map((u) => [u.backend, fmtNumber(u.tokens), fmtMoney(u.estimatedUsd), u.pricing])}
      />
      <Table
        title="Payments"
        heads={['Date', 'Provider', 'Amount', 'Kind', 'Note']}
        rows={data.payments.map((p) => [p.date, p.provider, fmtMoney(p.amountUsd), p.kind || '', p.note || ''])}
      />
      <Table title="Diagnostics" heads={['Level', 'Message', 'Source']} body={diagBody} />
    </section>
  );
}
