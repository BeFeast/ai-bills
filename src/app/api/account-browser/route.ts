import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { hasAllowedOrigin } from '@/lib/request-origin';
import { accountBrowser, AccountBrowserInputError, parseAccountBrowserInput } from '@/lib/account-browser';
import { requireTenant } from '@/lib/tenant';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
export async function GET(request: Request) {
  const { forbidden } = await requireTenant(); if (forbidden) return forbidden;
  try {
    const { selector } = parseAccountBrowserInput(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json(await accountBrowser(loadConfig(), selector), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const { forbidden } = await requireTenant(); if (forbidden) return forbidden;
  if (!hasAllowedOrigin(request)) return NextResponse.json({ error: 'Cross-origin account browser actions are not allowed' }, { status: 403, headers });
  try {
    const body = await request.text();
    if (body.length > 2048) throw new AccountBrowserInputError('Account browser request is too large');
    const { selector, action } = parseAccountBrowserInput(JSON.parse(body), true);
    const state = await accountBrowser(loadConfig(), selector, action);
    return NextResponse.json(state, { status: action === 'manage' && state.status !== 'ready' ? 409 : state.status === 'unavailable' ? 503 : 200, headers });
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  const input = error instanceof AccountBrowserInputError || error instanceof SyntaxError;
  return NextResponse.json({ error: input ? (error as Error).message : 'Account browser could not be accessed' }, { status: input ? 400 : 503, headers });
}
