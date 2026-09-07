'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BillingSnapshot } from '@/lib/billing';
import type { UsageResponseBody } from '@/lib/usage-service';
import { DEFAULT_TZ, fmtDate } from './format';
import { ProductOverviewPanel } from './ProductOverviewPanel';
import type { ProductOverview } from '@/lib/overview';
import { UsageCard } from './UsageCard';
import { ProviderIcon } from './ProviderIcon';
import { AccountBrowserAccess } from './AccountBrowserAccess';
import { BillingSection } from './BillingSection';
import { AccountOverview } from './AccountOverview';
import { RoutingSection } from './RoutingSection';

const AUTO_REFRESH_MS = 60_000;

type StatusTone = '' | 'ok' | 'warn' | 'danger';

export function Dashboard() {
  const [view, setView] = useState<'overview' | 'subscriptions' | 'accounts' | 'usage' | 'routing' | 'details'>('overview');
  const [overview, setOverview] = useState<ProductOverview | null>(null);
  const [overviewError, setOverviewError] = useState('');
  const [usage, setUsage] = useState<UsageResponseBody | null>(null);
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: StatusTone }>({ text: 'Loading live usage…', tone: '' });
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(0);

  const nextRefreshAt = useRef(0);
  const refreshingRef = useRef(false);

  const tz = usage?.timezone || DEFAULT_TZ;

  const refreshOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/overview', { cache: 'no-store' });
      if (!res.ok) throw new Error('Subscription overview could not be loaded');
      setOverview(await res.json()); setOverviewError('');
    } catch (error) { setOverviewError(msg(error)); }
  }, []);

  const refresh = useCallback(async (force: boolean) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setStatus({ text: 'Refreshing provider quotas…', tone: '' });
    const overviewRefresh = refreshOverview();
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
      await Promise.all([billingRefresh, overviewRefresh]);
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [refreshOverview]);

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
  return (
    <main className="shell product-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Your AI spending, in one place</p>
          <h1>AI bills</h1>
          <p className="muted">Subscriptions, renewal dates and where your usage goes.</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => refresh(true)} disabled={refreshing}>
            Refresh now
          </button>
          <div className="countdown">Auto-refresh in {secondsLeft}s</div>
        </div>
      </header>

      <nav className="product-nav" aria-label="Dashboard sections">
        {([['overview', 'Overview'], ['subscriptions', 'Subscriptions'], ['accounts', 'Accounts & sign-in'], ['usage', 'Usage'], ['routing', 'Models & routing'], ['details', 'Accounting details']] as const).map(([id, label]) => <button key={id} type="button" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{label}</button>)}
      </nav>

      {overview && overviewError ? <p className="data-note" role="status">{overviewError}. Showing the last loaded overview.</p> : null}
      <ProductOverviewPanel data={overview} accounts={usage?.accounts ?? []} view={view} onView={setView} error={overviewError} onUpdated={refreshOverview} />

      {view === 'accounts' ? <>
        <section className="product-panel">
          <div className="section-heading"><div><h2>Accounts & sign-in</h2><p>Connect an account, renew access or check its remaining allowance.</p></div></div>
          <div className="provider-access">{overview?.subscriptions.filter(s => s.loginUrl || s.accountKeys.length).map(s => <article className="provider-access-card" key={s.id}><div className="provider-identity"><ProviderIcon provider={s.provider} /><div><strong>{s.label}</strong><small>{s.provider}</small></div></div><AccountBrowserAccess subscription={s} /></article>)}</div>
        </section>
        {(status.tone === 'warn' || status.tone === 'danger') ? <p className="data-note" role="status">Some quota connections need attention. Use the controls below to reconnect.</p> : null}
        <div className="grid" aria-label="Provider usage cards">{usage?.accounts.map(result => <UsageCard key={result.account.key} result={result} now={now} tz={tz} onAuthorized={() => refresh(true)} />)}</div>
      </> : null}
      {view === 'routing' ? <RoutingSection tz={tz} /> : null}
      {view === 'details' ? <>
        <AccountOverview tz={tz} />
        <BillingSection data={billing ?? undefined} tz={tz} />
        <details className="diagnostics"><summary>Diagnostics</summary><pre>{diagnosticsJson(usage, billing)}</pre></details>
      </> : null}

      <footer>
        <span>Plan prices are separate from payments. API equivalent estimates the value of measured usage.</span>
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
