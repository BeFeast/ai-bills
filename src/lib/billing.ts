import { readSnapshot, type Scope } from './storage';
import { loadConfig } from './config';
import type { AccountingOverview, Freshness } from './accounting';

export type Money = number | null;

export type BillingRow = Record<string, string | number | boolean | null>;
export type Sparkline = number[];

export type BillingBalance = {
  provider: string;
  balanceUsd: Money;
  spendPerHr?: Money;
  sparkline?: Sparkline;
};

export type BillingSubscription = {
  provider: string;
  plan: string;
  monthlyUsd: Money;
  verified?: string | null;
};

export type BillingPayment = {
  date: string;
  provider: string;
  amountUsd: Money;
  kind?: string | null;
  note?: string | null;
};

export type BillingOAuthHealth = {
  provider: string;
  account: string;
  status: string;
  okToday: number | null;
  failed: number | null;
};

export type BillingUpstreamUsage = {
  backend: string;
  tokens: number | null;
  estimatedUsd: Money;
  pricing: 'flat' | 'metered' | 'unknown';
};

export type BillingLight = {
  label: string;
  state: 'ok' | 'warn' | 'danger' | 'unknown';
  value?: string | null;
};

export type BillingDiagnostic = {
  level: 'info' | 'warn' | 'danger';
  message: string;
  source?: string;
};

/** Per-request token accounting from the ledger on the collector host (see runbook
 *  [[ai-usage-ledger]]). Unlike `meteredSpendTodayUsd`, this covers every
 *  client — proxied and direct — with real cache-aware token counts. */
export type BillingLedgerGroup = {
  name: string;
  apiEquivalentUsd: Money;
  marginalUsd: Money;
  tokens: number;
  requests: number;
};

export type BillingLedgerPoint = {
  date: string;
  apiEquivalentUsd: Money;
  marginalUsd: Money;
  tokens: number;
};

export type BillingLedger = {
  date: string;
  requests: number;
  failed: number;
  tokens: { inUncached: number; cacheRead: number; cacheWrite: number; outTotal: number };
  tokensTotal: number;
  /** What today's tokens would cost at provider list prices. */
  apiEquivalentUsd: Money;
  /** Estimated additional usage cost, never evidence of an actual debit. */
  marginalUsd: Money;
  byClient: BillingLedgerGroup[];
  byModel: BillingLedgerGroup[];
  byVia: BillingLedgerGroup[];
  /** model -> tokens seen with no verified price. Never silently counted as $0. */
  unpriced: Record<string, number>;
  trend: BillingLedgerPoint[];
};

export type BillingSummary = {
  monthlyFixedUsd: Money;
  paymentsThisMonthUsd: Money;
  meteredSpendTodayUsd: Money;
  estimatedSpendTrend?: Sparkline;
};

export type BillingSnapshot = {
  ok: boolean;
  generatedAt: string;
  source: string;
  month: string | null;
  summary: BillingSummary;
  lights: BillingLight[];
  balances: BillingBalance[];
  subscriptions: BillingSubscription[];
  oauthHealth: BillingOAuthHealth[];
  upstreamUsage: BillingUpstreamUsage[];
  ledger?: BillingLedger | null;
  payments: BillingPayment[];
  diagnostics: BillingDiagnostic[];
  accounting?: AccountingOverview;
  freshness?: Freshness[];
};

const SECRET_KEY_RE = /(token|secret|password|cookie|authorization|apikey|api_key|access[_-]?key|refresh[_-]?token|bearer|credential)/i;
const SUSPICIOUS_DAILY_USD = 1_000;
const DEFAULT_BILLING_FETCH_TIMEOUT_MS = 1_500;

export async function fetchBillingSnapshot(options: { url?: string; timeoutMs?: number; scope?: Scope } = {}): Promise<BillingSnapshot> {
  const config = loadConfig();
  const sourcePath = 'tenant snapshot';
  const timeoutMs = boundedTimeoutMs(options.timeoutMs ?? config.server.billing_fetch_timeout_ms);
  try {
    if (!options.url) {
      const read = await readSnapshot(config, options.scope);
      if (read.version === null) throw Object.assign(new Error('No snapshot has been received for this tenant yet'), { code: 'ENOENT' });
      return parseBillingSource(JSON.stringify(read.body), `${sourcePath} (${read.version})`);
    }
    const sourceUrl = options.url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(sourceUrl, { headers: { accept: 'application/json,text/html;q=0.9,*/*;q=0.1' }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return parseBillingSource(await response.text(), sourceUrl);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    const source = options.url || sourcePath || 'billing';
    return emptySnapshot(source, [{ level: 'danger', message: timedOut ? `Billing source timed out after ${timeoutMs}ms` : `Billing source unavailable: ${safeErrorMessage(error)}`, source: 'billing-fetch' }], false);
  }
}

export function parseBillingSource(source: string, sourceName = 'inline'): BillingSnapshot {
  const trimmed = source.trim();
  if (!trimmed) return malformedSnapshot(sourceName, 'Billing source is empty');
  try {
    const raw = JSON.parse(trimmed);
    if (looksLikeMaestroSnapshot(raw)) return normalizeMaestroSnapshot(raw, sourceName);
    return normalizeBillingSnapshot(raw, sourceName);
  } catch {
    if (looksLikeJson(trimmed)) return malformedSnapshot(sourceName, 'Malformed billing source: invalid JSON');
    if (!looksLikeAiBillHtml(trimmed)) return malformedSnapshot(sourceName, 'Malformed billing source: expected ai-bill HTML or JSON snapshot');
    return parseAiBillHtml(trimmed, sourceName);
  }
}

/**
 * Raw snapshot.json pushed by maestro (ai-bill-collect.sh):
 * { generated, runpod: { clientBalance, currentSpendPerHr }, vast: { credit },
 *   proxy_auths, proxy_usage, maestro_cost_today, providers, payments }
 */
export function normalizeMaestroSnapshot(rawInput: unknown, source = 'maestro'): BillingSnapshot {
  const raw = sanitizeRecursive(rawInput) as Record<string, unknown>;
  if (!asRecord(raw)) return malformedSnapshot(source, 'Malformed billing source: JSON root must be an object');
  const generatedAt = firstString(raw.generated, raw.generatedAt, raw.generated_at, raw.timestamp, raw.updatedAt, raw.updated_at) || new Date().toISOString();
  const month = firstString(raw.month, raw.billingMonth, raw.billing_month) || inferMonth(generatedAt);

  const runpodRaw = asRecord(raw.runpod);
  const vastRaw = asRecord(raw.vast);
  const balances: BillingBalance[] = [];
  if (runpodRaw) {
    balances.push({
      provider: 'RunPod',
      balanceUsd: money(firstValue(runpodRaw.clientBalance, runpodRaw.client_balance, runpodRaw.balanceUsd, runpodRaw.balance)),
      spendPerHr: money(firstValue(runpodRaw.currentSpendPerHr, runpodRaw.current_spend_per_hr, runpodRaw.spendPerHr)),
    });
  }
  if (vastRaw) {
    balances.push({
      provider: 'Vast.ai',
      balanceUsd: money(firstValue(vastRaw.credit, vastRaw.balanceUsd, vastRaw.balance)),
    });
  }

  const oauthHealth = normalizeOAuth(firstArray(raw.proxy_auths, raw.oauthHealth, raw.oauth));

  const upstreamUsage = firstArray(raw.maestro_cost_today, raw.upstreamUsage, raw.upstreams)
    .map(asRecord)
    .filter(Boolean)
    .map((r): BillingUpstreamUsage => {
      const estimatedUsd = money(firstValue(r!.est_usd_today, r!.estimatedUsd, r!.estimated_usd, r!.estUsd, r!.costUsd, r!.cost_usd));
      return {
        backend: text(firstValue(r!.backend, r!.name, r!.provider)),
        tokens: int(firstValue(r!.tokens_today, r!.tokens, r!.token_count)),
        estimatedUsd,
        pricing: boolish(firstValue(r!.flat, r!.isFlat)) ? 'flat' : estimatedUsd === 0 ? 'flat' : 'metered',
      };
    })
    .filter((r) => r.backend);

  const providerRows = firstArray(raw.providers, raw.subscriptions).map(asRecord).filter(Boolean);
  const subscriptions: BillingSubscription[] = providerRows
    .map((r) => ({
      provider: text(firstValue(r!.provider, r!.name)),
      plan: text(firstValue(r!.plan, r!.billing, r!.subscription)),
      monthlyUsd: money(firstValue(r!.cost_usd_month, r!.monthlyUsd, r!.monthly_usd, r!.usd, r!.amount)),
      verified: optionalText(firstValue(r!.verified, r!.verifiedAt, r!.verified_at)),
    }))
    .filter((r) => r.provider);
  const monthlyFixedUsd = sumMoney(
    providerRows
      .filter((r) => String(firstValue(r!.billing, r!.plan) ?? '').toLowerCase().startsWith('subscription'))
      .map((r) => money(firstValue(r!.cost_usd_month, r!.monthlyUsd, r!.monthly_usd))),
  );

  const payments = normalizePayments(firstArray(raw.payments, raw.paymentsLog, raw.payment_log));
  const paymentsThisMonthUsd = sumMoney(payments.filter((p) => p.date?.startsWith(month || '')).map((p) => p.amountUsd));
  const meteredSpendTodayUsd = sumMoney(upstreamUsage.map((u) => u.estimatedUsd));

  const lights = normalizeLights(firstArray(raw.lights, raw.statusLights, raw.status));
  const diagnostics = normalizeDiagnostics(firstArray(raw.diagnostics, raw.validation, raw.warnings));
  appendQualityDiagnostics(diagnostics, { meteredSpendTodayUsd, upstreamUsage });
  return {
    ok: true,
    generatedAt,
    source,
    month,
    summary: {
      monthlyFixedUsd,
      paymentsThisMonthUsd,
      meteredSpendTodayUsd,
      estimatedSpendTrend: numberArray(firstValue(raw.estimatedSpendTrend, raw.estimated_spend_trend)),
    },
    ledger: parseLedger(raw.usage_ledger),
    lights,
    balances,
    subscriptions,
    oauthHealth,
    upstreamUsage,
    payments,
    diagnostics,
  };
}

export function normalizeBillingSnapshot(rawInput: unknown, source = 'json'): BillingSnapshot {
  const raw = sanitizeRecursive(rawInput) as Record<string, unknown>;
  if (!asRecord(raw)) return malformedSnapshot(source, 'Malformed billing source: JSON root must be an object');
  const generatedAt = firstString(raw.generatedAt, raw.generated_at, raw.timestamp, raw.updatedAt, raw.updated_at) || new Date().toISOString();
  const month = firstString(raw.month, raw.billingMonth, raw.billing_month) || inferMonth(generatedAt);
  const summaryRaw = asRecord(raw.summary) || asRecord(raw.monthSummary) || raw;
  const subscriptions = normalizeSubscriptions(firstArray(raw.subscriptions, raw.providerSubscriptions, raw.provider_cards, raw.cards));
  const payments = normalizePayments(firstArray(raw.payments, raw.paymentsLog, raw.payment_log));
  const upstreamUsage = normalizeUpstreams(firstArray(raw.upstreamUsage, raw.upstreams, raw.meteredUpstreams, raw.maestro, raw.backends));
  const balances = normalizeBalances(firstArray(raw.balances, raw.providerBalances));
  const oauthHealth = normalizeOAuth(firstArray(raw.oauthHealth, raw.oauth, raw.cliProxy, raw.cliproxy));
  const monthlyFixedUsd = money(firstValue(summaryRaw.monthlyFixedUsd, summaryRaw.monthly_fixed_usd, summaryRaw.fixedSubscriptionsUsd, summaryRaw.fixed_subscriptions_usd)) ?? sumMoney(subscriptions.map((s) => s.monthlyUsd));
  const paymentsThisMonthUsd = money(firstValue(summaryRaw.paymentsThisMonthUsd, summaryRaw.payments_this_month_usd, summaryRaw.paymentsLoggedThisMonthUsd)) ?? sumMoney(payments.filter((p) => p.date?.startsWith(month || '')).map((p) => p.amountUsd));
  const meteredSpendTodayUsd = money(firstValue(summaryRaw.meteredSpendTodayUsd, summaryRaw.metered_spend_today_usd, summaryRaw.maestroEstimatedSpendTodayUsd, summaryRaw.maestro_est_spend_today_usd)) ?? sumMoney(upstreamUsage.map((u) => u.estimatedUsd));
  const lights = normalizeLights(firstArray(raw.lights, raw.statusLights, raw.status));
  const diagnostics = normalizeDiagnostics(firstArray(raw.diagnostics, raw.validation, raw.warnings));
  appendQualityDiagnostics(diagnostics, { meteredSpendTodayUsd, upstreamUsage });
  return {
    ok: true,
    generatedAt,
    source,
    month,
    summary: {
      monthlyFixedUsd,
      paymentsThisMonthUsd,
      meteredSpendTodayUsd,
      estimatedSpendTrend: numberArray(firstValue(summaryRaw.estimatedSpendTrend, summaryRaw.estimated_spend_trend, raw.estimatedSpendTrend)),
    },
    lights,
    balances,
    subscriptions,
    oauthHealth,
    upstreamUsage,
    payments,
    diagnostics,
  };
}

export function parseAiBillHtml(html: string, source = 'html'): BillingSnapshot {
  const generatedAt = decode(firstMatch(html, /<h1>\s*AI Billing\s*<span[^>]*>[^0-9]*(\d{4}-\d{2}-\d{2}T[^<]+)<\/span>/i)) || new Date().toISOString();
  const month = decode(firstMatch(html, /<h2>\s*Month\s+([^<]+)<\/h2>/i)) || inferMonth(generatedAt);
  const diagnostics: BillingDiagnostic[] = [];
  const lights = parseLights(html);
  const monthTable = sectionTable(html, `Month ${escapeRe(month || '')}`) || '';
  const summary: BillingSummary = {
    monthlyFixedUsd: money(cellAfterHeader(monthTable, 'Fixed subscriptions')),
    paymentsThisMonthUsd: money(cellAfterHeader(monthTable, 'Payments logged this month')),
    meteredSpendTodayUsd: money(cellAfterHeader(monthTable, 'Maestro est. spend today')),
    estimatedSpendTrend: svgPolylineValues(cellAfterHeader(monthTable, 'Est. spend, 30d trend') || ''),
  };
  const balances = parseBalances(sectionTable(html, 'Balances') || '');
  const subscriptions = parseSubscriptions(sectionTable(html, 'Subscriptions') || '');
  const oauthHealth = parseOAuth(sectionTable(html, 'OAuth subscription health') || '');
  const upstreamUsage = parseUpstreams(sectionTable(html, 'Metered upstreams today') || '');
  const payments = parsePayments(sectionTable(html, 'Payments log') || '');
  appendQualityDiagnostics(diagnostics, { meteredSpendTodayUsd: summary.meteredSpendTodayUsd, upstreamUsage });
  return { ok: true, generatedAt, source, month, summary, lights, balances, subscriptions, oauthHealth, upstreamUsage, payments, diagnostics };
}

export function sanitizeRecursive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRecursive);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactSecretString(value) : value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Numeric values under secret-ish keys are counters (tokens_today, token_count), never credentials — keep them.
    out[key] = SECRET_KEY_RE.test(key) && typeof item !== 'number' ? '[redacted]' : sanitizeRecursive(item);
  }
  return out;
}

function looksLikeMaestroSnapshot(raw: unknown): boolean {
  const r = asRecord(raw);
  if (!r) return false;
  return asRecord(raw ? r.runpod : null) !== null
    || asRecord(r.vast) !== null
    || Array.isArray(r.proxy_auths)
    || Array.isArray(r.maestro_cost_today)
    || (typeof r.generated === 'string' && Array.isArray(r.providers));
}

function normalizeSubscriptions(rows: unknown[]): BillingSubscription[] {
  return rows.map(asRecord).filter(Boolean).map((r) => ({ provider: text(firstValue(r!.provider, r!.name)), plan: text(firstValue(r!.plan, r!.subscription)), monthlyUsd: money(firstValue(r!.monthlyUsd, r!.monthly_usd, r!.usd, r!.amount)), verified: optionalText(firstValue(r!.verified, r!.verifiedAt, r!.verified_at)) })).filter((r) => r.provider);
}
function normalizePayments(rows: unknown[]): BillingPayment[] {
  return rows.map(asRecord).filter(Boolean).map((r) => ({ date: text(firstValue(r!.date, r!.paidAt, r!.paid_at)), provider: text(firstValue(r!.provider, r!.name)), amountUsd: money(firstValue(r!.amountUsd, r!.amount_usd, !r!.currency || String(r!.currency).toUpperCase() === 'USD' ? r!.amount : null)), kind: optionalText(r!.kind), note: optionalText(firstValue(r!.note, r!.description)) })).filter((r) => r.date || r.provider);
}
function normalizeUpstreams(rows: unknown[]): BillingUpstreamUsage[] {
  return rows.map(asRecord).filter(Boolean).map((r): BillingUpstreamUsage => ({ backend: text(firstValue(r!.backend, r!.name, r!.provider)), tokens: int(firstValue(r!.tokens, r!.token_count)), estimatedUsd: money(firstValue(r!.estimatedUsd, r!.estimated_usd, r!.estUsd, r!.costUsd, r!.cost_usd)), pricing: boolish(firstValue(r!.flat, r!.isFlat)) ? 'flat' : money(firstValue(r!.estimatedUsd, r!.estimated_usd, r!.estUsd, r!.costUsd, r!.cost_usd)) === 0 ? 'flat' : 'metered' })).filter((r) => r.backend);
}
function normalizeBalances(rows: unknown[]): BillingBalance[] {
  return rows.map(asRecord).filter(Boolean).map((r) => ({ provider: text(firstValue(r!.provider, r!.name)), balanceUsd: money(firstValue(r!.balanceUsd, r!.balance_usd, r!.balance, r!.now)), sparkline: numberArray(firstValue(r!.sparkline, r!.trend)) })).filter((r) => r.provider);
}
function normalizeOAuth(rows: unknown[]): BillingOAuthHealth[] {
  return rows.map(asRecord).filter(Boolean).map((r) => ({ provider: text(firstValue(r!.provider, r!.name)), account: text(firstValue(r!.account, r!.email)), status: text(r!.status), okToday: int(firstValue(r!.okToday, r!.ok_today, r!.ok)), failed: int(firstValue(r!.failed, r!.failures)) })).filter((r) => r.provider || r.account);
}
function normalizeLights(rows: unknown[]): BillingLight[] {
  return rows.map(asRecord).filter(Boolean).map((r) => ({ label: text(firstValue(r!.label, r!.provider, r!.name)), state: lightState(firstValue(r!.state, r!.status, r!.level)), value: optionalText(firstValue(r!.value, r!.balance, r!.note)) })).filter((r) => r.label);
}
function normalizeDiagnostics(rows: unknown[]): BillingDiagnostic[] {
  return rows
    .map((row) => (typeof row === 'string' ? { level: 'warn' as const, message: row } : asRecord(row)))
    .filter(Boolean)
    .map((r): BillingDiagnostic => {
      const rec = r as Record<string, unknown>;
      return { level: diagnosticLevel(firstValue(rec.level, rec.severity)), message: text(firstValue(rec.message, rec.note) ?? r), source: optionalText(rec.source) || undefined };
    });
}

function parseRows(table: string): string[][] {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decode(stripTags(c[1])).trim())).filter((r) => r.length);
}
function parseBalances(table: string): BillingBalance[] { return parseRows(table).slice(1).map((r) => ({ provider: r[0] || '', balanceUsd: money(r[1]), sparkline: svgPolylineValues(rowHtml(table, r[0] || '')) })).filter((r) => r.provider); }
function parseSubscriptions(table: string): BillingSubscription[] { return parseRows(table).slice(1).map((r) => ({ provider: r[0] || '', plan: r[1] || '', monthlyUsd: money(r[2]), verified: r[3] || null })).filter((r) => r.provider); }
function parseOAuth(table: string): BillingOAuthHealth[] { return parseRows(table).slice(1).map((r) => ({ provider: r[0] || '', account: r[1] || '', status: r[2] || '', okToday: int(r[3]), failed: int(r[4]) })).filter((r) => r.provider); }
function parseUpstreams(table: string): BillingUpstreamUsage[] { return parseRows(table).slice(1).map((r): BillingUpstreamUsage => ({ backend: (r[0] || '').replace(/\s*\(flat\)\s*$/, ''), tokens: int(r[1]), estimatedUsd: money(r[2]), pricing: /\(flat\)/.test(r[0] || '') ? 'flat' : 'metered' })).filter((r) => r.backend); }
function parsePayments(table: string): BillingPayment[] { return parseRows(table).slice(1).map((r) => ({ date: r[0] || '', provider: r[1] || '', amountUsd: money(r[2]), kind: r[3] || null, note: r[4] || null })).filter((r) => r.date || r.provider); }
function parseLights(html: string): BillingLight[] {
  const p = firstMatch(html, /<p class="lights">([\s\S]*?)<\/p>/i) || '';
  return [...p.matchAll(/<span class="item">\s*<span[^>]*style="color:([^";]+)[^>]*>●<\/span>\s*([^<]+)<\/span>/gi)].map((m) => ({ label: decode(m[2]).trim(), state: colorState(m[1]) }));
}

function sectionTable(html: string, title: string): string | null {
  const re = new RegExp(`<h2[^>]*>\\s*${title}[\\s\\S]*?<\\/h2>\\s*(<table[\\s\\S]*?<\\/table>)`, 'i');
  return firstMatch(html, re);
}
function cellAfterHeader(table: string, label: string): string | null {
  const row = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].find((m) => stripTags(m[1]).includes(label));
  return row ? firstMatch(row[1], /<td[^>]*>([\s\S]*?)<\/td>/i) : null;
}
function rowHtml(table: string, needle: string): string {
  const row = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].find((m) => stripTags(m[1]).includes(needle));
  return row ? row[1] : '';
}
function svgPolylineValues(fragment: string): number[] | undefined {
  const points = firstMatch(fragment, /points="([^"]+)"/i);
  if (!points) return undefined;
  return points.trim().split(/\s+/).map((p) => Number(p.split(',')[1])).filter(Number.isFinite);
}

function ledgerGroups(value: unknown): BillingLedgerGroup[] {
  return (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter(Boolean)
    .map((r) => ({
      name: text(r!.name),
      apiEquivalentUsd: money(r!.api_equivalent_usd),
      marginalUsd: money(r!.marginal_usd),
      tokens: int(r!.tokens) ?? 0,
      requests: int(r!.requests) ?? 0,
    }))
    .filter((g) => g.name);
}

/** Shape produced by `ai-usage-report --rollup` on the collector host. Absent or malformed
 *  input yields null so the UI can say "no ledger" instead of showing zeroes. */
function parseLedger(value: unknown): BillingLedger | null {
  const root = asRecord(value);
  const today = asRecord(root?.today);
  if (!today) return null;
  // NB: sanitizeRecursive() redacts non-numeric values under any key matching
  // SECRET_KEY_RE, which includes /token/. The rollup therefore ships this
  // breakdown as `counts` — an object named `tokens` (or `token_mix`) would
  // arrive as the string '[redacted]' and silently parse to zeroes.
  const tk = asRecord(today.counts) || {};
  const unpricedRaw = asRecord(today.unpriced) || {};
  const unpriced: Record<string, number> = {};
  for (const [model, tokens] of Object.entries(unpricedRaw)) {
    const n = int(tokens);
    if (n) unpriced[model] = n;
  }
  return {
    date: text(today.date),
    requests: int(today.requests) ?? 0,
    failed: int(today.failed) ?? 0,
    tokens: {
      inUncached: int(tk.in_uncached) ?? 0,
      cacheRead: int(tk.cache_read) ?? 0,
      cacheWrite: int(tk.cache_write) ?? 0,
      outTotal: int(tk.out_total) ?? 0,
    },
    tokensTotal: int(today.tokens_total) ?? 0,
    apiEquivalentUsd: money(today.api_equivalent_usd),
    marginalUsd: money(today.marginal_usd),
    byClient: ledgerGroups(today.by_client),
    byModel: ledgerGroups(today.by_model),
    byVia: ledgerGroups(today.by_via),
    unpriced,
    trend: (Array.isArray(root?.trend) ? root!.trend : [])
      .map(asRecord)
      .filter(Boolean)
      .map((r) => ({
        date: text(r!.date),
        apiEquivalentUsd: money(r!.api_equivalent_usd),
        marginalUsd: money(r!.marginal_usd),
        tokens: int(r!.tokens) ?? 0,
      })),
  };
}

function appendQualityDiagnostics(diags: BillingDiagnostic[], input: { meteredSpendTodayUsd: Money; upstreamUsage: BillingUpstreamUsage[] }) {
  if (typeof input.meteredSpendTodayUsd === 'number' && input.meteredSpendTodayUsd > SUSPICIOUS_DAILY_USD) {
    diags.push({ level: 'warn', message: `Suspicious metered daily estimate: $${input.meteredSpendTodayUsd.toFixed(2)}/day. Treat as data-quality validation, not confirmed spend.`, source: 'maestro-estimate' });
  }
  for (const upstream of input.upstreamUsage) {
    if (typeof upstream.estimatedUsd === 'number' && upstream.estimatedUsd > SUSPICIOUS_DAILY_USD) diags.push({ level: 'warn', message: `Suspicious upstream estimate for ${upstream.backend}: $${upstream.estimatedUsd.toFixed(2)}`, source: 'upstream-usage' });
  }
}
export function emptySnapshot(source: string, diagnostics: BillingDiagnostic[], ok = true): BillingSnapshot {
  const now = new Date().toISOString();
  return { ok, generatedAt: now, source, month: inferMonth(now), summary: { monthlyFixedUsd: null, paymentsThisMonthUsd: null, meteredSpendTodayUsd: null }, lights: [], balances: [], subscriptions: [], oauthHealth: [], upstreamUsage: [], payments: [], diagnostics };
}
function malformedSnapshot(source: string, message: string): BillingSnapshot { return emptySnapshot(source, [{ level: 'danger', message, source: 'malformed-source' }], false); }
function looksLikeJson(source: string) { return /^[{[]/.test(source); }
function looksLikeAiBillHtml(source: string) { return /<h1[^>]*>\s*AI Billing\b/i.test(source) && /<h2[^>]*>\s*Month\s+[^<]+<\/h2>/i.test(source); }
function boundedTimeoutMs(timeoutMs: number) { return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.max(Math.round(timeoutMs), 100), 30_000) : DEFAULT_BILLING_FETCH_TIMEOUT_MS; }
function safeErrorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function firstArray(...values: unknown[]) { return (values.find(Array.isArray) as unknown[]) || []; }
function firstString(...values: unknown[]) { return values.find((v) => typeof v === 'string' && v.trim()) as string | undefined; }
function firstValue(...values: unknown[]) { return values.find((v) => v !== undefined && v !== null && v !== ''); }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null; }
function text(v: unknown) { return optionalText(v) || ''; }
function optionalText(v: unknown) { return v === undefined || v === null ? null : redactSecretString(String(v)); }
function money(v: unknown): Money { if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v !== 'string') return null; const n = Number(v.replace(/[$,]/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]); return Number.isFinite(n) ? n : null; }
function int(v: unknown): number | null { if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v); if (typeof v !== 'string') return null; const n = Number(v.replace(/,/g, '').match(/-?\d+/)?.[0]); return Number.isFinite(n) ? n : null; }
function numberArray(v: unknown): number[] | undefined { return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : undefined; }
function sumMoney(values: Money[]): Money { const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)); return nums.length ? Number(nums.reduce((a, b) => a + b, 0).toFixed(2)) : null; }
function inferMonth(iso: string | null) { const d = new Date(iso || ''); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7); }
function stripTags(s: string) { return s.replace(/<[^>]*>/g, ' '); }
function decode(s: string | null | undefined) { return (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' '); }
function firstMatch(s: string, re: RegExp) { return s.match(re)?.[1] || null; }
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function lightState(v: unknown): BillingLight['state'] { const s = String(v || '').toLowerCase(); if (s.includes('ok') || s.includes('active') || s.includes('green')) return 'ok'; if (s.includes('warn') || s.includes('yellow')) return 'warn'; if (s.includes('danger') || s.includes('error') || s.includes('red')) return 'danger'; return 'unknown'; }
function colorState(color: string): BillingLight['state'] { const c = color.toLowerCase(); if (c.includes('9ece6a') || c.includes('green')) return 'ok'; if (c.includes('e0af68') || c.includes('yellow') || c.includes('orange')) return 'warn'; if (c.includes('f7768e') || c.includes('red')) return 'danger'; return 'unknown'; }
function diagnosticLevel(v: unknown): BillingDiagnostic['level'] { const s = String(v || '').toLowerCase(); if (s.includes('danger') || s.includes('error')) return 'danger'; if (s.includes('warn')) return 'warn'; return 'info'; }
function boolish(v: unknown) { return v === true || String(v).toLowerCase() === 'true'; }
function redactSecretString(s: string) { return s.replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[redacted]').replace(/(sk-[a-z0-9_-]{8})[a-z0-9_-]+/gi, '$1…[redacted]'); }
