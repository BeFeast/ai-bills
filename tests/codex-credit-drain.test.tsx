import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
// widget.ts and guards.ts reach the usage service, whose CDP module loads the operator config at import time; none of that is exercised here.
vi.mock('../src/lib/cdp', () => ({ fetchUsageThroughCdp: vi.fn() }));
import { schema } from '../src/db/schema';
import { APP_ROLE, MIGRATIONS_FOLDER, ensureTenant, type Db } from '../src/lib/db';
import { storeSnapshot } from '../src/lib/snapshot-store';
import { dbCreditHistoryStore } from '../src/lib/storage';
import { codexPaysFromCredits, codexUsedUp, creditDrain, creditDrainSentence, creditDrainSummary, type CreditSample } from '../src/lib/codex-credits';
import { deriveCodexAvailability, type CodexUsagePayload, type ProviderUsage } from '../src/lib/usage';
import { buildGuardsReport } from '../src/lib/guards';
import { buildWidgetPayload } from '../src/lib/widget';
import { buildLimitsHero } from '../src/lib/limits-hero';
import { LimitsHero } from '../src/components/LimitsHero';
import { UsageCard } from '../src/components/UsageCard';
import type { UsageResponseBody } from '../src/lib/usage-service';

const now = Date.parse('2026-10-03T14:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

/** A Codex answer shaped like the provider's: weekly primary window, credits, manual resets. */
function payload({ used = 100, reached = used >= 100, credits = true, balance = '39671.03', accountId = 'acct-a', userId = 'user-synthetic', email = 'a@example.invalid', resets = reached ? 3 : 0, overage = false }: {
  used?: number; reached?: boolean; credits?: boolean; balance?: string; accountId?: string; userId?: string; email?: string; resets?: number; overage?: boolean } = {}): CodexUsagePayload {
  return { user_id: userId, account_id: accountId, email, plan_type: 'pro',
    rate_limit: { allowed: !reached, limit_reached: reached, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: Math.round(now / 1000) + 3600 }, secondary_window: null },
    code_review_rate_limit: null, additional_rate_limits: null,
    credits: { has_credits: credits, unlimited: false, overage_limit_reached: overage, balance, approx_local_messages: [], approx_cloud_messages: [] },
    spend_control: { reached: false, individual_limit: null }, rate_limit_reached_type: reached ? 'rate_limit_reached' : null, promo: null,
    rate_limit_reset_credits: { available_count: 3, applicable_available_count: resets } } as unknown as CodexUsagePayload;
}
const result = (key: string, data: CodexUsagePayload, minutesAgo = 1): ProviderUsage => ({ account: { key, provider: 'codex', label: key, email: data.email }, ok: true, status: 200, fetchedAt: at(minutesAgo), sourceUrl: 'fixture', data });
const sample = (minutesAgo: number, balance: string | null, accountId: string | null = 'acct-a', accountKey = 'a@example.invalid', userId: string | null = 'user-synthetic', canPay: boolean | null = true): CreditSample => ({ accountKey, accountId, userId, observedAt: at(minutesAgo), balance, canPay });
/** The collector's header fallback: the proxy's rate-limit headers stood in, so there is no credits block. */
const headerFallback = (key: string, minutesAgo = 1): ProviderUsage => ({ account: { key, provider: 'codex', label: key, email: 'a@example.invalid' }, ok: true, status: null as never, fetchedAt: at(minutesAgo), sourceUrl: 'fixture', source: 'proxy_headers',
  data: { plan_type: 'pro', rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: Math.round(now / 1000) + 3600 }, secondary_window: null } } as unknown as CodexUsagePayload });

describe('paying from credits', () => {
  it('is a used-up window with credits on hand, and nothing else', () => {
    expect(codexUsedUp(payload({ used: 100, reached: false }))).toBe(true);
    expect(codexUsedUp(payload({ used: 97, reached: true }))).toBe(true);
    expect(codexUsedUp(payload({ used: 97, reached: false }))).toBe(false);
    expect(codexPaysFromCredits(payload())).toBe(true);
    expect(codexPaysFromCredits(payload({ credits: false }))).toBe(false);
    expect(codexPaysFromCredits(payload({ overage: true }))).toBe(false);
    expect(codexPaysFromCredits(payload({ used: 40, reached: false }))).toBe(false);
  });

  it('measures the burn from the earliest balance of the same account in the last hour', () => {
    // 20 510 credits in 2 h 20 min is about 8 790/h; within the window the same pace gives the same rate.
    const samples = [sample(70, '70000'), sample(50, '46849.08'), sample(30, '43670.03'), sample(5, '40100'), sample(40, '1', 'acct-b', 'b@example.invalid')];
    const drain = creditDrain(result('codex-a', payload(), 1), samples)!;
    expect(drain).toEqual({ balance: 39671.03, perHour: 8789, since: at(50), manualResets: 3 });
    expect(creditDrainSummary(drain)).toBe('paying from credits · −8.8k credits/h · 3 manual resets available');
    expect(creditDrainSentence(drain)).toBe('The rate limit is used up, but Codex still answers: each request is charged to the credit balance (39,671 left, −8.8k credits/h). A manual reset restores the window without spending credits (3 available).');
  });

  it('says unknown, not zero, without history or after a top-up, and zero when the balance held', () => {
    expect(creditDrain(result('codex-a', payload()), [])).toMatchObject({ perHour: null, since: null });
    expect(creditDrain(result('codex-a', payload()), [sample(5, '50000')])).toMatchObject({ perHour: null });
    expect(creditDrain(result('codex-a', payload()), [sample(30, '1000')])).toMatchObject({ perHour: null });
    const held = creditDrain(result('codex-a', payload()), [sample(30, '39671.03')])!;
    expect(held.perHour).toBe(0);
    expect(creditDrainSummary(held)).toBe('paying from credits · no credits spent lately · 3 manual resets available');
  });

  it('measures from after a top-up instead of losing the hour', () => {
    // 46 000 → 43 000, then 50 000 bought: 93 000 → 87 000 over the last half hour is 12 000/h.
    const drain = creditDrain(result('codex-a', payload({ balance: '87000' })), [sample(50, '46000'), sample(40, '43000'), sample(31, '93000'), sample(20, '90000')])!;
    expect(drain).toMatchObject({ perHour: 12000, since: at(31) });
    // A rise less than ten minutes ago leaves too short a span: unknown, not zero.
    expect(creditDrain(result('codex-a', payload({ balance: '87000' })), [sample(40, '43000'), sample(6, '88000')])).toMatchObject({ perHour: null });
  });

  it('reads a header fallback from the stored observations of the last hour', () => {
    expect(creditDrain(headerFallback('codex-a'), [sample(31, '43671.03'), sample(6, '40337.70')])).toEqual({ balance: 40337.7, perHour: 8000, since: at(31), manualResets: 0 });
    expect(creditDrain(headerFallback('codex-a'), [sample(31, '40338'), sample(6, '40338')])).toMatchObject({ perHour: 0 });
    // A direct outage longer than one tick keeps the last measured rate for the hour, then says it is unknown.
    expect(creditDrain(headerFallback('codex-a'), [sample(55, '43671.03'), sample(25, '39671.03')])).toMatchObject({ perHour: 8000, balance: 39671.03 });
    expect(creditDrain(headerFallback('codex-a'), [sample(25, '39671.03')])).toEqual({ balance: 39671.03, perHour: null, since: null, manualResets: 0 });
    expect(creditDrain(headerFallback('codex-a'), [sample(70, '43671.03')])).toBeNull();
    expect(creditDrain(headerFallback('codex-a'), [])).toBeNull();
  });

  it('does not call a header fallback paying when the last direct observation could no longer pay', () => {
    // Credits ran out, or a spend cap or overage limit was reached: the provider now refuses instead of charging.
    expect(creditDrain(headerFallback('codex-a'), [sample(31, '4000'), sample(6, '0', 'acct-a', 'a@example.invalid', 'user-synthetic', false)])).toBeNull();
    expect(creditDrain(headerFallback('codex-a'), [sample(31, '4000'), sample(6, '3000', 'acct-a', 'a@example.invalid', 'user-synthetic', false)])).toBeNull();
    expect(creditDrain(headerFallback('codex-a'), [sample(31, '4000'), sample(6, '0')])).toBeNull();
  });

  it('keeps two seats of one workspace apart', () => {
    const seat = result('codex-a', payload({ userId: 'user-alice' }));
    expect(creditDrain(seat, [sample(31, '43671.03', 'acct-a', 'b@example.invalid', 'user-bob')])).toMatchObject({ perHour: null });
    expect(creditDrain(seat, [sample(31, '43671.03', 'acct-a', 'a@example.invalid', 'user-alice')])).toMatchObject({ perHour: 8000 });
  });

  it('falls back to the e-mail key when observations carry no account id', () => {
    expect(creditDrain(result('codex-a', payload()), [sample(31, '43671.03', null)])).toMatchObject({ perHour: 8000 });
    expect(creditDrain(result('codex-a', payload()), [sample(31, '43671.03', null, 'other@example.invalid')])).toMatchObject({ perHour: null });
  });

  it('is null for an account with room, without credits, or failing', () => {
    expect(creditDrain(result('codex-a', payload({ used: 40, reached: false })), [])).toBeNull();
    expect(creditDrain(result('codex-a', payload({ credits: false })), [])).toBeNull();
    expect(creditDrain({ ...result('codex-a', payload()), ok: false }, [])).toBeNull();
  });

  it('keeps the account available in the header, red once spending is measured', () => {
    const data = payload();
    expect(deriveCodexAvailability(data, 200, creditDrain(result('codex-a', data), []))).toMatchObject({ available: true, tone: 'warn', label: 'Paying from credits' });
    expect(deriveCodexAvailability(data, 200, creditDrain(result('codex-a', data), [sample(31, '43671.03')]))).toMatchObject({ available: true, tone: 'danger' });
    expect(deriveCodexAvailability(payload({ credits: false }), 200)).toMatchObject({ available: false, label: 'Rate limit reached' });
  });
});

describe('credits guard', () => {
  const paying = (perHourSamples: CreditSample[]) => { const value = result('codex-a', payload()); return { ...value, creditDrain: creditDrain(value, perHourSamples)! }; };
  const roomy = (used = 2, minutesAgo = 1) => result('codex-b', payload({ used, reached: false, accountId: 'acct-b', email: 'b@example.invalid' }), minutesAgo);
  const guard = (accounts: ProviderUsage[]) => buildGuardsReport({ accounts, checks: [], snapshot: {}, now });

  it('goes down while one account spends and another has room', () => {
    const report = guard([paying([sample(31, '43671.03')]), roomy()]);
    expect(report.guards.credits).toMatchObject({ status: 'down', message: 'Credits spent while another Codex account has room: codex-a pays from credits (−8k credits/h) while codex-b has 98 % left' });
    expect(report.credits).toEqual([{ accountKey: 'codex-a', balance: 39671.03, perHour: 8000, manualResets: 3 }]);
  });

  it('stays up when every account is out, when nothing is spent, or when the other account is the same login', () => {
    expect(guard([paying([sample(31, '43671.03')]), roomy(100)]).guards.credits).toMatchObject({ status: 'up', message: 'codex-a pays from credits (−8k credits/h); no other Codex account has room' });
    expect(guard([paying([sample(30, '39671.03')]), roomy()]).guards.credits).toMatchObject({ status: 'up', message: 'Used up with credits on hand, none spent lately: codex-a' });
    expect(guard([paying([]), roomy()]).guards.credits).toMatchObject({ status: 'up', message: 'Used up with credits on hand, spend not measured yet: codex-a' });
    const twin = { ...result('codex-a2', payload({ used: 5, reached: false })) };
    expect(guard([paying([sample(31, '43671.03')]), twin]).guards.credits.status).toBe('up');
  });

  it('counts another seat of the same workspace as room, and a header fallback that is seen spending', () => {
    const bob = result('codex-b', payload({ used: 10, reached: false, userId: 'user-bob', email: 'b@example.invalid' }));
    expect(guard([paying([sample(31, '43671.03')]), bob]).guards.credits).toMatchObject({ status: 'down', message: expect.stringContaining('while codex-b has 90 % left') });
    const fallback = headerFallback('codex-a');
    const spendingFallback = { ...fallback, creditDrain: creditDrain(fallback, [sample(31, '43671.03'), sample(6, '40337.70')])! };
    expect(guard([spendingFallback, roomy()]).guards.credits.status).toBe('down');
    expect(deriveCodexAvailability(spendingFallback.data as CodexUsagePayload, undefined, spendingFallback.creditDrain)).toMatchObject({ available: true, label: 'Paying from credits', tone: 'danger' });
    expect(renderToStaticMarkup(<UsageCard result={spendingFallback} now={now} tz="UTC" onAuthorized={() => {}} />)).toContain('Paying from credits');
  });

  it('judges only fresh observations, and says which it left out', () => {
    expect(guard([paying([sample(31, '43671.03')]), roomy(2, 30)]).guards.credits).toMatchObject({ status: 'up', message: 'codex-a pays from credits (−8k credits/h); no other Codex account has room (not judged, no fresh observation: codex-b)' });
    expect(guard([roomy()]).guards.credits).toMatchObject({ status: 'up', message: 'No Codex account is paying from credits (1 observed)' });
    expect(guard([]).guards.credits.message).toBe('No Codex account configured');
  });
});

describe('surfaces', () => {
  const spending = () => { const value = result('codex-a', payload()); return { ...value, creditDrain: creditDrain(value, [sample(31, '43671.03')])! }; };
  const usage = (accounts: ProviderUsage[]): UsageResponseBody => ({ generatedAt: at(1), timezone: 'UTC', accounts, combined: { models: [] } as never, apiShape: {}, refreshing: false });

  it('labels the spent window in the widget, so older clients show it under the meter', () => {
    const payloadOut = buildWidgetPayload({ usage: usage([spending()]), snapshot: { body: {}, version: at(2) }, now, timezone: 'UTC' });
    const row = payloadOut.accounts[0];
    expect(row.creditDrain).toMatchObject({ perHour: 8000, manualResets: 3 });
    expect(row.headline).toMatchObject({ label: 'Weekly (paying from credits)', remainingPercent: 0, exhausted: true });
    expect(row.limiting?.label).toBe('Weekly (paying from credits)');
    expect(row.windows.map(window => window.label)).toEqual(['Weekly (paying from credits)']);
    const plain = buildWidgetPayload({ usage: usage([result('codex-b', payload({ used: 40, reached: false }))]), snapshot: { body: {}, version: at(2) }, now, timezone: 'UTC' }).accounts[0];
    expect(plain).toMatchObject({ creditDrain: null, headline: { label: 'Weekly' } });
  });

  it('shows the drain on the Overview hero and the account card', () => {
    const hero = buildLimitsHero({ usage: [spending()], registry: [], now });
    const card = hero.cards[0];
    expect(card.kind === 'quota' && card.creditDrain).toMatchObject({ perHour: 8000 });
    const heroHtml = renderToStaticMarkup(<LimitsHero hero={hero} now={now} subscriptions={[]} onView={() => {}} />);
    expect(heroHtml).toContain('Paying from credits');
    expect(heroHtml).toContain('paying from credits · −8k credits/h · 3 manual resets available');
    expect(heroHtml).not.toContain('Limit reached');
    const cardHtml = renderToStaticMarkup(<UsageCard result={spending()} now={now} tz="UTC" onAuthorized={() => {}} />);
    expect(cardHtml).toContain('Paying from credits');
    expect(cardHtml).toContain('each request is charged to the credit balance (39,671 left, −8k credits/h)');
    expect(cardHtml).not.toContain('Limit reached');
  });
});

describe('stored credit balances', () => {
  let pg: PGlite; let db: Db;
  beforeAll(async () => {
    pg = new PGlite();
    const owner = drizzle(pg, { schema });
    await migrate(owner, { migrationsFolder: MIGRATIONS_FOLDER });
    await pg.exec(`SET ROLE ${APP_ROLE}`);
    db = owner as unknown as Db;
  }, 60_000);
  afterAll(async () => { await pg.close(); });

  it('reads the tenant\'s Codex balances since a cutoff, without header fallbacks or other tenants', async () => {
    const mine = await ensureTenant(db, 'credits-a'); const theirs = await ensureTenant(db, 'credits-b');
    const entry = (minutesAgo: number, balance: string) => ({ ok: true, status: 200, fetched_at: at(minutesAgo), source: 'direct', data: payload({ balance }) });
    const put = (tenant: string, body: unknown, minutesAgo: number) => storeSnapshot(db, tenant, JSON.stringify(body), at(minutesAgo), new Date(now - minutesAgo * 60_000));
    await put(mine.id, { codex_usage: { 'a@example.invalid': entry(90, '80000') } }, 90);
    await put(mine.id, { codex_usage: { 'a@example.invalid': entry(31, '43671.03') } }, 31);
    await put(mine.id, { codex_usage: { 'a@example.invalid': { ok: true, status: null, fetched_at: at(20), source: 'proxy_headers', data: { rate_limit: { limit_reached: true } } } } }, 20);
    await put(theirs.id, { codex_usage: { 'a@example.invalid': entry(25, '5') } }, 25);
    await put(mine.id, { codex_usage: { 'a@example.invalid': { ok: true, status: 200, fetched_at: at(10), source: 'direct', data: { ...payload({ balance: '0', credits: false }), spend_control: { reached: true, individual_limit: null } } } } }, 10);
    const samples = await dbCreditHistoryStore(db, mine.id).since(new Date(now - 70 * 60_000));
    expect(samples).toEqual([{ accountKey: 'a@example.invalid', accountId: 'acct-a', userId: 'user-synthetic', observedAt: at(31), balance: '43671.03', canPay: true },
      { accountKey: 'a@example.invalid', accountId: 'acct-a', userId: 'user-synthetic', observedAt: at(10), balance: '0', canPay: false }]);
    expect(creditDrain(result('codex-a', payload()), samples.slice(0, 1))).toMatchObject({ perHour: 8000, since: at(31) });
  });
});
