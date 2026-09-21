import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { clerkClient, clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { DENIED_EMAIL_HEADER, IDENTITY_HEADERS, PUBLIC_PATHS, authMode, authorizeEmail, clerkRuntime, membershipMode, parseEmailList, stripIdentityHeaders } from '@/lib/hosted-auth';

const isPublic = createRouteMatcher(PUBLIC_PATHS);
const isApi = createRouteMatcher(['/api/(.*)']);
let warnedAboutClaim = false;
/** The public URL of a request: configured origin plus the request path, or the request URL when no origin is configured. */
let warnedAboutOrigin = false;
export function publicUrl(request: { nextUrl: { pathname: string; search: string }; url: string }, origin = process.env.AI_BILLS_PUBLIC_ORIGIN): string {
  if (!origin) return request.url;
  try { return new URL(request.nextUrl.pathname + request.nextUrl.search, origin).toString(); }
  catch {
    if (!warnedAboutOrigin) { warnedAboutOrigin = true; console.warn(`[zecori] AI_BILLS_PUBLIC_ORIGIN is not an absolute URL (${origin}); sign-in return addresses fall back to the request URL.`); }
    return request.url;
  }
}

/** Order: public paths → Clerk session (redirect to sign-in / 401 for API) → who may use this instance.
 * With a database (membership mode) the middleware forwards the identity and the Node side decides by membership,
 * because the edge runtime cannot reach Postgres; without one, this instance's own allow list decides here (403 by name). */
// Only evaluated in Clerk mode: a half-configured satellite must not take a local instance down with it.
// allowedRedirectOrigins is a ClerkProvider (browser) option only; the server-side AuthenticateRequestOptions has no such field.
const clerkOptions = (() => { if (authMode() !== 'clerk') return {}; const c = clerkRuntime(); return { publishableKey: c.publishableKey, signInUrl: c.signInUrl, isSatellite: c.isSatellite, domain: c.domain }; })();
const withClerk = clerkMiddleware(async (auth, request) => {
  // A caller must never be able to present an identity of its own choosing to the handlers.
  const headers = stripIdentityHeaders(request.headers);
  if (isPublic(request)) return NextResponse.next({ request: { headers } });
  // A machine client presents the tenant's ingest token instead of a session (the collector's browser-quota refresh);
  // the Node side resolves it through ingest_tokens and answers 401 itself when it is not a live token.
  if (membershipMode() && /^Bearer\s+\S+$/i.test(request.headers.get('authorization') ?? '')) return NextResponse.next({ request: { headers } });
  const session = await auth();
  if (!session.userId) {
    if (isApi(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Behind the tunnel the request URL names the container (0.0.0.0:18088); the return address must be the public origin.
    // On a satellite instance Clerk sends the person to the primary's sign-in and back here afterwards.
    return session.redirectToSignIn({ returnBackUrl: publicUrl(request) });
  }
  const claims = session.sessionClaims as { email?: unknown } | null;
  let email = typeof claims?.email === 'string' ? claims.email : null;
  if (!email) {
    // The instance should carry an `email` session claim; without it, ask the Backend API rather than lock everyone out.
    try { const user = await (await clerkClient()).users.getUser(session.userId); email = user.primaryEmailAddress?.emailAddress ?? null; }
    catch { email = null; }
    if (!warnedAboutClaim) { warnedAboutClaim = true; console.warn('[zecori] session token carries no email claim; falling back to the Clerk Backend API per request. Add {"email": "{{user.primary_email_address}}"} to the instance session claims.'); }
  }
  if (membershipMode()) {
    headers.set(IDENTITY_HEADERS.userId, session.userId);
    if (email) headers.set(IDENTITY_HEADERS.email, email);
    return NextResponse.next({ request: { headers } });
  }
  const verdict = authorizeEmail(email, parseEmailList(process.env.AI_BILLS_ALLOWED_EMAILS), parseEmailList(process.env.AI_BILLS_ADMIN_EMAILS));
  if (verdict.allowed) return NextResponse.next({ request: { headers } });
  if (isApi(request)) return NextResponse.json({ error: 'Forbidden', account: email ?? undefined }, { status: 403 });
  const url = request.nextUrl.clone(); url.pathname = '/forbidden'; url.search = '';
  headers.set(DENIED_EMAIL_HEADER, email ?? 'unknown account');
  return NextResponse.rewrite(url, { request: { headers } });
}, clerkOptions);

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (authMode() !== 'clerk') return NextResponse.next({ request: { headers: stripIdentityHeaders(request.headers) } });
  return withClerk(request, event);
}

export const config = { matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'] };
