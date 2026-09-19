import { aboutHtml } from '@/lib/public-pages';
export const dynamic = 'force-dynamic';
export function GET() { return new Response(aboutHtml(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } }); }
