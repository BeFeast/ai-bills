import { NextResponse } from 'next/server';
import { hasAllowedOrigin } from '@/lib/request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
const allowed = (method: string, path: string) => method === 'GET' ? path === 'state' : ['policy/validate', 'policy/apply'].includes(path) || /^suggestions\/[a-zA-Z0-9_-]+$/.test(path);
type Context = { params: Promise<{ path: string[] }> };

async function forward(request: Request, context: Context) {
  const path = (await context.params).path.join('/');
  if (!allowed(request.method, path)) return NextResponse.json({ error: 'Unknown routing operation' }, { status: 404, headers });
  const base = process.env.AI_BILLS_ROUTING_URL;
  const token = process.env.AI_BILLS_ROUTING_TOKEN;
  if (!base || !token) return NextResponse.json({ error: 'Routing service is not configured. Accounting remains available.' }, { status: 503, headers });
  let body: string | undefined;
  if (request.method === 'POST') {
    if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin policy changes are not allowed' }, { status: 403, headers });
    try {
      body = await request.text();
      if (body.length > 256_000) return NextResponse.json({ error: 'Policy is too large' }, { status: 413, headers });
      JSON.parse(body);
    } catch { return NextResponse.json({ error: 'Expected a JSON request' }, { status: 400, headers }); }
  }
  try {
    const url = new URL(`${base.replace(/\/$/, '')}/control/${path}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported service URL');
    const response = await fetch(url, { method: request.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, cache: 'no-store', signal: AbortSignal.timeout(8_000), redirect: 'error' });
    const data: unknown = await response.json();
    // The control protocol is a safe metadata-only projection. Never forward service
    // headers, raw logs or arbitrary non-JSON errors to the browser.
    return NextResponse.json(data, { status: response.status, headers });
  } catch {
    return NextResponse.json({ error: 'Routing service unavailable. The last applied policy is unchanged; refresh before retrying a change.' }, { status: 502, headers });
  }
}
export const GET = forward;
export const POST = forward;
