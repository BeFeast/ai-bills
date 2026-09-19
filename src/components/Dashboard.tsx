'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BillingSnapshot } from '@/lib/billing';
import type { UsageResponseBody } from '@/lib/usage-service';
import { DEFAULT_TZ, fmtDate } from './format';
import { ProductOverviewPanel } from './ProductOverviewPanel';
import { PRODUCT_ATTRIBUTION, PRODUCT_TAGLINE, ZecoriMark, ZecoriSignature, ZecoriWordmark } from './Brand';
import type { ProductOverview } from '@/lib/overview';
import { UsageCard } from './UsageCard';
import { BillingSection } from './BillingSection';
import { AccountOverview } from './AccountOverview';
import { AlertsSection } from './AlertsSection';
import { UserButton } from '@clerk/nextjs';
import type { AlertsReport } from '@/lib/alerts';
import { RoutingSection } from './RoutingSection';
import type { AccountRegistry } from '@/lib/accounts';
import { AppShell, useTheme } from './shell/AppShell';
import type { SidebarItem } from './shell/Sidebar';
import { ButtonLink, Notice, navIcons, type PillTone } from './ui';
import pkg from '../../package.json';

const AUTO_REFRESH_MS = 60_000;

type StatusTone = '' | 'ok' | 'warn' | 'danger';
type View = 'overview' | 'subscriptions' | 'accounts' | 'usage' | 'alerts' | 'routing' | 'details';

const VIEWS: Record<View, { label: string; subtitle: string }> = {
  overview: { label: 'Overview', subtitle: 'Where you stand against your limits' },
  subscriptions: { label: 'Subscriptions', subtitle: 'What you pay, when it renews, and where to manage it' },
  accounts: { label: 'Accounts & sign-in', subtitle: 'Connect an account, renew access or check its remaining allowance' },
  usage: { label: 'Usage', subtitle: 'Where your usage goes this month' },
  alerts: { label: 'Alerts', subtitle: 'What Zecori would tell you about, and what it already has' },
  routing: { label: 'Models & routing', subtitle: 'Request routing policy and daily allowance' },
  details: { label: 'Accounting details', subtitle: 'Month overview, records and billing snapshot' },
};

const statusTone: Record<StatusTone, PillTone> = { '': 'idle', ok: 'ok', warn: 'warn', danger: 'bad' };

export function Dashboard({ hosted = false }: { hosted?: boolean } = {}) {
  const [view, setView] = useState<View>('overview');
  const [overview, setOverview] = useState<ProductOverview | null>(null);
  const [overviewError, setOverviewError] = useState('');
  const [alerts, setAlerts] = useState<AlertsReport | null>(null);
  const [registry, setRegistry] = useState<AccountRegistry | null>(null);
  const [registryError, setRegistryError] = useState('');
  const [usage, setUsage] = useState<UsageResponseBody | null>(null);
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: StatusTone }>({ text: 'Loading live usage…', tone: '' });
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(0);
  const [theme, toggleTheme] = useTheme();

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
    const registryRefresh = (async () => {
      try {
        const response = await fetch('/api/accounts', { cache: 'no-store' });
        if (!response.ok) throw new Error('Account inventory unavailable');
        setRegistry(await response.json()); setRegistryError('');
      } catch { setRegistryError('Account inventory could not be refreshed; showing the last observed account list.'); }
    })();
    const billingRefresh = (async () => {
      // Start billing immediately, independently of provider quota latency.
      try {
        fetch('/api/alerts', { cache: 'no-store' }).then(async r => { if (r.ok) setAlerts((await r.json()) as AlertsReport); }).catch(() => { /* alerts stay as last seen */ });
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
      nextRefreshAt.current = Date.now() + (data.refreshing ? 3_000 : AUTO_REFRESH_MS);
    } catch (error) {
      setStatus({ text: `Dashboard API error: ${msg(error)}`, tone: 'danger' });
      nextRefreshAt.current = Date.now() + AUTO_REFRESH_MS;
    } finally {
      await Promise.all([billingRefresh, overviewRefresh, registryRefresh]);
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
        void refresh(false);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [refresh]);

  const secondsLeft = nextRefreshAt.current && now ? Math.max(0, Math.ceil((nextRefreshAt.current - now) / 1000)) : 60;
  const activeSubscriptions = overview?.subscriptions.filter((s) => s.status !== 'cancelled' && s.status !== 'expired').length;
  const items = (Object.keys(VIEWS) as View[])
    .filter((id) => id !== 'routing' || overview?.features?.routing === true)
    .map<SidebarItem<View>>((id) => ({
      id,
      label: VIEWS[id].label,
      icon: navIcons[id],
      count: id === 'subscriptions' ? activeSubscriptions : id === 'accounts' ? usage?.accounts.length : id === 'alerts' && alerts?.active.length ? alerts.active.length : undefined,
    }));
  const attention = status.tone === 'warn' || status.tone === 'danger';

  return (
    <AppShell
      brand={{ mark: <ZecoriMark size={32} className="bf-sb__mark" />, name: <ZecoriWordmark height={19} />, sub: <>{PRODUCT_TAGLINE}<br />{PRODUCT_ATTRIBUTION}</> }}
      items={items}
      view={view}
      onView={setView}
      sidebarFooter={<ZecoriSignature version={pkg.version} />}
      title={VIEWS[view].label}
      subtitle={VIEWS[view].subtitle}
      status={{ text: status.text, tone: statusTone[status.tone] }}
      countdown={`Auto-refresh in ${secondsLeft}s`}
      onRefresh={() => void refresh(true)}
      refreshing={refreshing}
      theme={theme}
      onToggleTheme={toggleTheme}
      account={hosted ? <UserButton /> : undefined}
      footerLeft="Plan prices are separate from payments. API equivalent estimates the value of measured usage."
      footerRight={usage ? `Last refresh: ${fmtDate(usage.generatedAt, tz)}` : 'Never updated'}
    >
      {overview && overviewError ? <Notice tone="warn" role="status">{overviewError}. Showing the last loaded overview.</Notice> : null}
      {registryError ? <Notice tone="warn" role="status">{registryError}</Notice> : null}
      {overview?.links?.proxyManagementUrl && view === 'accounts' ? <div className="toolbar"><ButtonLink size="sm" href={overview.links.proxyManagementUrl} target="_blank" rel="noreferrer">CLIProxyAPI ↗</ButtonLink></div> : null}

      {view === 'overview' && alerts?.active.length ? <Notice tone={alerts.active.some(c => c.state === 'bad') ? 'bad' : 'warn'} role="status">{alerts.active.length} alert{alerts.active.length === 1 ? '' : 's'} active: {alerts.active.slice(0, 3).map(c => c.title).join(' · ')}{alerts.active.length > 3 ? ' · …' : ''} <button type="button" className="text-link" onClick={() => setView('alerts')}>Open alerts →</button></Notice> : null}
      {view === 'alerts' ? <AlertsSection report={alerts} now={now} tz={tz} /> : null}
      {view !== 'accounts' && view !== 'alerts' ? <ProductOverviewPanel data={overview} accounts={usage?.accounts ?? []} registry={registry?.accounts ?? []} view={view} onView={setView} error={overviewError} onUpdated={refreshOverview} /> : null}

      {view === 'accounts' ? <>
        {attention ? <Notice tone="warn" role="status">Some quota connections need attention. Use the controls below to reconnect.</Notice> : null}
        {usage?.accounts.map((result) => <UsageCard key={result.account.key} result={result} now={now} tz={tz} onAuthorized={() => refresh(true)} />)}
        {usage && !usage.accounts.length ? <p className="t-small">No provider accounts are configured for automatic quota collection.</p> : null}
        {!usage ? <p className="t-small">Loading account quotas…</p> : null}
        <ProductOverviewPanel data={overview} accounts={usage?.accounts ?? []} registry={registry?.accounts ?? []} view={view} onView={setView} error={overviewError} onUpdated={refreshOverview} />
      </> : null}
      {view === 'routing' ? <RoutingSection tz={tz} /> : null}
      {view === 'details' ? <>
        <AccountOverview tz={tz} />
        <BillingSection data={billing ?? undefined} tz={tz} />
        <details className="bf-card details-card">
          <summary>Diagnostics</summary>
          <pre className="diag-pre">{diagnosticsJson(usage, billing)}</pre>
        </details>
      </> : null}
    </AppShell>
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
