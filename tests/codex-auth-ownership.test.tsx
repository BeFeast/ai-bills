import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { publicUsageAccount } from '../src/lib/account-auth';
import { UsageCard } from '../src/components/UsageCard';
import type { AccountConfig } from '../src/lib/config';
import type { ProviderUsage } from '../src/lib/usage';

const account: AccountConfig = { key: 'proxy-codex', provider: 'codex', label: 'Example', email: 'example@example.invalid', quota_snapshot_key: 'opaque-source', codex_home: '/private/credentials', cdp_http: 'http://private.example.invalid' };
const managementUrl = 'https://proxy.example.invalid/management.html';
const now = Date.parse('2026-09-07T12:00:00Z');
const result = (): ProviderUsage => ({ account: publicUsageAccount(account, managementUrl), ok: false, status: 401, error: 'Expired credential', fetchedAt: new Date(now).toISOString(), sourceUrl: 'snapshot' });
const render = (value: ProviderUsage) => renderToStaticMarkup(<UsageCard result={value} now={now} tz="UTC" onAuthorized={() => {}} />);

describe('Codex connection ownership', () => {
  it('projects owner and navigation without leaking private runtime fields', () => {
    expect(publicUsageAccount(account, managementUrl)).toEqual({ key: account.key, provider: 'codex', label: 'Example', email: account.email, authOwner: 'cliproxy', authManagementUrl: managementUrl });
    expect(publicUsageAccount({ ...account, quota_snapshot_key: undefined }, managementUrl).authOwner).toBe('local');
    expect(publicUsageAccount(account, 'https://user:secret@example.invalid/').authManagementUrl).toBeUndefined();
    expect(publicUsageAccount(account, 'javascript:alert(1)').authManagementUrl).toBeUndefined();
    expect(publicUsageAccount(account, managementUrl + '?token=private').authManagementUrl).toBeUndefined();
  });
  it('uses native reconnect for both unavailable and healthy proxy accounts', () => {
    const value = result();
    for (const healthy of [false, true]) {
      value.ok = healthy; value.status = healthy ? 200 : 401;
      value.data = healthy ? { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: now / 1000 + 100 }, secondary_window: null } } as ProviderUsage['data'] : undefined;
      const html = render(value);
      expect(html).toContain(`href="${managementUrl}"`);
      expect(html).toContain('Reconnect in CLIProxyAPI');
      expect(html).not.toContain('>Connect account</button>');
      expect(html).not.toContain('>Reconnect</button>');
    }
  });
  it('never falls back to local sign-in when the native management URL is missing', () => {
    const value = result(); value.account.authManagementUrl = undefined;
    expect(render(value)).toContain('Reconnect through CLIProxyAPI management.');
    expect(render(value)).not.toContain('>Connect account</button>');
  });
  it('rejects direct local OAuth start before spawning or creating auth files', async () => {
    process.env.AI_BILLS_CONFIG = `${process.cwd()}/tests/fixtures/accounts.toml`;
    const { CodexAuthManager, ProxyOwnedCodexAuthError } = await import('../src/lib/codex-auth');
    const spawn = vi.fn();
    const manager = new CodexAuthManager({ accounts: [account], spawn });
    expect(() => manager.start(account.key)).toThrow(ProxyOwnedCodexAuthError);
    expect(spawn).not.toHaveBeenCalled();
  });
});
