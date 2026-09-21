import { describe, expect, it } from 'vitest';
import { accountsFromSnapshot, tenantAccounts } from '@/lib/config';

const collector = (accounts: unknown[]) => JSON.stringify({ generated: '2026-09-19T09:00:00Z', collector: { kind: 'zecori-collect', accounts } });

describe('accountsFromSnapshot', () => {
  it('accepts claude and codex rows with a valid address, once each, and ignores the rest', () => {
    expect(accountsFromSnapshot(JSON.parse(collector([
      { type: 'claude', email: 'Dev@Example.com' }, { type: 'codex', email: 'dev@example.com' }, { type: 'codex', email: 'dev@example.com' },
      { type: 'kimi', email: 'dev@example.com' }, { type: 'claude', email: 'not-an-address' }, { type: 'claude' }, null,
    ])))).toEqual([
      { key: 'claude-dev@example.com', provider: 'claude', label: 'dev@example.com', email: 'dev@example.com' },
      { key: 'codex-dev@example.com', provider: 'codex', label: 'dev@example.com', email: 'dev@example.com' },
    ]);
    expect(accountsFromSnapshot({})).toEqual([]);
    expect(accountsFromSnapshot(null)).toEqual([]);
    expect(accountsFromSnapshot({ collector: { accounts: 'nope' } })).toEqual([]);
  });
});

describe('tenantAccounts', () => {
  const config = (accounts: unknown[] = []) => ({ accounts } as unknown as import('@/lib/config').AppConfig);
  it('takes the accounts from the tenant snapshot when the operator declared none, and follows each delivery', () => {
    expect(tenantAccounts(config(), JSON.parse(collector([{ type: 'codex', email: 'dev@example.com' }]))).map(a => a.key)).toEqual(['codex-dev@example.com']);
    expect(tenantAccounts(config(), JSON.parse(collector([{ type: 'codex', email: 'dev@example.com' }, { type: 'claude', email: 'dev@example.com' }]))).map(a => a.key)).toEqual(['codex-dev@example.com', 'claude-dev@example.com']);
    // An empty or malformed snapshot yields no accounts rather than a crash.
    expect(tenantAccounts(config(), {})).toEqual([]);
    expect(tenantAccounts(config(), null)).toEqual([]);
  });
  it('never overrides accounts the operator declared', () => {
    const declared = [{ key: 'work', provider: 'claude', label: 'Work', email: 'ops@example.com' }];
    expect(tenantAccounts(config(declared), JSON.parse(collector([{ type: 'codex', email: 'dev@example.com' }]))).map(a => a.key)).toEqual(['work']);
  });
});
