import { NextResponse } from 'next/server';
import { getUsageResponse } from '@/lib/usage-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get('refresh') === '1';
  try {
    const body = await getUsageResponse(force);
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
