import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../src/app/api/routing/[...path]/route';
import { policyChanges, remainingAllowance, reorderCandidate, routingRequest, type RoutingPolicy } from '../src/lib/routing-client';

const policy = (): RoutingPolicy => ({ version: 1, day_limit_microusd: 2_000_000, timezone: 'UTC', accounts: [{ id: 'included-account', label: 'Included account', enabled: true }], models: [{ id: 'model-a', label: 'Model A', status: 'approved', capabilities: ['chat'], input_limit_tokens: 1000, output_limit_tokens: 1000, prices: { input: null, output: null }, routes: [{ account_id: 'included-account', billing: 'included', upstream_model: 'provider-a' }] }], roles: [{ id: 'coding', candidates: ['model-a'] }], clients: [{ id: 'editor', models: ['model-a'], roles: ['coding'] }] });

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('reviewable policy changes', () => {
  it('distinguishes hide from deny and catches client authorization changes', () => {
    const current = policy(); const draft = structuredClone(current);
    draft.models[0].status = 'hidden';
    expect(policyChanges(current, draft)).toContain('Model A: approved → hidden (new sessions only)');
    draft.models[0].status = 'denied'; draft.clients[0].models = [];
    const diff = policyChanges(current, draft).join('\n');
    expect(diff).toContain('all subsequent requests');
    expect(diff).toContain('Update client editor');
    expect(current.models[0].status).toBe('approved');
  });
  it('does not omit changed upstream routing or prices from review', () => {
    const current = policy(); const draft = structuredClone(current);
    draft.models[0].routes[0].billing = 'paid'; draft.models[0].prices!.input = 1000;
    expect(policyChanges(current, draft)).toContain('model-a: route, capability or pricing metadata changed');
  });
  it('reorders role candidates without changing membership or crossing boundaries', () => {
    const input = ['a', 'b', 'c'];
    expect(reorderCandidate(input, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(reorderCandidate(input, 2, 1)).toEqual(input);
    expect(input).toEqual(['a', 'b', 'c']);
  });
  it('deducts unresolved reservations from available allowance and never shows negative availability', () => {
    expect(remainingAllowance({ date: '2026-01-01', limit_microusd: 2_000_000, spent_microusd: 250_000, reserved_microusd: 1_500_000 })).toBe(250_000);
    expect(remainingAllowance({ date: '2026-01-01', limit_microusd: 2_000_000, spent_microusd: 1_000_000, reserved_microusd: 1_500_000 })).toBe(0);
  });
});

describe('server-side routing control proxy', () => {
  const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
  function configure() { vi.stubEnv('AI_BILLS_ROUTING_URL', 'http://routing.invalid:8900'); vi.stubEnv('AI_BILLS_ROUTING_TOKEN', 'server-only-test-key'); }
  it('shows actionable structured runtime validation errors instead of hiding them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Enabled account has no private binding', type: 'routing_error' } }), { status: 400 })));
    await expect(routingRequest('policy/apply', {})).rejects.toThrow('Enabled account has no private binding');
  });
  it('reports unavailable configuration without contacting any upstream', async () => {
    vi.stubEnv('AI_BILLS_ROUTING_URL', ''); vi.stubEnv('AI_BILLS_ROUTING_TOKEN', '');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await GET(new Request('https://dashboard.invalid/api/routing/state'), context(['state']));
    expect(response.status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects paths outside the control protocol', async () => {
    configure(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await GET(new Request('https://dashboard.invalid/api/routing/auth-files'), context(['auth-files']));
    expect(response.status).toBe(404); expect(fetch).not.toHaveBeenCalled();
  });
  it('injects the server credential without forwarding client headers or response headers', async () => {
    configure(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ policy: policy() }), { headers: { 'X-Private-Key': 'upstream-private' } })); vi.stubGlobal('fetch', fetch);
    const response = await GET(new Request('https://dashboard.invalid/api/routing/state', { headers: { Authorization: 'Bearer client-input' } }), context(['state']));
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe('http://routing.invalid:8900/control/state');
    expect(options.headers.Authorization).toBe('Bearer server-only-test-key');
    expect(response.headers.get('X-Private-Key')).toBeNull(); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('server-only-test-key');
  });
  it('preserves version conflicts and posts the exact reviewed policy', async () => {
    configure(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Policy version conflict' }), { status: 409 })); vi.stubGlobal('fetch', fetch);
    const payload = { policy: policy(), expected_version: 1 };
    const response = await POST(new Request('https://dashboard.invalid/api/routing/policy/apply', { method: 'POST', headers: { origin: 'https://dashboard.invalid' }, body: JSON.stringify(payload) }), context(['policy', 'apply']));
    expect(response.status).toBe(409); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(payload);
  });
  it('accepts the configured public origin behind a reverse proxy and rejects a foreign one', async () => {
    configure(); vi.stubEnv('AI_BILLS_PUBLIC_ORIGIN', 'https://dashboard.invalid');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ valid: true, errors: [] }))); vi.stubGlobal('fetch', fetch);
    const accepted = await POST(new Request('http://internal:18088/api/routing/policy/validate', { method: 'POST', headers: { origin: 'https://dashboard.invalid' }, body: '{}' }), context(['policy', 'validate']));
    expect(accepted.status).toBe(200);
    const rejected = await POST(new Request('http://internal:18088/api/routing/policy/validate', { method: 'POST', headers: { origin: 'https://foreign.invalid', 'x-forwarded-host': 'foreign.invalid' }, body: '{}' }), context(['policy', 'validate']));
    expect(rejected.status).toBe(403); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-origin mutation and does not reveal transport error details', async () => {
    configure(); const fetch = vi.fn().mockRejectedValue(new Error('private endpoint and credential')); vi.stubGlobal('fetch', fetch);
    const denied = await POST(new Request('https://dashboard.invalid/api/routing/policy/apply', { method: 'POST', headers: { origin: 'https://other.invalid' }, body: '{}' }), context(['policy', 'apply']));
    expect(denied.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
    const failed = await GET(new Request('https://dashboard.invalid/api/routing/state'), context(['state']));
    expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('private endpoint');
  });
});
