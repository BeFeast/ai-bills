import { NextResponse } from 'next/server';
import { sourceHealth } from '@/lib/source-health';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(sourceHealth(), { headers: { 'cache-control': 'no-store' } });
}
