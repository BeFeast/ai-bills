import { headers } from 'next/headers';
import { SignOutButton } from '@clerk/nextjs';
import { authMode } from '@/lib/hosted-auth';
import { ZecoriMark } from '@/components/Brand';

export const dynamic = 'force-dynamic';

/** Reached by rewrite from the middleware: the person is signed in but not on this instance's list. Redirecting to sign-in would loop; name the account and offer sign-out instead. */
export default async function ForbiddenPage() {
  const email = (await headers()).get('x-zecori-denied-email') || 'this account';
  return <main className="auth-page">
    <div className="auth-page__intro"><ZecoriMark size={56} /><div><p className="auth-page__lead">{email} is not on the list for this Zecori instance.</p><p className="t-small">Ask the operator to add the address, or sign in with a different account.</p></div></div>
    {authMode() === 'clerk' ? <SignOutButton redirectUrl="/sign-in"><button type="button" className="bf-btn bf-btn--secondary">Sign out</button></SignOutButton> : null}
  </main>;
}
