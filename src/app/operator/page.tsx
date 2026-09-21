import { getDb } from '@/lib/db';
import { isOperator, operatorOverview, type OperatorTenantRow } from '@/lib/operator';
import { isDenied, resolveTenant } from '@/lib/tenant';
import { ForbiddenNotice } from '@/components/ForbiddenNotice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const age = (iso: string | null, now: number) => { if (!iso) return 'never'; const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const tone = (row: OperatorTenantRow, now: number) => !row.lastReceivedAt ? 'bad' : now - Date.parse(row.lastReceivedAt) > 600_000 ? 'warn' : row.sources.some(source => !source.ok) ? 'warn' : 'ok';

/** Operator screen: one row per tenant. Read under the operator context, so it needs the operator address, not a tenant's membership. */
export default async function OperatorPage() {
  const tenant = await resolveTenant();
  if (isDenied(tenant)) return <ForbiddenNotice email={tenant.email} />;
  if (!isOperator(tenant)) return <ForbiddenNotice email={tenant.email} />;
  const db = getDb();
  if (!db) return <main className="auth-page"><p className="auth-page__lead">No database configured — this instance is its only tenant.</p></main>;
  const overview = await operatorOverview(db);
  const now = Date.parse(overview.generatedAt);
  return <main style={{ padding: '24px', maxWidth: 1100, margin: '0 auto' }}>
    <h1 className="t-h2">Tenants</h1>
    <p className="t-small">{overview.tenants.length} tenant{overview.tenants.length === 1 ? '' : 's'} · as of {new Date(overview.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</p>
    <div className="hero-grid">
      {overview.tenants.map(row => <article key={row.id} className={`bf-card hero-card${tone(row, now) === 'ok' ? '' : ` hero-card--${tone(row, now)}`}`} aria-label={`${row.slug} tenant`}>
        <div className="hero-card__head"><div className="hero-card__id"><span className="hero-card__label">{row.name}</span><span className="hero-card__email">{row.slug}</span></div>
          <span className={`bf-pill bf-pill--${tone(row, now) === 'ok' ? 'idle' : tone(row, now)}`}>{row.lastReceivedAt ? `ingest ${age(row.lastReceivedAt, now)}` : 'no ingest yet'}</span></div>
        <div className="hero-card__body"><span className="t-small">{row.members} member{row.members === 1 ? '' : 's'} · {row.liveTokens} live token{row.liveTokens === 1 ? '' : 's'} · {row.snapshots} snapshot{row.snapshots === 1 ? '' : 's'} kept</span>
          <ul className="hero-windows" aria-label="Latest quota observations">{row.sources.map(source => <li key={`${source.provider}:${source.accountKey}`} className={`hero-window${source.ok ? '' : ' hero-window--bad'}`}>
            <span className="hero-window__label">{source.provider} · {source.accountKey}</span>
            <span className="hero-window__value">{source.ok ? (source.source === 'direct' ? 'ok' : `ok via ${source.source}`) : `failed${source.status ? ` (HTTP ${source.status})` : ''}`} · observed {age(source.observedAt, now)}</span>
            {source.error ? <span className="hero-window__reset">{source.error}</span> : null}
          </li>)}</ul></div>
      </article>)}
    </div>
  </main>;
}
