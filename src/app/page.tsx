import { Dashboard } from '@/components/Dashboard';
import { ForbiddenNotice } from '@/components/ForbiddenNotice';
import { authMode } from '@/lib/hosted-auth';
import { isDenied, resolveTenant } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Membership mode: the middleware proved the session; whether this person belongs to a tenant is decided here.
  const tenant = await resolveTenant();
  if (isDenied(tenant)) return <ForbiddenNotice email={tenant.email} />;
  return <Dashboard hosted={authMode() === 'clerk'} />;
}
