/** Hosted mode: a Clerk session proves who someone is; this module decides whether they may use this instance.
 * The two lists are deliberately independent of Clerk's own allowlist (which governs sign-up, not access):
 * removing an address here revokes access on the next request without touching the identity provider. */
export type AuthMode = 'none' | 'clerk';
export const authMode = (env: Record<string, string | undefined> = process.env): AuthMode => env.AI_BILLS_AUTH === 'clerk' ? 'clerk' : 'none';

/**
 * Tenancy phase 2: with a database, who may use the instance is decided by `memberships`, not by the
 * allow list. The middleware (edge) then only proves the session and forwards the identity in these
 * headers; the Node side resolves the tenant. Incoming requests never get to set them themselves.
 */
export const membershipMode = (env: Record<string, string | undefined> = process.env) => authMode(env) === 'clerk' && Boolean(env.DATABASE_URL);
export const IDENTITY_HEADERS = { userId: 'x-zecori-user-id', email: 'x-zecori-user-email' } as const;
export const DENIED_EMAIL_HEADER = 'x-zecori-denied-email';
/** Request headers with every identity header removed, so only the middleware's own values reach the handlers. */
export function stripIdentityHeaders(headers: Headers): Headers {
  const clean = new Headers(headers);
  for (const name of [...Object.values(IDENTITY_HEADERS), DENIED_EMAIL_HEADER]) clean.delete(name);
  return clean;
}

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

/** Clerk wiring resolved at request time, so one image serves the primary instance and any satellite (partner) instance.
 * `CLERK_PUBLISHABLE_KEY` is read at runtime (falls back to the build-time NEXT_PUBLIC value); a satellite declares the
 * primary origin in `AI_BILLS_CLERK_PRIMARY_ORIGIN` and sends people there to sign in. */
export type ClerkRuntime = { publishableKey: string | undefined; signInUrl: string; afterSignOutUrl: string; isSatellite: boolean; domain: string | undefined; allowedRedirectOrigins: string[] };
export function clerkRuntime(env: Record<string, string | undefined> = process.env): ClerkRuntime {
  const publicOrigin = (env.AI_BILLS_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  const primary = (env.AI_BILLS_CLERK_PRIMARY_ORIGIN || '').replace(/\/$/, '');
  const isSatellite = Boolean(primary) && primary !== publicOrigin;
  // Cross-domain Clerk sessions need https on both sides; an http origin is treated as no domain.
  const domain = (() => { try { const url = publicOrigin ? new URL(publicOrigin) : null; return url?.protocol === 'https:' ? url.host : undefined; } catch { return undefined; } })();
  // Clerk needs the satellite's own domain; a satellite without one fails on every sign-in, so refuse to start half-configured.
  if (isSatellite && !domain) throw new Error('AI_BILLS_CLERK_PRIMARY_ORIGIN is set, so AI_BILLS_PUBLIC_ORIGIN must be this instance\'s absolute https origin');
  const allowed = (env.AI_BILLS_CLERK_ALLOWED_REDIRECT_ORIGINS || '').split(/[,\s]+/).map(v => v.trim()).filter(Boolean);
  return {
    publishableKey: env.CLERK_PUBLISHABLE_KEY || env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || undefined,
    signInUrl: isSatellite ? `${primary}/sign-in` : '/sign-in',
    afterSignOutUrl: isSatellite ? `${primary}/sign-in` : '/sign-in',
    isSatellite, domain: isSatellite ? domain : undefined, allowedRedirectOrigins: allowed,
  };
}
