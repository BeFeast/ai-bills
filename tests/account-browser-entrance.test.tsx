import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '../src/app/account-browser/page';
import { AccountBrowserAccess } from '../src/components/AccountBrowserAccess';
import type { ProductSubscription } from '../src/lib/overview';
import { loadConfig, type AppConfig } from '../src/lib/config';
import { acquireBrowserLease } from '../src/lib/browser-lease';
import { connectAccountBrowser } from '../src/lib/account-browser-cdp';

vi.mock('../src/lib/config', () => ({ loadConfig: vi.fn() }));
vi.mock('../src/lib/browser-lease', () => ({ acquireBrowserLease: vi.fn(), releaseBrowserLease: vi.fn(), renewBrowserLease: vi.fn() }));
vi.mock('../src/lib/account-browser-cdp', () => ({ connectAccountBrowser: vi.fn() }));

const account = { key: 'personal', provider: 'claude' as const, label: 'Personal', email: 'person@example.test' };
function config(): AppConfig {
  return { accounts: [account], account_browsers: [{
    account_key: account.key, subscription_id: 'subscription-personal',
    profile_id: 'ai-bills-personal', cdp_http: 'http://127.0.0.1:18811',
    remote_url: 'https://browser.example.test/vnc.html',
    login_url: 'https://claude.ai/login', manage_url: 'https://claude.ai/settings/billing',
  }] } as AppConfig;
}

beforeEach(() => { vi.mocked(loadConfig).mockReturnValue(config()); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('bookmarkable account browser entrance', () => {
  it('renders intended identity and controls without acquiring a lease or contacting CDP', async () => {
    const page = await Page({ searchParams: Promise.resolve({ accountKey: 'personal' }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('claude');
    expect(html).toContain('person@example.test');
    expect(html).toContain('Open account browser');
    expect(html).not.toContain('browser.example.test');
    expect(html).not.toContain('href="/account-browser?');
    expect(acquireBrowserLease).not.toHaveBeenCalled();
    expect(connectAccountBrowser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves a subscription selector in the action controls', async () => {
    const page = await Page({ searchParams: Promise.resolve({ subscriptionId: 'subscription-personal' }) });
    const controls = Children.toArray(page.props.children).find(child => isValidElement(child) && child.type === AccountBrowserAccess);
    expect(isValidElement(controls) && (controls.props as { browserSelector: unknown }).browserSelector).toEqual({ subscriptionId: 'subscription-personal' });
    expect(renderToStaticMarkup(page)).toContain('person@example.test');
  });

  it.each([{}, { accountKey: ['personal', 'other'] }, { subscriptionId: ['subscription-personal'] },
    { accountKey: 'personal', subscriptionId: 'subscription-personal' }, { accountKey: '../personal' },
    { accountKey: 'personal', action: 'login' }])('rejects malformed or ambiguous parameters %j', async params => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
    expect(html).toContain('Invalid account browser selection or configuration.');
    expect(html).not.toContain('Open account browser');
    expect(acquireBrowserLease).not.toHaveBeenCalled();
    expect(connectAccountBrowser).not.toHaveBeenCalled();
  });

  it('handles unconfigured and conflicting bindings without exposing launch controls', async () => {
    expect(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ accountKey: 'missing' }) }))).toContain('No account browser is configured');
    const settings = config(); settings.account_browsers!.push({ ...settings.account_browsers![0] });
    vi.mocked(loadConfig).mockReturnValue(settings);
    expect(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ accountKey: 'personal' }) }))).toContain('Invalid account browser selection');
  });

  it('links dashboard controls to the stable entrance', () => {
    const html = renderToStaticMarkup(<AccountBrowserAccess account={account} />);
    expect(html).toContain('href="/account-browser?accountKey=personal"');
    expect(html).toContain('Bookmark browser access');
  });

  it('omits a bookmark link for subscriptions without an account browser selector', () => {
    const subscription = { id: 'website-only', provider: 'suno', label: 'Example', accountKeys: [] } as unknown as ProductSubscription;
    expect(renderToStaticMarkup(<AccountBrowserAccess subscription={subscription} />)).not.toContain('/account-browser?');
  });

  it('explains profile-wide close for an explicitly shared browser', async () => {
    const settings = config(); settings.account_browsers![0].shared_identity_email = account.email;
    vi.mocked(loadConfig).mockReturnValue(settings);
    expect(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ accountKey: 'personal' }) }))).toContain('Close browser affects every provider sharing this profile.');
  });
});
