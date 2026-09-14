import { AccountBrowserAccess } from '@/components/AccountBrowserAccess';
import { parseAccountBrowserInput, resolveBrowserBinding } from '@/lib/account-browser';
import type { AccountBrowserSelector } from '@/lib/account-browser-types';
import { loadConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AccountBrowserPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  let selector: AccountBrowserSelector;
  let resolved: ReturnType<typeof resolveBrowserBinding>;
  try {
    ({ selector } = parseAccountBrowserInput(await searchParams));
    // Configuration only: visiting a bookmark must never start a browser.
    resolved = resolveBrowserBinding(loadConfig(), selector);
  } catch {
    return <main><h1>Account browser</h1><p role="alert">Invalid account browser selection or configuration.</p><a href="/">Back to dashboard</a></main>;
  }
  if (!resolved) return <main><h1>Account browser</h1><p role="alert">No account browser is configured for this selection.</p><a href="/">Back to dashboard</a></main>;
  const { account, binding } = resolved;
  return <main>
    <h1>Account browser</h1>
    <p>{account.provider} · {account.email}</p>
    <p>Bookmark this page. Open the browser below to start a bounded session, then use Extend session when you need more time.</p>
    {binding.shared_identity_email ? <p>Close session releases browser access for every provider sharing this profile.</p> : null}
    <AccountBrowserAccess account={{ key: account.key, provider: account.provider, email: account.email }} browserSelector={selector} showEntranceLink={false} />
    <p><a href="/">Back to dashboard</a></p>
  </main>;
}
