import { headers } from 'next/headers';
import { ForbiddenNotice } from '@/components/ForbiddenNotice';
import { DENIED_EMAIL_HEADER } from '@/lib/hosted-auth';

export const dynamic = 'force-dynamic';

/** Reached by rewrite from the middleware in allow-list mode; in membership mode the pages render the notice themselves. */
export default async function ForbiddenPage() {
  return <ForbiddenNotice email={(await headers()).get(DENIED_EMAIL_HEADER)} />;
}
