import { afterEach, describe, expect, it, vi } from 'vitest';

const tenant = vi.hoisted(() => ({ value: { id: 't', slug: 'oleg', role: 'admin', userId: null as string | null, email: null as string | null, access: 'session' } }));
vi.mock('../src/lib/tenant', () => ({ requireTenant: async () => ({ tenant: tenant.value, forbidden: null }) }));
vi.mock('../src/lib/config', () => ({ loadConfig: () => ({ accounts: [], proxy_management: { base_url: 'https://proxy.example.test', management_key: 'm' } }) }));
const start = vi.hoisted(() => vi.fn(() => ({ job: { state: 'checking' }, done: Promise.resolve() })));
vi.mock('../src/lib/proxy-reauth', () => ({ reauthConfigured: () => true, reauthJob: () => null, startProxyReauth: start }));

import { POST } from '../src/app/api/proxy-reauth/route';

const request = () => new Request('https://zecori.example.test/api/proxy-reauth', { method: 'POST', headers: { origin: 'https://zecori.example.test', host: 'zecori.example.test' }, body: JSON.stringify({ accountKey: 'claude-personal' }) });
afterEach(() => { vi.unstubAllEnvs(); start.mockClear(); });

describe('Reconnect proxy authorization', () => {
  it('refuses everyone in Clerk allow-list mode, where every allowed person looks like the admin', async () => {
    vi.stubEnv('AI_BILLS_AUTH', 'clerk'); vi.stubEnv('DATABASE_URL', '');
    expect((await POST(request())).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it('accepts only a named operator in membership mode', async () => {
    vi.stubEnv('AI_BILLS_AUTH', 'clerk'); vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db'); vi.stubEnv('AI_BILLS_OPERATOR_EMAILS', 'operator@example.test');
    tenant.value = { ...tenant.value, userId: 'user_1', email: 'member@example.test' };
    expect((await POST(request())).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
    tenant.value = { ...tenant.value, email: 'operator@example.test' };
    expect((await POST(request())).status).toBe(202);
    expect(start).toHaveBeenCalledOnce();
    // Never an ingest or device token, whoever it belongs to.
    tenant.value = { ...tenant.value, access: 'ingest' };
    expect((await POST(request())).status).toBe(403);
  });
});
