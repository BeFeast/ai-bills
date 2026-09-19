import { existsSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Sidebar } from '../src/components/shell/Sidebar';
import { PRODUCT_ATTRIBUTION, PRODUCT_TAGLINE, ZecoriMark, ZecoriSignature, ZecoriWordmark } from '../src/components/Brand';
import { metadata } from '../src/app/layout';

test('the sidebar carries the Zecori identity with BeFeast attribution', () => {
  const html = renderToStaticMarkup(<Sidebar brand={{ mark: <ZecoriMark size={32} className="bf-sb__mark" />, name: <ZecoriWordmark height={19} />, sub: <>{PRODUCT_TAGLINE}<br />{PRODUCT_ATTRIBUTION}</> }} items={[{ id: 'overview', label: 'Overview' }]} activeId="overview" onSelect={() => {}} />);
  expect(html).toContain('/brand/zecori-avatar-64.png');
  expect(html).toContain('/brand/zecori-wordmark.svg');
  expect(html).toContain('/brand/zecori-wordmark-inverse.svg');
  expect(html).toContain('aria-label="Zecori"');
  expect(html).toContain('your AI treasurer<br/>by BeFeast');
  expect(html).not.toContain('befeast-avatar');
});

test('document metadata names the product and keeps the technical slug out of the title', () => {
  expect(metadata.title).toBe('Zecori — your AI treasurer');
  expect(metadata.applicationName).toBe('Zecori');
  expect(String(metadata.description)).toContain('BeFeast');
});

test('brand assets are tracked in the repository, not resolved from the vault or temporary paths', () => {
  for (const path of ['public/brand/zecori-avatar-32.png', 'public/brand/zecori-avatar-64.png', 'public/brand/zecori-avatar-128.png', 'public/brand/zecori-portrait.webp', 'public/brand/zecori-wordmark.svg', 'public/brand/zecori-wordmark-inverse.svg', 'src/app/favicon.ico', 'src/app/apple-icon.png']) {
    expect(existsSync(path), path).toBe(true);
  }
});

test('the sidebar signature carries the product line, the version and the BeFeast link, not a timezone', () => {
  const html = renderToStaticMarkup(<ZecoriSignature version="2.0.0" />);
  expect(html).toContain('Zecori keeps the books.');
  expect(html).toContain('v2.0.0');
  expect(html).toContain('href="https://befeast.com"');
  expect(html).not.toMatch(/Asia\/Jerusalem|ai-bills v/);
});
