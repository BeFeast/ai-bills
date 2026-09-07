/** Metadata-only protocol; provider credentials remain in the request service. */
export type RoutingModel = { id: string; label: string; status: 'approved' | 'hidden' | 'denied'; capabilities: string[]; input_limit_tokens: number | null; output_limit_tokens: number | null; prices: Record<string, number | null> | null; routes: { account_id: string; billing: 'included' | 'paid'; upstream_model: string; prices?: Record<string, number | null> | null; price_version?: string; price_evidence?: string }[] };
export type RoutingPolicy = { version: number; day_limit_microusd: number; timezone: string; models: RoutingModel[]; roles: { id: string; candidates: string[] }[]; clients: { id: string; models: string[]; roles: string[] }[]; accounts: { id: string; label: string; enabled: boolean }[] };
export type RoutingRequest = { id: string; session_id: string | null; client_id: string; role: string | null; requested_model: string; model: string | null; account_id: string | null; status: string; admitted_date: string; reserved_microusd: number; cost_microusd: number | null; fallback_reason: string | null; created_at: string };
export type RoutingSuggestion = { id: string; title?: string; reason?: string; status?: string; created_at?: string; proposed_policy?: RoutingPolicy };
export type RoutingState = { policy: RoutingPolicy; budget: { date: string; limit_microusd: number; spent_microusd: number; reserved_microusd: number }; requests: RoutingRequest[]; suggestions: RoutingSuggestion[]; capabilities: { native_managed_attempt: boolean } };
export type Validation = { valid: boolean; errors: string[]; diff?: unknown };

export async function routingRequest<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`/api/routing/${path}`, { cache: 'no-store', ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : typeof data.error?.message === 'string' ? data.error.message : response.status === 409 ? 'Policy changed elsewhere. Reload the latest version before applying.' : `Routing request failed (${response.status})`);
  return data as T;
}

export function policyChanges(active: RoutingPolicy, draft: RoutingPolicy): string[] {
  const changes: string[] = [];
  if (active.day_limit_microusd !== draft.day_limit_microusd) changes.push(`Daily allowance: ${active.day_limit_microusd / 1e6} → ${draft.day_limit_microusd / 1e6} USD`);
  if (active.timezone !== draft.timezone) changes.push(`Budget timezone: ${active.timezone} → ${draft.timezone}`);
  for (const model of draft.models) {
    const old = active.models.find((row) => row.id === model.id);
    if (!old) { changes.push(`Add model ${model.label} (${model.id})`); continue; }
    if (old.status !== model.status) changes.push(`${model.label}: ${old.status} → ${model.status}${model.status === 'hidden' ? ' (new sessions only)' : model.status === 'denied' ? ' (all subsequent requests)' : ''}`);
    if (old.label !== model.label) changes.push(`Rename ${model.id}: ${old.label} → ${model.label}`);
    if (JSON.stringify({ ...old, label: model.label, status: model.status }) !== JSON.stringify(model)) changes.push(`${model.id}: route, capability or pricing metadata changed`);
  }
  for (const model of active.models) if (!draft.models.some((row) => row.id === model.id)) changes.push(`Remove model ${model.id}`);
  for (const kind of ['roles', 'clients', 'accounts'] as const) {
    const oldRows = active[kind]; const newRows = draft[kind];
    for (const row of newRows) {
      const old = oldRows.find((item) => item.id === row.id);
      if (JSON.stringify(old) !== JSON.stringify(row)) changes.push(`${old ? 'Update' : 'Add'} ${kind.slice(0, -1)} ${row.id}: ${JSON.stringify(row)}`);
    }
    for (const row of oldRows) if (!newRows.some((item) => item.id === row.id)) changes.push(`Remove ${kind.slice(0, -1)} ${row.id}`);
  }
  return changes;
}

export function reorderCandidate(candidates: string[], index: number, direction: -1 | 1): string[] {
  const target = index + direction;
  if (index < 0 || index >= candidates.length || target < 0 || target >= candidates.length) return [...candidates];
  const result = [...candidates];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}

export function remainingAllowance(budget: RoutingState['budget']): number {
  return Math.max(0, budget.limit_microusd - budget.spent_microusd - budget.reserved_microusd);
}
