'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BillingSnapshot } from '@/lib/billing';
import type { UsageResponseBody } from '@/lib/usage-service';
import { DEFAULT_TZ, fmtDate, fmtMoney, fmtPct, fmtTokens } from './format';
import { Metric } from './ui';
import { UsageCard, usageEvidence } from './UsageCard';
import { combinedOverview } from '@/lib/usage';
import { BillingSection } from './BillingSection';
import { AccountOverview } from './AccountOverview';
import { RoutingSection } from './RoutingSection';

const AUTO_REFRESH_MS = 60_000;

type StatusTone = '' | 'ok' | 'warn' | 'danger';

export function Dashboard() {
  const [usage, setUsage] = useState<UsageResponseBody | null>(null);
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: StatusTone }>({ text: 'Loading live usage…', tone: '' });
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(0);

  const nextRefreshAt = useRef(0);
  const refreshingRef = useRef(false);

  const tz = usage?.timezone || DEFAULT_TZ;

  const refresh = useCallback(async (force: boolean) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setStatus({ text: 'Refreshing provider quotas…', tone: '' });
    const billingRefresh = (async () => {
      // Start billing immediately, independently of provider quota latency.
      try {
        const bres = await fetch('/api/billing', { cache: 'no-store' });
        setBilling((await bres.json()) as BillingSnapshot);
      } catch (error) {
        setBilling({
          ok: false,
          generatedAt: new Date().toISOString(),
          source: '/api/billing',
          month: null,
          summary: { monthlyFixedUsd: null, paymentsThisMonthUsd: null, meteredSpendTodayUsd: null },
          lights: [],
          balances: [],
          subscriptions: [],
          oauthHealth: [],
          upstreamUsage: [],
          payments: [],
          diagnostics: [{ level: 'danger', message: `Billing API error: ${msg(error)}`, source: 'billing-fetch' }],
        });
      }
    })();
    try {
      const res = await fetch(`/api/usage${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const data = (await res.json()) as UsageResponseBody;
      setUsage(data);
      const ok = data.accounts.filter((a) => a.ok).length;
      const total = data.accounts.length;
      setStatus({
        text: `${ok}/${total} provider cards loaded · generated ${fmtDate(data.generatedAt, data.timezone)}`,
        tone: ok === total ? 'ok' : ok ? 'warn' : 'danger',
      });
      nextRefreshAt.current = Date.now() + AUTO_REFRESH_MS;
    } catch (error) {
      setStatus({ text: `Dashboard API error: ${msg(error)}`, tone: 'danger' });
      nextRefreshAt.current = Date.now() + AUTO_REFRESH_MS;
    } finally {
      await billingRefresh;
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setNow(Date.now());
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (nextRefreshAt.current && t >= nextRefreshAt.current && !refreshingRef.current) {
        void refresh(true);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [refresh]);

  const secondsLeft = nextRefreshAt.current && now ? Math.max(0, Math.ceil((nextRefreshAt.current - now) / 1000)) : 60;
  const freshAccounts = usage?.accounts.filter((account) => usageEvidence(account, now).state === 'fresh');
  const c = freshAccounts ? combinedOverview(freshAccounts) : undefined;
  const declaredCardCount = usage?.accounts.length ?? 0;

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Accounts · usage · routing</p>
          <h1>AI usage + billing</h1>
          <p className="muted">Monthly payments, account coverage and the models serving your requests.</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => refresh(true)} disabled={refreshing}>
            Refresh now
          </button>
          <div className="countdown">Auto-refresh in {secondsLeft}s</div>
        </div>
      </header>

      {/* Only surfaces when something needs attention: a green "6/6 loaded" line
          every 60s is noise, but a partial load or an API error must not be
          silent — the provider-cards tile alone would not show a fetch failure. */}
      {status.tone === 'warn' || status.tone === 'danger' ? (
        <section className={`status ${status.tone}`} aria-live="polite">
          {status.text}
        </section>
      ) : null}

      <AccountOverview tz={tz} />
      <RoutingSection tz={tz} />

      {c ? (
        <section className="overview" aria-label="Combined overview">
          <Metric tone="live" label="Live provider cards" value={`${c.okAccounts}/${declaredCardCount}`} note="Fresh successful provider observations" />
          <Metric tone="live" label="Coding available" value={`${c.availableProviders}/${declaredCardCount}`} note="Fresh observations reporting availability" />
          <Metric tone="claude" label="Avg Claude session" value={fmtPct(c.averageSessionUtilization)} note="Claude-only session utilization" />
          <Metric tone="claude" label="Avg Claude weekly-all" value={fmtPct(c.averageWeeklyAllUtilization)} note="Claude-only weekly all-model utilization" />
          <Metric tone="codex" label="Avg Codex usage" value={fmtPct(c.averageCodexUtilization)} note="Codex WHAM primary-window utilization" />
          <Metric tone="cursor" label="Avg Cursor usage" value={fmtPct(c.averageCursorUtilization)} note="Cursor subscription utilization" />
          <Metric tone="billing" label="Fixed subs" value={fmtMoney(billing?.summary.monthlyFixedUsd ?? null)} note="Subscription schedule, not proof of payment" />
          <Metric tone="billing" label="Tokens today" value={fmtTokens(billing?.ledger?.tokensTotal ?? null)} note="Observed proxy and direct usage" />
          <Metric tone="billing" label="If billed by API" value={fmtMoney(billing?.ledger?.apiEquivalentUsd ?? null)} note="List price for today's tokens" />
          <Metric tone="billing" label="Estimated marginal" value={fmtMoney(billing?.ledger?.marginalUsd ?? null)} note="Token-price estimate, not a payment" />
        </section>
      ) : null}

      <section className="panel-section">
        <h2>Usage accounts</h2>
        <div className="grid" aria-label="Provider usage cards">
          {usage?.accounts.map((result) => (
            <UsageCard key={result.account.key} result={result} now={now} tz={tz} onAuthorized={() => refresh(true)} />
          ))}
        </div>
      </section>

      <BillingSection data={billing ?? undefined} tz={tz} />

      <details className="diagnostics">
        <summary>Diagnostics</summary>
        <pre>{diagnosticsJson(usage, billing)}</pre>
      </details>

      <footer>
        <span>Provider health is counted directly; Claude percentages stay Claude-only.</span>
        <span>{usage ? `Last refresh: ${fmtDate(usage.generatedAt, tz)}` : 'Never updated'}</span>
      </footer>
    </main>
  );
}

function diagnosticsJson(usage: UsageResponseBody | null, billing: BillingSnapshot | null): string {
  if (!usage) return 'Loading…';
  return JSON.stringify(
    {
      generatedAt: usage.generatedAt,
      apiShape: usage.apiShape,
      accounts: usage.accounts.map((a) => ({
        account: a.account,
        ok: a.ok,
        status: a.status,
        error: a.error,
        fetchedAt: a.fetchedAt,
        sourceUrl: a.sourceUrl,
      })),
      billing,
    },
    null,
    2,
  );
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
