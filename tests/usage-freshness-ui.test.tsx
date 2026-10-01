import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsageCard, usageEvidence } from '../src/components/UsageCard';
import type { ProviderUsage } from '../src/lib/usage';
const now = Date.parse('2026-01-10T12:00:00Z');
const result = (): ProviderUsage => ({ account: { key: 'example', provider: 'claude', label: 'Example', email: 'example@example.invalid' }, ok: true, status: 200, fetchedAt: '2026-01-10T11:59:00Z', sourceUrl: 'fixture', data: { five_hour: { utilization: 100, resets_at: '2026-01-10T13:00:00Z' }, limits: [{ kind: 'session', percent: 100, is_active: true }] } });
const render = (item: ProviderUsage) => renderToStaticMarkup(<UsageCard result={item} now={now} tz="UTC" onAuthorized={() => {}} />);

describe('quota evidence shown to users', () => {
  it('replaces limiting claims older than 5 h with a source error and keeps the dated last value', () => {
    const item = result(); item.fetchedAt = '2026-01-01T00:00:00Z';
    const html = render(item);
    expect(html).toContain('Source error'); expect(html).toContain('Availability unknown');
    expect(html).toContain('Last known'); expect(html).toContain('Exhausted · Session · observed 1 Jan 2026, 0:00');
    expect(html).not.toContain('Currently limiting'); expect(html).not.toContain('No models available'); expect(html).not.toContain('>Live<');
  });
  it('keeps the numbers of a Claude observation under 5 h, labelled with age, source and why nothing newer exists', () => {
    const item = result(); item.status = undefined; item.source = 'retained'; item.fetchedAt = '2026-01-10T09:30:00Z';
    item.direct = { status: 429, error: 'Rate limited by the provider; next attempt after 12:25 UTC', attemptedAt: '2026-01-10T11:59:30Z' };
    const html = render(item);
    expect(html).toContain('Last known quota · observed 10 Jan 2026, 9:30 · source: last success · refresh failed: Rate limited by the provider; next attempt after 12:25 UTC');
    expect(html).toContain('Current session');
    expect(html).not.toContain('Source error'); expect(html).not.toContain('Availability unknown');
    expect(html).not.toContain('No models available');
  });
  it('names an expired proxy credential apart from the browser sign-in and shows website numbers with their source', () => {
    const item = result(); item.status = 200; item.source = 'web'; item.fetchedAt = '2026-01-10T11:59:00Z';
    item.direct = { status: 429, error: 'Proxy OAuth expired — re-login proxy', attemptedAt: '2026-01-10T11:58:00Z' };
    item.proxyAuth = { state: 'expired', message: 'invalid grant (retrying)', observedAt: '2026-01-10T11:58:00Z' };
    const html = render(item);
    expect(html).toContain('Proxy OAuth expired — re-login proxy.');
    expect(html).toContain('invalid grant (retrying)');
    expect(html).toContain('Opening the account browser does not fix this');
    expect(html).toContain('showing the signed-in claude.ai session (account browser)');
    expect(html).not.toContain('Source error');
  });
  it('names the fallback and how the direct check ended when the number is not the provider\'s own answer', () => {
    const item = result(); item.status = undefined; item.source = 'retained'; item.direct = { status: 429, error: 'Proxy quota request rejected (HTTP 429)', attemptedAt: '2026-01-10T11:59:30Z' };
    const html = render(item);
    expect(html).toContain('100.0%');
    expect(html).toContain('observed 10 Jan 2026, 11:59 · Proxy quota request rejected (HTTP 429); showing the last successful observation');
    expect(html).not.toContain('Source error');
  });
  it('never renders Allowed or zero utilization when Codex authentication fails', () => {
    const item = result(); item.account.provider = 'codex'; item.ok = false; item.status = 401; item.data = undefined;
    const html = render(item);
    expect(html).toContain('Source error'); expect(html).toContain('Availability unknown');
    expect(html).not.toContain('Allowed'); expect(html).not.toContain('0%'); expect(html).not.toContain('No models available');
    expect(html).toContain('Connect account');
  });
  it('does not infer health from a new dashboard timestamp or an empty successful payload', () => {
    const item = result(); item.fetchedAt = '';
    expect(usageEvidence(item, now).state).toBe('unknown');
    item.fetchedAt = '2026-01-10T11:59:00Z'; item.data = {};
    expect(usageEvidence(item, now).state).toBe('unknown');
  });
  it('keeps recent real quota evidence visible', () => {
    const item = result();
    expect(usageEvidence(item, now).state).toBe('fresh');
    expect(render(item)).toContain('100.0%');
  });
});
