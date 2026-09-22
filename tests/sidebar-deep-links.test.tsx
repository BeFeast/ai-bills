import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Sidebar } from '../src/components/shell/Sidebar';

test('sidebar items are real links to the view, so a section can be opened, bookmarked and shared by URL', () => {
  const html = renderToStaticMarkup(<Sidebar brand={{ mark: null, name: 'Z' }} items={[{ id: 'overview', label: 'Overview' }, { id: 'accounts', label: 'Accounts', count: 4 }]} activeId="accounts" onSelect={() => {}} />);
  expect(html).toContain('<a href="?view=overview" class="bf-sb__link"');
  expect(html).toContain('<a href="?view=accounts" class="bf-sb__link bf-sb__link--active" aria-current="page"');
  expect(html).not.toContain('<button');
});
