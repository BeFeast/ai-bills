import { NextResponse } from 'next/server';
import { alertsReport } from '@/lib/alerts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return NextResponse.json(await alertsReport(), { headers: { 'cache-control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'Alerts unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
}
