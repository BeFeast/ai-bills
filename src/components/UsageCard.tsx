'use client';

import { Fragment, type ReactNode } from 'react';
import {
  activeSession,
  activeWeeklyAll,
  claudeLimitByKind,
  codexPrimaryWindow,
  codexWindowDurationLabel,
  codexWindowResetIso,
  cursorCreditPercent,
  cursorCycleEnd,
  cursorLegacyPercent,
  cursorTierLabel,
  cursorUsagePercent,
  deriveCodexAvailability,
  deriveCursorAvailability,
  deriveKimiAvailability,
  deriveModelAvailability,
  detectCursorBillingModel,
  detectCursorTier,
  kimiCodingUsage,
  kimiUsagePercent,
  kimiWindow,
  scopeLabel,
  severityClass,
  type ClaudeLimitEntry,
  type ClaudeLimitWindow,
  type ClaudeUsagePayload,
  type CodexAdditionalRateLimit,
  type CodexUsagePayload,
  type CursorSpending,
  type CursorUsagePayload,
  type KimiQuotaDetail,
  type KimiUsagePayload,
  type ProviderUsage,
} from '@/lib/usage';
import { fmtDate, fmtNumber, normalizePct, pickPct, resetLabel } from './format';
import { AvailabilityPill, LiveBadge, Tip, UsageBlock, type Severity } from './ui';
import { CodexAuthBox, useCodexAuth } from './CodexAuth';

type CardProps = { result: ProviderUsage; now: number; tz: string; onAuthorized: () => void };

function cardClass(result: ProviderUsage, state: string): string {
  return `card ${state} provider-${result.account.provider}`;
}

export function UsageCard(props: CardProps) {
  switch (props.result.account.provider) {
    case 'kimi':
      return <KimiCard {...props} />;
    case 'codex':
      return <CodexCard {...props} />;
    case 'cursor':
      return <CursorCard {...props} />;
    default:
      return <ClaudeCard {...props} />;
  }
}

/** Two-part eyebrow. The new config has no cdpName; the account key stands in. */
function CardHead({ result, eyebrow, title, availability, actions }: {
  result: ProviderUsage;
  eyebrow: string;
  title: ReactNode;
  availability: { tone: string; label: string; detail: string };
  actions?: ReactNode;
}) {
  return (
    <div className="card-head">
      <div className="card-title">
        <p className="eyebrow">{eyebrow}</p>
        <div className="account-line">
          <h2>{title}</h2>
        </div>
        <AvailabilityPill tone={availability.tone} label={availability.label} detail={availability.detail} />
      </div>
      {actions ?? <LiveBadge ok={result.ok} />}
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <div className="meta">{children}</div>;
}

function ErrorLine({ result, fallback }: { result: ProviderUsage; fallback: string }) {
  if (result.ok) return null;
  return <p className="error">{result.error || fallback}</p>;
}

// ---------------------------------------------------------------- Claude

function ClaudeBadges({ limit, state }: { limit?: ClaudeLimitEntry; state: Severity }) {
  const status =
    typeof limit?.is_active === 'boolean' ? (
      limit.is_active ? (
        <Tip cls="limiting" label="Currently limiting" note="This limit is currently constraining Claude usage for this account/scope." />
      ) : (
        <Tip
          cls="reported"
          label="Reported, not currently limiting"
          note="Claude still reports this scoped limit. is_active=false means it is not the current limiter; it does not mean the model is absent or disabled."
        />
      )
    ) : null;
  return (
    <div className="badges badges-inline">
      {status}
      <Tip
        cls={state}
        label={`Severity: ${limit?.severity || state}`}
        note="API severity for this limit. Critical/danger means usage is near or at the cap; warn means elevated; ok means normal."
      />
    </div>
  );
}

function ClaudeUsageBlock({ label, pct, reset, windowData, limit, now, tz }: {
  label: string;
  pct: number | null;
  reset?: string | null;
  windowData?: ClaudeLimitWindow | null;
  limit?: ClaudeLimitEntry;
  now: number;
  tz: string;
}) {
  const state = severityClass(pct, limit?.severity);
  return (
    <UsageBlock state={state} label={label} pct={pct} right={<ClaudeBadges limit={limit} state={state} />}>
      <span>Reset</span>
      <strong>{resetLabel(reset, now, tz)}</strong>
      {typeof windowData?.remaining_dollars === 'number' ? (
        <>
          <span>Remaining</span>
          <strong>${windowData.remaining_dollars.toFixed(2)}</strong>
        </>
      ) : null}
      {typeof windowData?.used_dollars === 'number' && typeof windowData?.limit_dollars === 'number' ? (
        <>
          <span>Dollars</span>
          <strong>
            ${windowData.used_dollars.toFixed(2)} / ${windowData.limit_dollars.toFixed(2)}
          </strong>
        </>
      ) : null}
    </UsageBlock>
  );
}

function SpendAccordion({ spend }: { spend: unknown }) {
  const entries =
    spend && typeof spend === 'object'
      ? Object.entries(spend as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined).slice(0, 10)
      : [];
  return (
    <details className="subsection accordion spend-accordion">
      <summary>
        <span>Spend / credits</span>
        <span className="accordion-hint">collapsed by default</span>
      </summary>
      {entries.length ? (
        <div className="kv">
          {entries.map(([k, v]) => (
            <Fragment key={k}>
              <span>{k}</span>
              <strong>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</strong>
            </Fragment>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ padding: '12px 13px' }}>
          No spend object returned.
        </p>
      )}
    </details>
  );
}

function ClaudeCard({ result, now, tz }: CardProps) {
  const d = (result.data as ClaudeUsagePayload | undefined) || {};
  const sessionLimit = claudeLimitByKind(d, 'session') ?? activeSession(d);
  const weeklyLimit = claudeLimitByKind(d, 'weekly_all') ?? activeWeeklyAll(d);
  // Prefer five_hour / seven_day windows (what Claude's own UI shows); fall back to limits[].
  const sessionPct = pickPct(d.five_hour?.utilization, sessionLimit?.percent);
  const weeklyPct = pickPct(d.seven_day?.utilization, weeklyLimit?.percent);
  const scoped = (d.limits || []).filter((l) => l?.kind === 'weekly_scoped');
  const availability = deriveModelAvailability(d);
  const cardState = result.ok
    ? severityClass(Math.max(sessionPct ?? 0, weeklyPct ?? 0), sessionLimit?.severity || weeklyLimit?.severity)
    : 'danger';

  return (
    <article className={cardClass(result, cardState)}>
      <CardHead
        result={result}
        eyebrow={`${result.account.label} · ${result.account.key}`}
        title={result.account.email}
        availability={availability}
      />
      <ErrorLine result={result} fallback="Unknown error" />
      <ClaudeUsageBlock
        label="Current session"
        pct={sessionPct}
        reset={d.five_hour?.resets_at || sessionLimit?.resets_at}
        windowData={d.five_hour}
        limit={sessionLimit}
        now={now}
        tz={tz}
      />
      <ClaudeUsageBlock
        label="Weekly all models"
        pct={weeklyPct}
        reset={d.seven_day?.resets_at || weeklyLimit?.resets_at}
        windowData={d.seven_day}
        limit={weeklyLimit}
        now={now}
        tz={tz}
      />
      <section className="subsection">
        <h3>Scoped model limits</h3>
        {scoped.length ? (
          scoped.map((limit, i) => (
            <ClaudeUsageBlock
              key={i}
              label={scopeLabel(limit)}
              pct={normalizePct(limit.percent)}
              reset={limit.resets_at}
              windowData={null}
              limit={limit}
              now={now}
              tz={tz}
            />
          ))
        ) : (
          <p className="muted">No scoped model limit returned.</p>
        )}
      </section>
      <SpendAccordion spend={d.spend} />
      <Meta>
        HTTP {result.status ?? 'n/a'} · fetched {fmtDate(result.fetchedAt, tz)}
      </Meta>
    </article>
  );
}

// ---------------------------------------------------------------- Kimi

function KimiUsageBlock({ label, detail, pct, reset, note, now, tz }: {
  label: string;
  detail: KimiQuotaDetail | null;
  pct: number | null;
  reset?: string | null;
  note: string;
  now: number;
  tz: string;
}) {
  const state = severityClass(pct);
  return (
    <UsageBlock
      state={state}
      label={label}
      pct={pct}
      right={<Tip cls={state} label={pct !== null && pct >= 90 ? 'Near limit' : 'Quota state'} note={note} />}
    >
      <span>Used / limit</span>
      <strong>
        {fmtNumber(detail?.used)} / {fmtNumber(detail?.limit)}
      </strong>
      <span>Remaining</span>
      <strong>{fmtNumber(detail?.remaining)}</strong>
      <span>Reset</span>
      <strong>{resetLabel(reset, now, tz)}</strong>
    </UsageBlock>
  );
}

function KimiCard({ result, now, tz }: CardProps) {
  const data = result.data as KimiUsagePayload | undefined;
  const coding = kimiCodingUsage(data);
  const overall = coding?.detail ?? null;
  const window300 = kimiWindow(data, 300, 'TIME_UNIT_MINUTE');
  const availability = deriveKimiAvailability(data);
  const overallPct = kimiUsagePercent(overall);
  const windowPct = kimiUsagePercent(window300?.detail ?? null);
  const cardState = result.ok ? severityClass(Math.max(overallPct ?? 0, windowPct ?? 0)) : 'danger';

  return (
    <article className={cardClass(result, cardState)}>
      <CardHead
        result={result}
        eyebrow={`${result.account.label} · ${result.account.key}`}
        title={`Kimi Code · ${result.account.email}`}
        availability={availability}
      />
      <ErrorLine result={result} fallback="Unknown error" />
      <KimiUsageBlock
        label="Overall coding quota"
        detail={overall}
        pct={overallPct}
        reset={overall?.resetTime}
        note={`Scope: ${coding?.scope || 'n/a'}`}
        now={now}
        tz={tz}
      />
      <KimiUsageBlock
        label="300-minute window"
        detail={window300?.detail ?? null}
        pct={windowPct}
        reset={window300?.detail.resetTime}
        note="Rolling TIME_UNIT_MINUTE window"
        now={now}
        tz={tz}
      />
      <section className="subsection">
        <h3>Quota summary</h3>
        <div className="kv compact">
          <span>Global remaining</span>
          <strong>
            {fmtNumber(overall?.remaining)} / {fmtNumber(overall?.limit)}
          </strong>
          <span>Window remaining</span>
          <strong>
            {fmtNumber(window300?.detail.remaining)} / {fmtNumber(window300?.detail.limit)}
          </strong>
        </div>
      </section>
      <Meta>
        HTTP {result.status ?? 'n/a'} · fetched {fmtDate(result.fetchedAt, tz)}
      </Meta>
    </article>
  );
}

// ---------------------------------------------------------------- Codex

function CodexUsageBlock({ label, pct, resetIso, rl, now, tz }: {
  label: string;
  pct: number | null;
  resetIso: string | null;
  rl?: { allowed?: boolean; limit_reached?: boolean } | null;
  now: number;
  tz: string;
}) {
  const state = severityClass(pct);
  const blocked = rl?.limit_reached === true || rl?.allowed === false;
  return (
    <UsageBlock
      state={state}
      label={label}
      pct={pct}
      right={
        blocked ? (
          <Tip cls="danger" label="Limit reached" note="Rate limit has been reached for this window." />
        ) : (
          <Tip cls={state} label={`${pct ?? 0}% used`} note="Current utilization of the primary rate-limit window." />
        )
      }
    >
      <span>Reset</span>
      <strong>{resetLabel(resetIso, now, tz)}</strong>
      <span>Status</span>
      <strong>{blocked ? 'Blocked' : 'Allowed'}</strong>
    </UsageBlock>
  );
}

function CodexAdditionalLimit({ limit, now, tz }: { limit: CodexAdditionalRateLimit; now: number; tz: string }) {
  const primary = limit.rate_limit?.primary_window;
  const pct = primary?.used_percent ?? null;
  const resetIso = primary?.reset_at ? new Date(primary.reset_at * 1000).toISOString() : null;
  const state = severityClass(pct);
  const blocked = limit.rate_limit?.limit_reached === true || limit.rate_limit?.allowed === false;
  return (
    <UsageBlock
      state={state}
      label={limit.limit_name}
      pct={pct}
      right={
        blocked ? (
          <Tip cls="danger" label="Limit reached" note={`${limit.metered_feature} rate limit reached.`} />
        ) : (
          <Tip cls={state} label={`${pct ?? 0}% used`} note={`Metered feature: ${limit.metered_feature}`} />
        )
      }
    >
      <span>Feature</span>
      <strong>{limit.metered_feature}</strong>
      <span>Reset</span>
      <strong>{resetLabel(resetIso, now, tz)}</strong>
    </UsageBlock>
  );
}

function CodexCreditsAccordion({ data }: { data?: CodexUsagePayload }) {
  if (!data) return null;
  const credits = data.credits;
  const spend = data.spend_control;
  const resetCredits = data.rate_limit_reset_credits;
  return (
    <details className="subsection accordion spend-accordion">
      <summary>
        <span>Credits &amp; spend control</span>
        <span className="accordion-hint">collapsed by default</span>
      </summary>
      <div className="kv">
        <span>Credits balance</span>
        <strong>{credits?.balance ?? '0'}</strong>
        <span>Has credits</span>
        <strong>{credits?.has_credits ? 'Yes' : 'No'}</strong>
        <span>Unlimited</span>
        <strong>{credits?.unlimited ? 'Yes' : 'No'}</strong>
        <span>Overage limit reached</span>
        <strong>{credits?.overage_limit_reached ? 'Yes' : 'No'}</strong>
        <span>Spend control reached</span>
        <strong>{spend?.reached ? 'Yes' : 'No'}</strong>
        <span>Individual limit</span>
        <strong>{spend?.individual_limit ?? 'None'}</strong>
        <span>Reset credits available</span>
        <strong>
          {resetCredits?.available_count ?? 0} (applicable: {resetCredits?.applicable_available_count ?? 0})
        </strong>
      </div>
    </details>
  );
}

function CodexCard({ result, now, tz, onAuthorized }: CardProps) {
  const data = result.data as CodexUsagePayload | undefined;
  const availability = deriveCodexAvailability(data, result.status);
  const primary = codexPrimaryWindow(data);
  const pct = primary?.used_percent ?? null;
  const resetIso = codexWindowResetIso(primary);
  const windowLabel = codexWindowDurationLabel(primary);
  const cardState = result.ok ? severityClass(pct) : 'danger';
  const additionalLimits = data?.additional_rate_limits ?? [];
  const identity = result.account.key;
  const { state: authState, start, starting } = useCodexAuth(identity, onAuthorized);

  return (
    <article className={cardClass(result, cardState)}>
      <CardHead
        result={result}
        eyebrow={`${result.account.label} · WHAM API`}
        title={`Codex · ${data?.email || result.account.email}`}
        availability={availability}
        actions={
          <div className="card-actions">
            <LiveBadge ok={result.ok} />
            <button type="button" className="small-button" onClick={start} disabled={starting}>
              {result.ok ? 'Reconnect' : 'Connect'}
            </button>
          </div>
        }
      />
      <ErrorLine result={result} fallback="WHAM request failed" />
      <CodexAuthBox state={authState} now={now} tz={tz} />
      <CodexUsageBlock label={windowLabel} pct={pct} resetIso={resetIso} rl={data?.rate_limit} now={now} tz={tz} />
      {additionalLimits.map((limit, i) => (
        <CodexAdditionalLimit key={i} limit={limit} now={now} tz={tz} />
      ))}
      <CodexCreditsAccordion data={data} />
      <Meta>
        Plan: {data?.plan_type || 'n/a'} · HTTP {result.status ?? 'n/a'} · fetched {fmtDate(result.fetchedAt, tz)}
      </Meta>
    </article>
  );
}

// ---------------------------------------------------------------- Cursor

function CursorUsageBlock({ label, pct, resetIso, rows, now, tz }: {
  label: string;
  pct: number | null;
  resetIso: string | null;
  rows: [string, string][];
  now: number;
  tz: string;
}) {
  const state = severityClass(pct);
  return (
    <UsageBlock
      state={state}
      label={label}
      pct={pct}
      right={<Tip cls={state} label={pct != null ? `${pct.toFixed(1)}% used` : 'No data'} note="Current utilization of the Cursor usage budget." />}
    >
      <span>Reset</span>
      <strong>{resetLabel(resetIso, now, tz)}</strong>
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span>{k}</span>
          <strong>{v}</strong>
        </Fragment>
      ))}
    </UsageBlock>
  );
}

function CursorSpendingSection({ spending }: { spending?: CursorSpending | null }) {
  if (!spending) return null;
  const cents = (v?: number | null) => (typeof v === 'number' ? `$${(v / 100).toFixed(2)}` : 'n/a');
  const totalDollars = cents(spending.totalCents);
  const budgetDollars = typeof spending.budgetLimitCents === 'number' ? `$${(spending.budgetLimitCents / 100).toFixed(2)}` : 'No limit';
  const enabled = spending.onDemandEnabled;
  const state: Severity = (spending.totalCents ?? 0) > 0 ? 'ok' : 'muted';
  return (
    <section className={`usage ${state}`}>
      <div className="usage-top">
        <h3>Spending</h3>
        <div className="usage-right usage-inline">
          <Tip cls={state} label={`Total: ${totalDollars}`} note="Total spend this billing period (included + on-demand)." />
        </div>
      </div>
      <div className="kv compact">
        <span>Total spend</span>
        <strong>{totalDollars}</strong>
        <span>Included</span>
        <strong>{cents(spending.includedCents)}</strong>
        <span>On-demand</span>
        <strong>{cents(spending.onDemandCents)}</strong>
        <span>On-demand enabled</span>
        <strong>{enabled === true ? 'Yes' : enabled === false ? 'No' : 'n/a'}</strong>
        <span>Budget limit</span>
        <strong>{budgetDollars}</strong>
      </div>
    </section>
  );
}

function CursorCard({ result, now, tz }: CardProps) {
  const data = result.data as CursorUsagePayload | undefined;
  const availability = deriveCursorAvailability(data);
  const billing = data?.billingModel ?? detectCursorBillingModel(data);
  const tier = detectCursorTier(data?.stripe);
  const tierLabel = cursorTierLabel(tier);
  const pct = cursorUsagePercent(data);
  const resetIso = cursorCycleEnd(data);
  const cardState = result.ok ? severityClass(pct) : 'danger';
  const status = (data?.stripe?.subscriptionStatus ?? '').toLowerCase();
  const yearly = data?.stripe?.isYearlyPlan;

  let usageSection: ReactNode;
  if (billing === 'usd_credit' && data?.currentPeriod?.planUsage) {
    const pu = data.currentPeriod.planUsage;
    const creditPct = cursorCreditPercent(data);
    const limitDollars = typeof pu.limit === 'number' ? (pu.limit / 100).toFixed(2) : 'n/a';
    const usedDollars =
      typeof pu.used === 'number'
        ? (pu.used / 100).toFixed(2)
        : typeof pu.limit === 'number' && typeof pu.remaining === 'number'
          ? ((pu.limit - pu.remaining) / 100).toFixed(2)
          : 'n/a';
    const remainDollars = typeof pu.remaining === 'number' ? (pu.remaining / 100).toFixed(2) : 'n/a';
    const rows: [string, string][] = [
      ['Used / limit', `$${usedDollars} / $${limitDollars}`],
      ['Remaining', `$${remainDollars}`],
      ...(pu.autoPercentUsed != null ? ([['Auto usage', `${pu.autoPercentUsed.toFixed(1)}%`]] as [string, string][]) : []),
      ...(pu.apiPercentUsed != null ? ([['API usage', `${pu.apiPercentUsed.toFixed(1)}%`]] as [string, string][]) : []),
    ];
    usageSection = <CursorUsageBlock label="Monthly credit usage" pct={creditPct} resetIso={resetIso} rows={rows} now={now} tz={tz} />;
  } else if (billing === 'request_count' && data?.legacyUsage?.['gpt-4']) {
    const model = data.legacyUsage['gpt-4'];
    const legacyPct = cursorLegacyPercent(data);
    const rows: [string, string][] = [
      ['Requests used', `${model?.numRequests ?? 'n/a'} / ${model?.maxRequestUsage ?? 'n/a'}`],
      [
        'Remaining',
        model?.numRequests != null && model?.maxRequestUsage != null ? `${Math.max(0, model.maxRequestUsage - model.numRequests)}` : 'n/a',
      ],
    ];
    usageSection = <CursorUsageBlock label="Monthly request usage" pct={legacyPct} resetIso={resetIso} rows={rows} now={now} tz={tz} />;
  } else {
    usageSection = <p className="muted">No usage data available. Billing model: {billing}.</p>;
  }

  return (
    <article className={cardClass(result, cardState)}>
      <CardHead
        result={result}
        eyebrow={`${result.account.label} · ${result.account.key}`}
        title={`Cursor · ${result.account.email}`}
        availability={availability}
      />
      <ErrorLine result={result} fallback="Unknown error" />
      {usageSection}
      <CursorSpendingSection spending={data?.spending} />
      <details className="subsection accordion spend-accordion">
        <summary>
          <span>Subscription details</span>
          <span className="accordion-hint">collapsed by default</span>
        </summary>
        <div className="kv">
          <span>Plan</span>
          <strong>
            {tierLabel}
            {yearly ? ' (yearly)' : ''}
          </strong>
          <span>Status</span>
          <strong>{status || 'n/a'}</strong>
          <span>Team member</span>
          <strong>{data?.stripe?.isTeamMember ? 'Yes' : 'No'}</strong>
          {data?.stripe?.pendingCancellationDate ? (
            <>
              <span>Cancels</span>
              <strong>{data.stripe.pendingCancellationDate}</strong>
            </>
          ) : null}
          {typeof data?.stripe?.customerBalance === 'number' && data.stripe.customerBalance < 0 ? (
            <>
              <span>Prepaid balance</span>
              <strong>${(Math.abs(data.stripe.customerBalance) / 100).toFixed(2)}</strong>
            </>
          ) : null}
        </div>
      </details>
      <Meta>
        Billing: {billing} · HTTP {result.status ?? 'n/a'} · fetched {fmtDate(result.fetchedAt, tz)}
      </Meta>
    </article>
  );
}
