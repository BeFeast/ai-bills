import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ProductOverviewPanel } from '../src/components/ProductOverviewPanel';
import { buildProductOverview } from '../src/lib/overview';
import type { AppConfig } from '../src/lib/config';

test('a failing quota source stays on the overview with browser access, never as a fabricated quota', () => {
  const config = { server: { timezone: 'UTC' }, subscriptions: [], accounts: [] } as unknown as AppConfig;
  const data = buildProductOverview(config, {}, '2026-09');
  const html = renderToStaticMarkup(<ProductOverviewPanel data={data} accounts={[
    { account: { key: 'kimi', provider: 'kimi', label: 'Kimi · Work', email: 'work@example.test' }, ok: false, fetchedAt: '', sourceUrl: '' },
    { account: { key: 'cursor', provider: 'cursor', label: 'Cursor', email: 'work@example.test' }, ok: false, fetchedAt: '', sourceUrl: '' },
  ]} view="overview" onView={() => {}} />);
  expect(html.match(/Open account browser/g)).toHaveLength(2);
  expect(html).not.toContain('Account details');
  expect(html).not.toContain('kimi · Kimi');
  expect(html).not.toContain('cursor · Cursor');
  expect(html.match(/bf-pill--bad">Source error/g)).toHaveLength(2);
  expect(html).not.toContain('% left');
});
