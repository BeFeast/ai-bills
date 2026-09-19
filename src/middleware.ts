import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { clerkClient, clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { PUBLIC_PATHS, authMode, authorizeEmail, parseEmailList } from '@/lib/hosted-auth';

const isPublic = createRouteMatcher(PUBLIC_PATHS);
const isApi = createRouteMatcher(['/api/(.*)']);
let warnedAboutClaim = false;

/** Order: public paths → Clerk session (redirect to sign-in / 401 for API) → this instance's own allow list (403 by name). */
const withClerk = clerkMiddleware(async (auth, request) => {
  if (isPublic(request)) return NextResponse.next();
  const session = await auth();
  if (!session.userId) {
    if (isApi(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return session.redirectToSignIn({ returnBackUrl: request.url });
  }
  const claims = session.sessionClaims as { email?: unknown } | null;
  let email = typeof claims?.email === 'string' ? claims.email : null;
  if (!email) {
    // The instance should carry an `email` session claim; without it, ask the Backend API rather than lock everyone out.
    try { const user = await (await clerkClient()).users.getUser(session.userId); email = user.primaryEmailAddress?.emailAddress ?? null; }
    catch { email = null; }
    if (!warnedAboutClaim) { warnedAboutClaim = true; console.warn('[zecori] session token carries no email claim; falling back to the Clerk Backend API per request. Add {"email": "{{user.primary_email_address}}"} to the instance session claims.'); }
  }
  const verdict = authorizeEmail(email, parseEmailList(process.env.AI_BILLS_ALLOWED_EMAILS), parseEmailList(process.env.AI_BILLS_ADMIN_EMAILS));
  if (verdict.allowed) return NextResponse.next();
  if (isApi(request)) return NextResponse.json({ error: 'Forbidden', account: email ?? undefined }, { status: 403 });
  const url = request.nextUrl.clone(); url.pathname = '/forbidden'; url.search = '';
  return NextResponse.rewrite(url, { request: { headers: new Headers({ ...Object.fromEntries(request.headers), 'x-zecori-denied-email': email ?? 'unknown account' }) } });
});

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (authMode() !== 'clerk') return NextResponse.next();
  return withClerk(request, event);
}

export const config = { matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'] };
