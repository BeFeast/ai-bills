import { robotsTxt } from '@/lib/public-pages';
export const dynamic = 'force-dynamic';
export function GET() { return new Response(robotsTxt(), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } }); }
