import { loadConfig } from './config';
import { resolveSecret } from './infisical';
import type { BillingDiagnostic } from './billing';

/**
 * Live balance probes for metered providers. These hit the provider APIs
 * directly (RunPod GraphQL, Vast.ai REST) so the dashboard can override the
 * potentially stale balances baked into the maestro snapshot.
 *
 * Failure isolation: each provider is probed independently; a failure yields
 * a null balance plus a diagnostic, never a thrown error.
 */

export type LiveRunpodBalance = {
  balanceUsd: number | null;
  spendPerHr: number | null;
};

export type LiveVastBalance = {
  balanceUsd: number | null;
};

export type LiveBalances = {
  runpod: LiveRunpodBalance | null;
  vast: LiveVastBalance | null;
  diagnostics: BillingDiagnostic[];
};

const RUNPOD_GRAPHQL_URL = 'https://api.runpod.io/graphql';
const RUNPOD_BALANCE_QUERY = 'query { myself { clientBalance currentSpendPerHr } }';
const VAST_CURRENT_USER_URL = 'https://console.vast.ai/api/v0/users/current/';
const LIVE_BALANCE_TIMEOUT_MS = 15_000;

export async function fetchLiveBalances(): Promise<LiveBalances> {
  const config = loadConfig();
  const [runpod, vast] = await Promise.all([
    probe('RunPod', () => fetchRunpodBalance(config.secrets.runpod_api_key)),
    probe('Vast.ai', () => fetchVastBalance(config.secrets.vast_api_key)),
  ]);
  return {
    runpod: runpod.result,
    vast: vast.result,
    diagnostics: [...runpod.diagnostics, ...vast.diagnostics],
  };
}

type ProbeOutcome<T> = { result: T | null; diagnostics: BillingDiagnostic[] };

async function probe<T>(provider: string, fn: () => Promise<T>): Promise<ProbeOutcome<T>> {
  try {
    return { result: await fn(), diagnostics: [] };
  } catch (error) {
    return {
      result: null,
      diagnostics: [{ level: 'warn', message: `${provider} live balance unavailable: ${errorMessage(error)}`, source: 'live-balances' }],
    };
  }
}

async function fetchRunpodBalance(secretRef: Parameters<typeof resolveSecret>[0]): Promise<LiveRunpodBalance> {
  const apiKey = await resolveSecret(secretRef);
  if (!apiKey) throw new Error('runpod_api_key secret not configured');
  const response = await fetchWithTimeout(RUNPOD_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query: RUNPOD_BALANCE_QUERY }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const body = (await response.json()) as {
    data?: { myself?: { clientBalance?: unknown; currentSpendPerHr?: unknown } | null } | null;
    errors?: { message?: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message || 'GraphQL error').join('; '));
  const myself = body.data?.myself;
  if (!myself) throw new Error('RunPod response missing data.myself');
  return {
    balanceUsd: toNumber(myself.clientBalance),
    spendPerHr: toNumber(myself.currentSpendPerHr),
  };
}

async function fetchVastBalance(secretRef: Parameters<typeof resolveSecret>[0]): Promise<LiveVastBalance> {
  const apiKey = await resolveSecret(secretRef);
  if (!apiKey) throw new Error('vast_api_key secret not configured');
  const response = await fetchWithTimeout(VAST_CURRENT_USER_URL, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  // Vast returns both `credit` (prepaid balance used by the collector) and
  // `balance` (often 0 when billing_creditonly). Prefer credit, same as maestro snapshot.
  const body = (await response.json()) as { credit?: unknown; balance?: unknown; balanceUsd?: unknown };
  const balanceUsd = toNumber(body.credit) ?? toNumber(body.balanceUsd) ?? toNumber(body.balance);
  if (balanceUsd === null) throw new Error('Vast response missing credit/balance');
  return { balanceUsd };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_BALANCE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`timed out after ${LIVE_BALANCE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
