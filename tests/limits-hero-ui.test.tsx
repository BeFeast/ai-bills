import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ProductOverviewPanel } from '../src/components/ProductOverviewPanel';
import { buildProductOverview } from '../src/lib/overview';
import type { AppConfig } from '../src/lib/config';
import type { ProviderUsage } from '../src/lib/usage';

const now = Date.parse('2026-09-18T20:20:00Z');
const fetchedAt = new Date(now - 30_000).toISOString();
const config = { server: { timezone: 'UTC' }, subscriptions: [], accounts: [] } as unknown as AppConfig;
const snapshot = { usage_ledger: { generated: '2026-09-18T20:15:13Z', last_24h: { period: 'rolling_24h', window_hours: 24, requests: 600, failed: 3, rate_limited: 0,
  by_upstream: [{ provider: 'claude', name: 'work@example.invalid', requests: 582, failed: 3, rate_limited: 0, tokens: 1, last_request_at: '2026-09-18T20:10:00Z' }, { provider: 'xai', name: 'work@example.invalid', requests: 4, failed: 2, rate_limited: 2, tokens: 1, last_request_at: '2026-09-18T19:00:00Z' }] } } };
const work: ProviderUsage = { account: { key: 'claude-work', provider: 'claude', label: 'Claude · Work', email: 'work@example.invalid' }, ok: true, status: 200, fetchedAt, sourceUrl: 'fixture',
  data: { five_hour: { utilization: 7, resets_at: '2026-09-19T00:10:00Z' }, seven_day: { utilization: 43, resets_at: '2026-09-21T08:00:00Z' }, limits: [
    { kind: 'session', percent: 7, resets_at: '2026-09-19T00:10:00Z', is_active: false }, { kind: 'weekly_all', percent: 43, resets_at: '2026-09-21T08:00:00Z', is_active: false },
    { kind: 'weekly_scoped', percent: 83, severity: 'warning', resets_at: '2026-09-21T08:00:00Z', scope: { model: { display_name: 'Fable' } }, is_active: true } ] } };
const kimi: ProviderUsage = { account: { key: 'kimi-work', provider: 'kimi', label: 'Kimi Code', email: 'kimi@example.invalid' }, ok: false, fetchedAt, sourceUrl: 'fixture', error: 'Kimi auth cookie missing' };
const grok = { id: 'grok', provider: 'xai', label: 'x.ai · Grok', origin: 'oauth' as const, billingMode: 'unknown' as const, routingEnrolled: null, quota: { status: 'unknown' as const, remaining: null, resetAt: null }, coverage: { status: 'partial' as const, reason: '' }, observedAt: fetchedAt,
  proxyCredential: { kind: 'oauth' as const, status: 'active', successToday: 0, failedToday: 0, email: 'work@example.invalid', observedAt: fetchedAt } };

test('overview opens with the Limits now hero and moves money tiles to accounting details', () => {
  const data = buildProductOverview(config, snapshot, '2026-09');
  const html = renderToStaticMarkup(<ProductOverviewPanel data={data} accounts={[work, kimi]} registry={[grok]} view="overview" onView={() => {}} now={now} />);
  expect(html.indexOf('Limits now')).toBeGreaterThan(-1);
  expect(html.indexOf('Limits now')).toBeLessThan(html.indexOf('Subscriptions'));
  expect(html).toContain('Accounts used in the last 24h · refreshed 23:15');
  expect(html).toContain('Fable weekly');
  expect(html).toContain('>17%<');
  expect(html).toContain('↻ refills in 2d 11h 40m');
  expect(html).toContain('Weekly all models');
  expect(html).toContain('579 ok · 3 failed · 24h');
  expect(html).toContain('Source error');
  expect(html).toContain('Kimi auth cookie missing');
  expect(html).toContain('rate-limited');
  expect(html).toContain('>Rate limited<');
  expect(html).not.toContain('Quota remaining');
  expect(html).not.toContain('Active subscriptions');
  expect(html).not.toContain('Other subscriptions &amp; accounts');
  const cards = html.match(/class="bf-card hero-card/g) ?? [];
  expect(cards).toHaveLength(3);
  expect(html.indexOf('Claude · Work')).toBeLessThan(html.indexOf('Kimi Code'));
  expect(html.indexOf('Kimi Code')).toBeLessThan(html.indexOf('x.ai · Grok'));
  const details = renderToStaticMarkup(<ProductOverviewPanel data={data} accounts={[work]} registry={[]} view="details" onView={() => {}} now={now} />);
  expect(details).toContain('Active subscriptions');
  expect(details).not.toContain('Limits now');
});
