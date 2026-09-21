import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/config', () => ({ loadConfig: () => ({ accounting: {} }) }));
vi.mock('../src/lib/tenant', () => ({ requireTenant: async () => ({ tenant: { id: 'tenant', slug: 't', role: 'admin', userId: null, email: null }, forbidden: null }) }));
vi.mock('../src/lib/storage', () => ({ journalStoreFor: () => ({ configured: true, read: async () => ({ rows: [], observedAt: null }), add: async () => 0 }), readSnapshot: async () => ({ body: {}, version: null }) }));
import { POST } from '../src/app/api/accounts/accounting/route';

describe('accounting request validation', () => {
  it.each(['null', '[]', '42', '{"records":false}'])('rejects malformed shape %s as client input', async (body) => {
    const response = await POST(new Request('https://dashboard.invalid/api/accounts/accounting', {
      method: 'POST', headers: { Origin: 'https://dashboard.invalid' }, body,
    }));
    expect(response.status).toBe(400);
  });
});
