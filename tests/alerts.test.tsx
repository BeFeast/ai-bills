import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseAlerts } from '../src/lib/alerts';
import { AlertsSection } from '../src/components/AlertsSection';

const now = Date.parse('2026-09-19T00:10:00Z');
const snapshot = { generated: '2026-09-19T00:05:38Z', alerts: { generated: '2026-09-19T00:05:00+00:00', conditions: [
  { key: 'quota:claude:work@example.invalid', severity: 'P4', state: 'bad', title: 'Claude · work@example.invalid: 1% left on Fable weekly', message: 'Fable weekly 99% used', value: 1, since: '2026-09-18T23:00:00+00:00' },
  { key: 'source:snapshot', severity: 'P5', state: 'ok', title: 'Collector snapshot fresh', message: 'Last snapshot 0 min ago', value: 12, since: null },
  { key: 'renewal:sub-kimi:renews_at', severity: 'P3', state: 'warn', title: 'Kimi: renews 2026-09-21', message: 'Renewal in 2 day(s), 19 USD', value: 2, since: '2026-09-19T00:05:00+00:00' },
  { key: 'bogus', severity: 'P9', state: 'weird' },
], events: [
  { at: '2026-09-18T23:00:00+00:00', kind: 'raised', key: 'quota:claude:work@example.invalid', severity: 'P4', state: 'bad', title: 'Claude · work@example.invalid: 1% left on Fable weekly', message: 'Fable weekly 99% used' },
  { at: '2026-09-19T00:05:00+00:00', kind: 'raised', key: 'renewal:sub-kimi:renews_at', severity: 'P3', state: 'warn', title: 'Kimi: renews 2026-09-21', message: 'Renewal in 2 day(s)' },
] } };

describe('alerts report', () => {
  it('parses the collector block, orders active conditions first and drops malformed rows', () => {
    const report = parseAlerts(snapshot);
    expect(report.available).toBe(true);
    expect(report.conditions.map(c => [c.key, c.state])).toEqual([['quota:claude:work@example.invalid', 'bad'], ['renewal:sub-kimi:renews_at', 'warn'], ['source:snapshot', 'ok']]);
    expect(report.active).toHaveLength(2);
    expect(report.events[0].key).toBe('renewal:sub-kimi:renews_at');
  });
  it('reports "not configured" without an alerts block instead of pretending silence', () => {
    const report = parseAlerts({ generated: '2026-09-19T00:05:38Z' });
    expect(report).toMatchObject({ available: false, conditions: [], active: [], events: [] });
  });
  it('replaces prefixed key tokens in condition and event text with a fingerprint', () => {
    const key = 'sk-client-fixture-0123456789abcdefghijklmnop';
    const leaked = { generated: '2026-09-19T00:05:38Z', alerts: { generated: '2026-09-19T00:05:00+00:00',
      conditions: [{ key: `ratelimit:cursor:${key}`, severity: 'P4', state: 'warn', title: `cursor · ${key}: 3 rate-limited in 24h`, message: `key ${key} answered 429`, value: 3, since: null }],
      events: [{ at: '2026-09-19T00:05:00+00:00', kind: 'raised', key: `ratelimit:cursor:${key}`, severity: 'P4', state: 'warn', title: `cursor · ${key}`, message: key }] } };
    const report = parseAlerts(leaked);
    expect(JSON.stringify(report)).not.toContain(key.slice(-12));
    expect(report.conditions[0].key).toMatch(/^ratelimit:cursor:key:sha256:[0-9a-f]{10}$/);
    expect(report.events[0].title).toMatch(/^cursor · key:sha256:[0-9a-f]{10}$/);
  });
  it('renders conditions, events and the stale warning', () => {
    const html = renderToStaticMarkup(<AlertsSection report={parseAlerts(snapshot)} now={now} tz="UTC" />);
    expect(html).toContain('2 active');
    expect(html).toContain('critical');
    expect(html).toContain('Fable weekly 99% used');
    expect(html).toContain('Renewal in 2 day(s)');
    expect(html).toContain('>raised<');
    expect(html).not.toContain('older than 30 minutes');
    const stale = renderToStaticMarkup(<AlertsSection report={parseAlerts(snapshot)} now={now + 3_600_000} tz="UTC" />);
    expect(stale).toContain('older than 30 minutes');
    const missing = renderToStaticMarkup(<AlertsSection report={parseAlerts({})} now={now} tz="UTC" />);
    expect(missing).toContain('has not reported yet');
  });
});
