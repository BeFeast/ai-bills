import { opaqueId } from './accounting';

/**
 * How a configured account finds its quota observation in the collector snapshot.
 *
 * The proxy renames an OAuth credential's file on re-login, and the collector's file-name key changes with it. A
 * configured `quota_snapshot_key` can therefore go stale while the account is healthy. The lookup falls back to the
 * account e-mail, which the collector also publishes (when one credential holds it), and says when it had to, so a
 * guard can report the stale configuration instead of the card quietly losing its numbers.
 */
export type SnapshotKeyed = { key?: string; provider?: string; quota_snapshot_key?: string; email?: string };

/** The collector's rename-proof credential id: provider and account e-mail (see collector/ai-claude-quotas). */
export const credentialId = (provider: string, email: string) => opaqueId(`oauth-account:${provider}:${email.trim().toLowerCase()}`);

/** `siblings`: the tenant's other configured accounts. When another account of the same provider has the same e-mail,
 * the e-mail key cannot say whose observation it is, so a missing configured key is not filled from it. */
export function quotaEntry<T>(rows: Record<string, T> | undefined | null, account: SnapshotKeyed, siblings: readonly SnapshotKeyed[] = []): { entry: T | undefined; key: string | null; viaEmailFallback: boolean } {
  if (!rows || typeof rows !== 'object') return { entry: undefined, key: null, viaEmailFallback: false };
  const configured = account.quota_snapshot_key;
  if (configured && rows[configured] !== undefined) return { entry: rows[configured], key: configured, viaEmailFallback: false };
  const email = account.email;
  const normalized = email?.trim().toLowerCase();
  const shared = siblings.some(other => other !== account && other.key !== account.key && other.provider === account.provider && other.email?.trim().toLowerCase() === normalized);
  if (email && !shared && rows[email] !== undefined) return { entry: rows[email], key: email, viaEmailFallback: Boolean(configured) };
  return { entry: undefined, key: null, viaEmailFallback: false };
}
