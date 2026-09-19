import { Dashboard } from '@/components/Dashboard';
import { authMode } from '@/lib/hosted-auth';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <Dashboard hosted={authMode() === 'clerk'} />;
}
