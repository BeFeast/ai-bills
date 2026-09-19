/** Hosted mode: a Clerk session proves who someone is; this module decides whether they may use this instance.
 * The two lists are deliberately independent of Clerk's own allowlist (which governs sign-up, not access):
 * removing an address here revokes access on the next request without touching the identity provider. */
export type AuthMode = 'none' | 'clerk';
export const authMode = (env: Record<string, string | undefined> = process.env): AuthMode => env.AI_BILLS_AUTH === 'clerk' ? 'clerk' : 'none';

export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export function parseEmailList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(/[,\s]+/).map(normalizeEmail).filter(entry => entry.includes('@')))];
}

export type Authorization = { allowed: boolean; admin: boolean; reason: 'allowed' | 'not-listed' | 'no-email' | 'open' };
/** Empty allow list keeps a working deployment working (and is logged loudly at boot); a listed address is allowed; anything else is denied by name. */
export function authorizeEmail(email: string | null | undefined, allowed: string[], admins: string[] = []): Authorization {
  if (!email) return { allowed: false, admin: false, reason: 'no-email' };
  const address = normalizeEmail(email);
  const admin = admins.includes(address);
  if (!allowed.length) return { allowed: true, admin, reason: 'open' };
  return allowed.includes(address) || admin ? { allowed: true, admin, reason: 'allowed' } : { allowed: false, admin: false, reason: 'not-listed' };
}

/** Paths that never require a session: liveness for monitors, the bearer-authenticated snapshot ingest, brand assets and the auth pages themselves. */
export const PUBLIC_PATHS = ['/api/health', '/api/snapshot', '/sign-in(.*)', '/forbidden', '/about', '/privacy', '/terms', '/robots.txt', '/brand/(.*)', '/favicon.ico', '/apple-icon.png', '/fonts/(.*)', '/provider-icons/(.*)'];
