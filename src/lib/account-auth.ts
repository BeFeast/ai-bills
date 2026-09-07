import type { AccountConfig } from './config';
import type { PublicUsageAccount } from './usage';

/** Project ownership and a configured navigation URL, never credential paths. */
export function publicUsageAccount(account: AccountConfig, managementUrl?: string): PublicUsageAccount {
  const { key, provider, label, email } = account;
  const authOwner = account.quota_snapshot_key ? 'cliproxy' : 'local';
  let authManagementUrl: string | undefined;
  if (provider === 'codex' && authOwner === 'cliproxy' && managementUrl) {
    try {
      const url = new URL(managementUrl);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search) {
        authManagementUrl = url.href;
      }
    } catch { /* Missing or invalid configuration leaves an explicit owner message. */ }
  }
  return { key, provider, label, email, ...(provider === 'codex' ? { authOwner, authManagementUrl } : {}) };
}
