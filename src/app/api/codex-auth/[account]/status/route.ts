import { NextResponse } from 'next/server';
import { codexAuthManager } from '@/lib/codex-auth';
import { requireTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ account: string }> }) {
  const { forbidden } = await requireTenant(); if (forbidden) return forbidden;
  const { account } = await params;
  const accountKey = decodeURIComponent(account);
  try {
    return NextResponse.json(await codexAuthManager.status(accountKey));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
