import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsageCard, usageEvidence } from '../src/components/UsageCard';
import type { ProviderUsage } from '../src/lib/usage';
const now = Date.parse('2026-01-10T12:00:00Z');
const result = (): ProviderUsage => ({ account: { key: 'example', provider: 'claude', label: 'Example', email: 'example@example.invalid' }, ok: true, status: 200, fetchedAt: '2026-01-10T11:59:00Z', sourceUrl: 'fixture', data: { five_hour: { utilization: 100, resets_at: '2026-01-10T13:00:00Z' }, limits: [{ kind: 'session', percent: 100, is_active: true }] } });
const render = (item: ProviderUsage) => renderToStaticMarkup(<UsageCard result={item} now={now} tz="UTC" onAuthorized={() => {}} />);

describe('quota evidence shown to users', () => {
  it('replaces stale limiting claims with explicitly unknown availability', () => {
    const item = result(); item.fetchedAt = '2026-01-01T00:00:00Z';
    const html = render(item);
    expect(html).toContain('Stale observation'); expect(html).toContain('Availability unknown');
    expect(html).not.toContain('Currently limiting'); expect(html).not.toContain('No models available'); expect(html).not.toContain('>Live<');
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
