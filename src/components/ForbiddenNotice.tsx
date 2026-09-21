import { SignOutButton } from '@clerk/nextjs';
import { authMode } from '@/lib/hosted-auth';
import { ZecoriMark } from '@/components/Brand';

/** The person is signed in but not a member of this instance. Redirecting to sign-in would loop; name the account and offer sign-out instead. */
export function ForbiddenNotice({ email }: { email: string | null }) {
  const account = email || 'this account';
  return <main className="auth-page">
    <div className="auth-page__intro"><ZecoriMark size={56} /><div><p className="auth-page__lead">{account} is not a member of this Zecori instance.</p><p className="t-small">Ask the operator to add the address, or sign in with a different account.</p></div></div>
    {authMode() === 'clerk' ? <SignOutButton redirectUrl="/sign-in"><button type="button" className="bf-btn bf-btn--secondary">Sign out</button></SignOutButton> : null}
  </main>;
}
