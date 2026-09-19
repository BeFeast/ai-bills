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
  quotaTone,
} from '@/lib/usage';
import { fmtDate, fmtNumber, fmtPct, normalizePct, pickPct, refillLabel, resetLabel } from './format';
import { CodexAuthBox, useCodexAuth } from './CodexAuth';
import { ProviderIcon } from './ProviderIcon';
import { AccountBrowserAccess } from './AccountBrowserAccess';
import { Button, ButtonLink, Notice, Pill, type PillTone } from './ui';

type CardProps = { result: ProviderUsage; now: number; tz: string; onAuthorized: () => void };

import { usageEvidence, type UsageEvidence } from '@/lib/usage-evidence';
export { usageEvidence, type UsageEvidence };

const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', cursor: 'Cursor' };
const providerName = (provider: string) => providerNames[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
const availabilityTone = (tone: string): PillTone => (tone === 'danger' ? 'bad' : tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : 'idle');

type Availability = { tone: string; label: string; detail: string };
type KvRows = [string, ReactNode][];

/** One account: header (identity, availability, browser access, reconnect), limit cards, accordions and the mono meta footer. */
function AccountGroup({ result, title, availability, tools, belowHeader, footer, children }: {
  result: ProviderUsage;
  title: ReactNode;
  availability?: Availability;
  tools?: ReactNode;
  belowHeader?: ReactNode;
  footer: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="acct" aria-label={`${result.account.label} · ${result.account.email || 'Email not recorded'}`}>
      <div className="acct__head">
        <ProviderIcon provider={result.account.provider} size={24} />
        <h2 className="t-h3 acct__title">{title}</h2>
        <span className="mono-faint">{result.account.provider}</span>
        {availability ? <Pill tone={availabilityTone(availability.tone)} title={availability.detail}>{availability.label}</Pill> : null}
        <div className="acct__tools">
          <AccountBrowserAccess account={result.account} layout="row" />
          {tools}
        </div>
      </div>
      {belowHeader}
      {!result.ok ? <Notice tone="bad" role="alert">{result.error || 'Unknown error'}</Notice> : null}
      {children}
      <span className="acct__foot">{footer}</span>
    </section>
  );
}

function KvStrip({ rows, flat }: { rows: KvRows; flat?: boolean }) {
  if (!rows.length) return null;
  return <div className={`kv-strip${flat ? ' kv-strip--flat' : ''}`}>{rows.map(([key, value]) => <div key={key}><span>{key}</span><strong>{value}</strong></div>)}</div>;
}

/** T3-style limit row: remaining percent, hatched bar filled to what is left, reset chip, then the block's KV rows. */
function LimitCard({ label, provider, pct, reset, badge, rows, tone, now, tz }: {
  label: string;
  provider: string;
  pct: number | null;
  reset: string | null | undefined;
  badge?: { tone: PillTone; label: string; note: string };
  rows: KvRows;
  tone?: 'warn' | 'bad';
  now: number;
  tz: string;
}) {
  const remaining = pct === null ? null : Math.max(0, Math.min(100, 100 - pct));
  const leftText = remaining === null ? 'n/a' : `${Number(remaining.toFixed(1))}%`;
  const short = refillLabel(reset, now) ?? 'n/a';
  return (
    <div className={`bf-card limit${tone ? ` limit--${tone}` : ''}`}>
      <div className="limit__left">
        <div className="limit__title">
          <h3 className="t-h3">{label}</h3>
          {badge ? <Pill tone={badge.tone} title={badge.note}>{badge.label}</Pill> : null}
        </div>
        <div className="limit__value"><span className="limit__num tabular">{leftText}</span><span className="t-small">left</span></div>
        <span className="limit__reset">{resetLabel(reset, now, tz)}</span>
      </div>
      <div className="limit__bar" role="img" aria-label={`${label}: ${leftText} left`}>
        <div className="limit__fill" style={{ width: `${remaining ?? 0}%` }} />
        <span className="limit__label">{provider}<span className="tabular">{leftText}</span></span>
        {short !== 'n/a' ? <span className="limit__chip">↻ {short}</span> : null}
      </div>
      <KvStrip rows={rows} />
    </div>
  );
}

/** Shared thresholds with the Overview hero: bad when exhausted or under 10 % left, warn under 25 % left. */
function limitTone(pct: number | null, severity?: string | null, blocked?: boolean): 'warn' | 'bad' | undefined {
  const sev = (severity ?? '').toLowerCase();
  const exhausted = Boolean(blocked) || (pct !== null && pct >= 100) || /danger|critical|error/.test(sev);
  return quotaTone(pct === null ? null : 100 - pct, exhausted) ?? (sev.includes('warn') ? 'warn' : undefined);
}

function Accordion({ title, rows, empty }: { title: string; rows: KvRows; empty?: string }) {
  return (
    <details className="details-panel">
      <summary><span>{title}</span><span className="details-hint">collapsed by default</span></summary>
      {rows.length ? <div className="kv">{rows.map(([key, value]) => <Fragment key={key}><span>{key}</span><strong>{value}</strong></Fragment>)}</div> : <p className="t-small">{empty}</p>}
    </details>
  );
}

function KvCard({ title, rows }: { title: string; rows: KvRows }) {
  return <div className="bf-card acct-kv-card"><h3 className="t-h3">{title}</h3><KvStrip rows={rows} flat /></div>;
}

function Meta({ result, tz, prefix }: { result: ProviderUsage; tz: string; prefix?: string }) {
  return <>{prefix}HTTP {result.status ?? 'n/a'} · fetched {fmtDate(result.fetchedAt, tz)}</>;
}

function UnknownCard({ result, tz, evidence }: { result: ProviderUsage; tz: string; evidence: UsageEvidence }) {
  return (
    <div className="bf-card limit limit--unknown">
      <div className="limit__title">
        <h3 className="t-h3">Availability unknown</h3>
        <Pill tone={evidence.state === 'error' ? 'bad' : 'warn'}>{evidence.state === 'stale' ? 'Stale observation' : evidence.state === 'error' ? 'Source error' : 'Unknown'}</Pill>
      </div>
      <span className="t-small">{evidence.message}</span>
      <KvStrip flat rows={[['Quota remaining', 'Unknown'], ['Last observation', fmtDate(result.fetchedAt, tz)], ['HTTP status', result.status ?? 'Unknown']]} />
    </div>
  );
}

export function UsageCard(props: CardProps) {
  const evidence = usageEvidence(props.result, props.now);
  switch (props.result.account.provider) {
    case 'kimi':
      return <KimiCard {...props} evidence={evidence} />;
    case 'codex':
      return <CodexCard {...props} evidence={evidence} />;
    case 'cursor':
      return <CursorCard {...props} evidence={evidence} />;
    default:
      return <ClaudeCard {...props} evidence={evidence} />;
  }
}

type ProviderCardProps = CardProps & { evidence: UsageEvidence };

// ---------------------------------------------------------------- Claude

function claudeRows(limit: ClaudeLimitEntry | undefined, windowData: ClaudeLimitWindow | null | undefined, pct: number | null, reset: string | null | undefined, now: number, tz: string): KvRows {
  const rows: KvRows = [['Reset', resetLabel(reset, now, tz)]];
  if (typeof windowData?.remaining_dollars === 'number') rows.push(['Remaining', `$${windowData.remaining_dollars.toFixed(2)}`]);
  if (typeof windowData?.used_dollars === 'number' && typeof windowData?.limit_dollars === 'number') rows.push(['Dollars', `$${windowData.used_dollars.toFixed(2)} / $${windowData.limit_dollars.toFixed(2)}`]);
  rows.push(['Used', fmtPct(pct)]);
  if (limit?.severity) rows.push(['Severity', limit.severity]);
  return rows;
}

function claudeBadge(limit?: ClaudeLimitEntry) {
  if (limit?.is_active !== true) return undefined;
  return { tone: 'warn' as const, label: 'Currently limiting', note: 'This limit is currently constraining Claude usage for this account/scope.' };
}

function ClaudeCard({ result, now, tz, evidence }: ProviderCardProps) {
  const d = (result.data as ClaudeUsagePayload | undefined) || {};
  const sessionLimit = claudeLimitByKind(d, 'session') ?? activeSession(d);
  const weeklyLimit = claudeLimitByKind(d, 'weekly_all') ?? activeWeeklyAll(d);
  // Prefer five_hour / seven_day windows (what Claude's own UI shows); fall back to limits[].
  const sessionPct = pickPct(d.five_hour?.utilization, sessionLimit?.percent);
  const weeklyPct = pickPct(d.seven_day?.utilization, weeklyLimit?.percent);
  const scoped = (d.limits || []).filter((l) => l?.kind === 'weekly_scoped');
  const fresh = evidence.state === 'fresh';
  const spend = d.spend && typeof d.spend === 'object' ? Object.entries(d.spend as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined).slice(0, 10).map(([k, v]): [string, ReactNode] => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]) : [];
  const name = providerName(result.account.provider);
  return (
    <AccountGroup result={result} title={`${result.account.label} · ${result.account.email || 'Email not recorded'}`} availability={fresh ? deriveModelAvailability(d) : undefined} footer={<Meta result={result} tz={tz} />}>
      {!fresh ? <UnknownCard result={result} tz={tz} evidence={evidence} /> : <>
        <LimitCard label="Current session" provider={name} pct={sessionPct} reset={d.five_hour?.resets_at || sessionLimit?.resets_at} badge={claudeBadge(sessionLimit)} tone={limitTone(sessionPct, sessionLimit?.severity)} rows={claudeRows(sessionLimit, d.five_hour, sessionPct, d.five_hour?.resets_at || sessionLimit?.resets_at, now, tz)} now={now} tz={tz} />
        <LimitCard label="Weekly all models" provider={name} pct={weeklyPct} reset={d.seven_day?.resets_at || weeklyLimit?.resets_at} badge={claudeBadge(weeklyLimit)} tone={limitTone(weeklyPct, weeklyLimit?.severity)} rows={claudeRows(weeklyLimit, d.seven_day, weeklyPct, d.seven_day?.resets_at || weeklyLimit?.resets_at, now, tz)} now={now} tz={tz} />
        {scoped.length ? scoped.map((limit, i) => {
          const pct = normalizePct(limit.percent);
          return <LimitCard key={i} label={scopeLabel(limit)} provider={name} pct={pct} reset={limit.resets_at} badge={claudeBadge(limit)} tone={limitTone(pct, limit.severity)} rows={claudeRows(limit, null, pct, limit.resets_at, now, tz)} now={now} tz={tz} />;
        }) : <p className="acct__empty">No scoped model limit returned.</p>}
        <Accordion title="Spend / credits" rows={spend} empty="No spend object returned." />
      </>}
    </AccountGroup>
  );
}

// ---------------------------------------------------------------- Kimi

function kimiRows(detail: KimiQuotaDetail | null, pct: number | null, reset: string | null | undefined, note: string, now: number, tz: string): KvRows {
  return [
    ['Used / limit', `${fmtNumber(detail?.used)} / ${fmtNumber(detail?.limit)}`],
    ['Remaining', fmtNumber(detail?.remaining)],
    ['Reset', resetLabel(reset, now, tz)],
    ['Used', fmtPct(pct)],
    ['Window', note],
  ];
}

function KimiCard({ result, now, tz, evidence }: ProviderCardProps) {
  const data = result.data as KimiUsagePayload | undefined;
  const coding = kimiCodingUsage(data);
  const overall = coding?.detail ?? null;
  const window300 = kimiWindow(data, 300, 'TIME_UNIT_MINUTE');
  const overallPct = kimiUsagePercent(overall);
  const windowPct = kimiUsagePercent(window300?.detail ?? null);
  const fresh = evidence.state === 'fresh';
  const name = providerName(result.account.provider);
  const nearLimit = (pct: number | null) => (pct !== null && pct >= 90 ? { tone: 'warn' as const, label: 'Near limit', note: 'Kimi reports this quota near its cap.' } : undefined);
  return (
    <AccountGroup result={result} title={`Kimi Code · ${result.account.email}`} availability={fresh ? deriveKimiAvailability(data) : undefined} footer={<Meta result={result} tz={tz} />}>
      {!fresh ? <UnknownCard result={result} tz={tz} evidence={evidence} /> : <>
        <LimitCard label="Overall coding quota" provider={name} pct={overallPct} reset={overall?.resetTime} badge={nearLimit(overallPct)} tone={limitTone(overallPct)} rows={kimiRows(overall, overallPct, overall?.resetTime, `Scope: ${coding?.scope || 'n/a'}`, now, tz)} now={now} tz={tz} />
        <LimitCard label="300-minute window" provider={name} pct={windowPct} reset={window300?.detail.resetTime} badge={nearLimit(windowPct)} tone={limitTone(windowPct)} rows={kimiRows(window300?.detail ?? null, windowPct, window300?.detail.resetTime, 'Rolling TIME_UNIT_MINUTE window', now, tz)} now={now} tz={tz} />
        <KvCard title="Quota summary" rows={[['Global remaining', `${fmtNumber(overall?.remaining)} / ${fmtNumber(overall?.limit)}`], ['Window remaining', `${fmtNumber(window300?.detail.remaining)} / ${fmtNumber(window300?.detail.limit)}`]]} />
      </>}
    </AccountGroup>
  );
}

// ---------------------------------------------------------------- Codex

function codexBlocked(rl?: { allowed?: boolean; limit_reached?: boolean } | null): boolean {
  return rl?.limit_reached === true || rl?.allowed === false;
}

function CodexAdditionalLimit({ limit, provider, now, tz }: { limit: CodexAdditionalRateLimit; provider: string; now: number; tz: string }) {
  const primary = limit.rate_limit?.primary_window;
  const pct = primary?.used_percent ?? null;
  const resetIso = primary?.reset_at ? new Date(primary.reset_at * 1000).toISOString() : null;
  const blocked = codexBlocked(limit.rate_limit);
  return (
    <LimitCard label={limit.limit_name} provider={provider} pct={pct} reset={resetIso} tone={limitTone(pct, null, blocked)} badge={blocked ? { tone: 'bad', label: 'Limit reached', note: `${limit.metered_feature} rate limit reached.` } : undefined} rows={[['Feature', limit.metered_feature], ['Reset', resetLabel(resetIso, now, tz)], ['Used', fmtPct(pct)]]} now={now} tz={tz} />
  );
}

function codexCreditRows(data?: CodexUsagePayload): KvRows {
  if (!data) return [];
  const credits = data.credits;
  const spend = data.spend_control;
  const resetCredits = data.rate_limit_reset_credits;
  const yesNo = (value: boolean | undefined) => (value === true ? 'Yes' : value === false ? 'No' : 'Unknown');
  return [
    ['Credits balance', credits?.balance ?? 'Unknown'],
    ['Has credits', yesNo(credits?.has_credits)],
    ['Unlimited', yesNo(credits?.unlimited)],
    ['Overage limit reached', yesNo(credits?.overage_limit_reached)],
    ['Spend control reached', yesNo(spend?.reached)],
    ['Individual limit', spend?.individual_limit ?? 'Unknown'],
    ['Reset credits available', `${resetCredits?.available_count ?? 'Unknown'} (applicable: ${resetCredits?.applicable_available_count ?? 'Unknown'})`],
  ];
}

function CodexCard(props: ProviderCardProps) {
  if (props.result.account.authOwner !== 'cliproxy') return <LocalCodexCard {...props} />;
  const url = props.result.account.authManagementUrl;
  return (
    <CodexCardBody
      {...props}
      tools={url ? <ButtonLink variant="ghost" size="sm" href={url} target="_blank" rel="noopener noreferrer">Reconnect in CLIProxyAPI</ButtonLink> : null}
      belowHeader={<div className="acct__reconnect codex-auth">
        {url ? null : <p className="t-small">Reconnect through CLIProxyAPI management.</p>}
        <p className="t-small">CLIProxyAPI owns this account connection. Select Codex OAuth and sign in to the same provider account.</p>
      </div>}
    />
  );
}

function LocalCodexCard(props: ProviderCardProps) {
  const { state, start, starting } = useCodexAuth(props.result.account.key, props.onAuthorized);
  return (
    <CodexCardBody
      {...props}
      tools={<Button variant="ghost" size="sm" onClick={start} disabled={starting}>{props.result.ok ? 'Reconnect' : 'Connect account'}</Button>}
      belowHeader={state ? <CodexAuthBox state={state} now={props.now} tz={props.tz} /> : null}
    />
  );
}

function CodexCardBody({ result, now, tz, evidence, tools, belowHeader }: ProviderCardProps & { tools: ReactNode; belowHeader: ReactNode }) {
  const data = result.data as CodexUsagePayload | undefined;
  const primary = codexPrimaryWindow(data);
  const pct = primary?.used_percent ?? null;
  const resetIso = codexWindowResetIso(primary);
  const blocked = codexBlocked(data?.rate_limit);
  const fresh = evidence.state === 'fresh';
  const name = providerName(result.account.provider);
  return (
    <AccountGroup result={result} title={`${result.account.label} · ${data?.email || result.account.email || 'Email not recorded'}`} availability={fresh ? deriveCodexAvailability(data, result.status) : undefined} tools={tools} belowHeader={belowHeader} footer={<Meta result={result} tz={tz} prefix={`Plan: ${data?.plan_type || 'n/a'} · `} />}>
      {!fresh ? <UnknownCard result={result} tz={tz} evidence={evidence} /> : <>
        <LimitCard label={codexWindowDurationLabel(primary)} provider={name} pct={pct} reset={resetIso} tone={limitTone(pct, null, blocked)} badge={blocked ? { tone: 'bad', label: 'Limit reached', note: 'Rate limit has been reached for this window.' } : undefined} rows={[['Reset', resetLabel(resetIso, now, tz)], ['Status', blocked ? 'Blocked' : data?.rate_limit?.allowed === true ? 'Allowed' : 'Unknown'], ['Used', fmtPct(pct)]]} now={now} tz={tz} />
        {(data?.additional_rate_limits ?? []).map((limit, i) => <CodexAdditionalLimit key={i} limit={limit} provider={name} now={now} tz={tz} />)}
        <Accordion title="Credits & spend control" rows={codexCreditRows(data)} empty="No credit data returned." />
      </>}
    </AccountGroup>
  );
}

// ---------------------------------------------------------------- Cursor

function cursorSpendingRows(spending?: CursorSpending | null): KvRows {
  if (!spending) return [];
  const cents = (v?: number | null) => (typeof v === 'number' ? `$${(v / 100).toFixed(2)}` : 'n/a');
  const enabled = spending.onDemandEnabled;
  return [
    ['Total spend', cents(spending.totalCents)],
    ['Included', cents(spending.includedCents)],
    ['On-demand', cents(spending.onDemandCents)],
    ['On-demand enabled', enabled === true ? 'Yes' : enabled === false ? 'No' : 'n/a'],
    ['Budget limit', typeof spending.budgetLimitCents === 'number' ? `$${(spending.budgetLimitCents / 100).toFixed(2)}` : 'No limit'],
  ];
}

function CursorCard({ result, now, tz, evidence }: ProviderCardProps) {
  const data = result.data as CursorUsagePayload | undefined;
  const billing = data?.billingModel ?? detectCursorBillingModel(data);
  const tierLabel = cursorTierLabel(detectCursorTier(data?.stripe));
  const resetIso = cursorCycleEnd(data);
  const status = (data?.stripe?.subscriptionStatus ?? '').toLowerCase();
  const fresh = evidence.state === 'fresh';
  const name = providerName(result.account.provider);

  let usageSection: ReactNode;
  if (billing === 'usd_credit' && data?.currentPeriod?.planUsage) {
    const pu = data.currentPeriod.planUsage;
    const creditPct = cursorCreditPercent(data);
    const limitDollars = typeof pu.limit === 'number' ? (pu.limit / 100).toFixed(2) : 'n/a';
    const usedDollars = typeof pu.used === 'number' ? (pu.used / 100).toFixed(2) : typeof pu.limit === 'number' && typeof pu.remaining === 'number' ? ((pu.limit - pu.remaining) / 100).toFixed(2) : 'n/a';
    const remainDollars = typeof pu.remaining === 'number' ? (pu.remaining / 100).toFixed(2) : 'n/a';
    const rows: KvRows = [
      ['Reset', resetLabel(resetIso, now, tz)],
      ['Used / limit', `$${usedDollars} / $${limitDollars}`],
      ['Remaining', `$${remainDollars}`],
      ...(pu.autoPercentUsed != null ? ([['Auto usage', `${pu.autoPercentUsed.toFixed(1)}%`]] as KvRows) : []),
      ...(pu.apiPercentUsed != null ? ([['API usage', `${pu.apiPercentUsed.toFixed(1)}%`]] as KvRows) : []),
      ['Used', fmtPct(creditPct)],
    ];
    usageSection = <LimitCard label="Monthly credit usage" provider={name} pct={creditPct} reset={resetIso} tone={limitTone(creditPct)} rows={rows} now={now} tz={tz} />;
  } else if (billing === 'request_count' && data?.legacyUsage?.['gpt-4']) {
    const model = data.legacyUsage['gpt-4'];
    const legacyPct = cursorLegacyPercent(data);
    const rows: KvRows = [
      ['Reset', resetLabel(resetIso, now, tz)],
      ['Requests used', `${model?.numRequests ?? 'n/a'} / ${model?.maxRequestUsage ?? 'n/a'}`],
      ['Remaining', model?.numRequests != null && model?.maxRequestUsage != null ? `${Math.max(0, model.maxRequestUsage - model.numRequests)}` : 'n/a'],
      ['Used', fmtPct(legacyPct)],
    ];
    usageSection = <LimitCard label="Monthly request usage" provider={name} pct={legacyPct} reset={resetIso} tone={limitTone(legacyPct)} rows={rows} now={now} tz={tz} />;
  } else {
    usageSection = <p className="acct__empty">No usage data available. Billing model: {billing}.</p>;
  }

  const subscriptionRows: KvRows = [
    ['Plan', `${tierLabel}${data?.stripe?.isYearlyPlan ? ' (yearly)' : ''}`],
    ['Status', status || 'n/a'],
    ['Team member', data?.stripe?.isTeamMember ? 'Yes' : 'No'],
    ...(data?.stripe?.pendingCancellationDate ? ([['Cancels', data.stripe.pendingCancellationDate]] as KvRows) : []),
    ...(typeof data?.stripe?.customerBalance === 'number' && data.stripe.customerBalance < 0 ? ([['Prepaid balance', `$${(Math.abs(data.stripe.customerBalance) / 100).toFixed(2)}`]] as KvRows) : []),
  ];

  return (
    <AccountGroup result={result} title={`${result.account.label} · ${result.account.email || 'Email not recorded'}`} availability={fresh ? deriveCursorAvailability(data) : undefined} footer={<Meta result={result} tz={tz} prefix={`Billing: ${billing} · `} />}>
      {!fresh ? <UnknownCard result={result} tz={tz} evidence={evidence} /> : <>
        {usageSection}
        {data?.spending ? <KvCard title="Spending" rows={cursorSpendingRows(data.spending)} /> : null}
        <Accordion title="Subscription details" rows={subscriptionRows} />
      </>}
    </AccountGroup>
  );
}
