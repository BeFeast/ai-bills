import { NextResponse } from 'next/server';
import { emptySnapshot, fetchBillingSnapshot, type BillingBalance, type BillingSnapshot } from '@/lib/billing';
import { fetchLiveBalances } from '@/lib/balances';
import { readSeries, recordHistory } from '@/lib/history';
import { loadConfig } from '@/lib/config';
import { accountingOverview, currentMonth, freshness } from '@/lib/accounting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET() {
  try {
    const snapshot = await fetchBillingSnapshot();
    const config = loadConfig();
    snapshot.accounting = await accountingOverview(config.accounting, currentMonth(config.server.timezone));
    snapshot.freshness = [freshness('billing-snapshot', snapshot.generatedAt, 300), ...snapshot.accounting.coverage];
    for (const source of snapshot.freshness.filter(row => row.status !== 'fresh')) {
      snapshot.diagnostics.push({ level: 'warn', source: source.id, message: source.message });
    }

    // Live provider balances override the (possibly stale) snapshot balances.
    const live = await fetchLiveBalances();
    if (live.runpod && live.runpod.balanceUsd !== null) {
      upsertBalance(snapshot, 'RunPod', { balanceUsd: live.runpod.balanceUsd, spendPerHr: live.runpod.spendPerHr });
    }
    if (live.vast && live.vast.balanceUsd !== null) {
      upsertBalance(snapshot, 'Vast.ai', { balanceUsd: live.vast.balanceUsd });
    }
    snapshot.diagnostics.push(...live.diagnostics);

    // Sparklines from local history.
    const [runpodSeries, vastSeries, estSeries] = await Promise.all([
      readSeries('runpod'),
      readSeries('vast'),
      readSeries('est_usd_today'),
    ]);
    attachSparkline(snapshot, 'runpod', runpodSeries);
    attachSparkline(snapshot, 'vast', vastSeries);
    if (!snapshot.summary.estimatedSpendTrend?.length && estSeries.length) {
      snapshot.summary.estimatedSpendTrend = estSeries;
    }

    // Record this sample (after the live overlay so history tracks live values).
    const historyError = await recordHistory(snapshot);
    if (historyError) {
      snapshot.diagnostics.push({ level: 'warn', message: historyError, source: 'billing-history' });
    }

    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const snapshot = emptySnapshot(
      'billing-api',
      [{ level: 'danger', message: `Billing API error: ${message}`, source: 'billing-api' }],
      false,
    );
    // HTTP 200 with ok:false — the dashboard must keep rendering.
    return NextResponse.json(snapshot, { headers: NO_STORE });
  }
}

function upsertBalance(snapshot: BillingSnapshot, provider: string, patch: Partial<BillingBalance>) {
  const existing = snapshot.balances.find((b) => b.provider.toLowerCase() === provider.toLowerCase());
  if (existing) {
    Object.assign(existing, patch);
  } else {
    snapshot.balances.push({ provider, balanceUsd: null, ...patch });
  }
}

function attachSparkline(snapshot: BillingSnapshot, match: string, series: number[]) {
  if (!series.length) return;
  const entry = snapshot.balances.find((b) => b.provider.toLowerCase().includes(match));
  if (entry) entry.sparkline = series;
}
