import { SignIn } from '@clerk/nextjs';
import { authMode } from '@/lib/hosted-auth';
import { ZecoriMark } from '@/components/Brand';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  if (authMode() !== 'clerk') return <main className="auth-page"><p className="t-small">This instance does not use sign-in.</p></main>;
  return <main className="auth-page">
    <div className="auth-page__intro"><ZecoriMark size={56} /><div><p className="auth-page__lead">Zecori, your AI treasurer</p><p className="t-small">Sign in to open the books.</p></div></div>
    <SignIn />
  </main>;
}
