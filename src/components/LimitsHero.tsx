'use client';

import type { ReactNode } from 'react';
import type { HeroActivity, HeroFallback, HeroWindow, LimitsHero as LimitsHeroData, LimitsHeroCard } from '@/lib/limits-hero';
import type { ProductSubscription } from '@/lib/overview';
import { countdown, fmtDate, fmtMoney, refillLabel } from './format';
import { ProviderIcon } from './ProviderIcon';
import { AccountBrowserAccess } from './AccountBrowserAccess';
import { Button, ButtonLink, Card, Pill, Progress } from './ui';

const TZ = 'Asia/Jerusalem';
const pct = (value: number | null) => value === null ? 'n/a' : `${Number(value.toFixed(1))}%`;
function remainingText(window: HeroWindow): string {
  if (window.exhausted) return 'Exhausted';
  if (window.unit === 'requests') return window.remaining === null ? 'n/a' : `${window.remaining.toLocaleString()} requests`;
  return pct(window.remainingPercent);
}
function ResetChip({ reset, now }: { reset: string | null; now: number }) {
  const text = refillLabel(reset, now);
  return text ? <span className="hero-chip" title={`Resets ${fmtDate(reset, TZ)}`}>↻ {text}</span> : <span className="hero-chip">refill time unknown</span>;
}
function activityText(activity: HeroActivity | null, recencyKnown: boolean, now: number): string {
  if (!recencyKnown) return 'Traffic for the last 24h is not available yet';
  if (!activity || !activity.requests) return 'No proxy requests in the last 24h';
  const parts = [`${activity.ok.toLocaleString()} ok`];
  if (activity.rateLimited) parts.push(`${activity.rateLimited.toLocaleString()} rate-limited`);
  if (activity.failed) parts.push(`${activity.failed.toLocaleString()} failed`);
  const last = activity.lastRequestAt ? ` · last request ${countdown(activity.lastRequestAt, now)}` : '';
  return `${parts.join(' · ')} · 24h${last}`;
}
const stateLabel: Record<'error' | 'stale' | 'unknown', string> = { error: 'Source error', stale: 'Stale observation', unknown: 'Quota unknown' };
const fallbackSource: Record<HeroFallback['kind'], string> = { proxy_headers: "quota read by the proxy from the account's own traffic", retained: 'last successful observation' };
function FallbackPill({ fallback }: { fallback: HeroFallback }) {
  return <Pill tone="warn" title={`${fallback.error}. Showing the ${fallbackSource[fallback.kind]}.`}>{fallback.status === 429 ? 'Check rate-limited' : 'Check failed'}</Pill>;
}

function HeroCard({ card, now, recencyKnown, subscriptions }: { card: LimitsHeroCard; now: number; recencyKnown: boolean; subscriptions: ProductSubscription[] }) {
  if (card.kind === 'outcomes') {
    const { activity } = card;
    return <article className={`bf-card hero-card hero-card--muted${card.tone ? ` hero-card--${card.tone}` : ''}`} aria-label={`${card.label} · request outcomes`}>
      <div className="hero-card__head"><ProviderIcon provider={card.provider} size={24} /><div className="hero-card__id"><span className="hero-card__label">{card.label}</span><span className="hero-card__email">{card.email || card.provider}</span></div><Pill tone={card.tone === 'warn' ? 'warn' : 'idle'} title="This provider has no quota API; the proxy's request outcomes are the only availability evidence.">{card.tone === 'warn' ? 'Rate limited' : 'No quota API'}</Pill></div>
      <div className="hero-outcomes" role="group" aria-label="Request outcomes in the last 24h">
        <span><strong>{activity.ok.toLocaleString()}</strong>ok</span>
        <span className={activity.rateLimited ? 'hero-outcomes__warn' : undefined}><strong>{activity.rateLimited.toLocaleString()}</strong>rate-limited</span>
        <span><strong>{activity.failed.toLocaleString()}</strong>failed</span>
      </div>
      <div className="hero-card__foot">
        <span className="t-small">{card.balanceUsd !== null ? `${fmtMoney(card.balanceUsd)} account balance · ` : ''}{activity.lastRequestAt ? `last request ${countdown(activity.lastRequestAt, now)}` : 'last request time unknown'}{card.credentialStatus ? ` · CLIProxyAPI ${card.credentialStatus}` : ''}</span>
        {card.websiteUrl ? <ButtonLink variant="ghost" size="sm" href={card.websiteUrl} target="_blank" rel="noreferrer">Provider website ↗</ButtonLink> : null}
      </div>
    </article>;
  }
  const subscription = subscriptions.find((plan) => plan.accountKeys.includes(card.account.key));
  const access = subscription ? <AccountBrowserAccess subscription={subscription} showEntranceLink={false} /> : <AccountBrowserAccess account={card.account} showEntranceLink={false} />;
  const head = (badge: ReactNode) => <div className="hero-card__head"><ProviderIcon provider={card.account.provider} size={24} /><div className="hero-card__id"><span className="hero-card__label">{card.account.label}</span><span className="hero-card__email">{card.account.email || 'Email not recorded'}</span></div>{badge}</div>;
  if (card.kind === 'error') {
    return <article className={`bf-card hero-card hero-card--${card.state === 'error' ? 'bad' : 'warn'}`} aria-label={`${card.account.label} · ${stateLabel[card.state]}`}>
      {head(<Pill tone={card.state === 'error' ? 'bad' : 'warn'}>{stateLabel[card.state]}</Pill>)}
      <div className="hero-card__body"><div className="hero-card__main"><span className="hero-card__window">{card.lastKnown ? card.lastKnown.label : 'Remaining allowance'}</span>
        <div className="hero-card__value">{card.lastKnown ? <><span className="hero-card__num tabular">{remainingText(card.lastKnown)}</span><span className="t-small">last known</span></> : <span className="hero-card__num">Unknown</span>}</div>
        <span className="t-small">{card.message}{card.status ? ` HTTP ${card.status}.` : ''}</span></div></div>
      <div className="hero-card__foot"><span className="t-small">{activityText(card.activity, recencyKnown, now)}{Number.isFinite(Date.parse(card.observedAt)) ? ` · observed ${fmtDate(card.observedAt, TZ)}` : ''}</span>{access}</div>
    </article>;
  }
  const others = card.windows.filter((window) => window !== card.limiting);
  const badge = card.limiting.exhausted ? <Pill tone="bad">Limit reached</Pill> : card.tone === 'warn' ? <Pill tone="warn">Running low</Pill> : null;
  return <article className={`bf-card hero-card${card.tone ? ` hero-card--${card.tone}` : ''}`} aria-label={`${card.account.label} · ${remainingText(card.limiting)} left · ${card.limiting.label}`}>
    {head(<>{badge}{card.fallback ? <FallbackPill fallback={card.fallback} /> : null}</>)}
    <div className="hero-card__body">
      <div className="hero-card__main">
        <span className="hero-card__window" title="The window currently constraining this account">{card.limiting.label}</span>
        <div className="hero-card__value"><span className="hero-card__num tabular">{remainingText(card.limiting)}</span>{card.limiting.exhausted ? null : <span className="t-small">left</span>}</div>
        <ResetChip reset={card.limiting.resetsAt} now={now} />
      </div>
      {others.length ? <ul className="hero-windows" aria-label="Other limit windows">{others.map((window) => <li className={`hero-window${window.tone ? ` hero-window--${window.tone}` : ''}`} key={window.label}>
        <span className="hero-window__label">{window.label}</span>
        <span className="hero-window__value">{remainingText(window)}{window.exhausted || window.unit === 'requests' ? '' : ' left'}</span>
        <Progress value={window.remainingPercent ?? 0} tone={window.tone} label={`${window.label} remaining`} />
        <span className="hero-window__reset">{refillLabel(window.resetsAt, now) ? `↻ ${refillLabel(window.resetsAt, now)}` : 'refill time unknown'}</span>
      </li>)}</ul> : null}
    </div>
    <div className="hero-card__foot"><span className="t-small">{activityText(card.activity, recencyKnown, now)}{card.fallback ? ` · ${fallbackSource[card.fallback.kind]} · observed ${fmtDate(card.observedAt, TZ)}` : ''}</span>{access}</div>
  </article>;
}

export function LimitsHero({ hero, now, subscriptions, onView }: { hero: LimitsHeroData; now: number; subscriptions: ProductSubscription[]; onView: (view: 'accounts') => void }) {
  const refreshed = hero.refreshedAt && Number.isFinite(Date.parse(hero.refreshedAt)) ? new Date(hero.refreshedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : null;
  return <Card id="limits-now" title="Limits now" subtitle={`Accounts used in the last ${hero.windowHours}h${refreshed ? ` · refreshed ${refreshed}` : ''}`} actions={<Button variant="secondary" size="sm" onClick={() => onView('accounts')}>Accounts &amp; sign-in →</Button>} aria-label="Limits now">
    {hero.loading ? <p className="hero-empty">Loading account quotas…</p>
      : hero.cards.length ? <div className="hero-grid">{hero.cards.map((card) => <HeroCard key={card.id} card={card} now={now} recencyKnown={hero.recencyKnown} subscriptions={subscriptions} />)}</div>
      : <p className="hero-empty">{hero.pending ? `Waiting for the first quota observation of ${hero.pending} account${hero.pending === 1 ? '' : 's'}…` : hero.recencyKnown ? 'No account with a quota source was used in the last 24h and none is running low.' : 'No quota observations yet.'}</p>}
  </Card>;
}
