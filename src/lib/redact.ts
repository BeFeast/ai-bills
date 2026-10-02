import { createHash } from 'node:crypto';

/**
 * Credentials never render as account names. The collector already publishes `client-key:<label>` for a
 * known client key and `key:sha256:<10 hex>` for any other key; this is the server-side backstop for
 * snapshots written before that, or by another collector.
 */
const LABELS = ['client-key:', 'key:sha256:'];
const PREFIXED = /^(?:sk|pk|rk|ak)[-_]/i;

/** Same rule as the collector's key_shaped(): a prefixed key, or a long opaque token without '@', whitespace or '/'. */
export function isKeyShaped(value: string): boolean {
  const text = value.trim();
  if (!text || text.includes('@') || /\s/.test(text) || LABELS.some(label => text.startsWith(label))) return false;
  if (PREFIXED.test(text)) return true;
  return text.length >= 32 && !text.includes('/') && /\d/.test(text) && /[a-z]/i.test(text);
}

/** `key:sha256:<10 hex>`: stable across snapshots, and the same value the collector would publish. */
export function keyFingerprint(value: string): string {
  return `key:sha256:${createHash('sha256').update(value.trim()).digest('hex').slice(0, 10)}`;
}

/** An account/upstream name as it may be shown or exported. */
export function credentialSafeName(name: string): string {
  const trimmed = name.trim();
  return isKeyShaped(trimmed) ? keyFingerprint(trimmed) : trimmed;
}

/** Prefixed key tokens inside free text (alert titles and messages) become fingerprints. */
export function redactKeyTokens(text: string): string {
  return text.replace(/(?<![A-Za-z0-9_-])(?:sk|pk|rk|ak)[-_][A-Za-z0-9_-]{12,}/gi, token => keyFingerprint(token));
}
