import { expect, test } from 'vitest';
import { openRouterFunds } from '../src/lib/openrouter';
const now = Date.now(); const observedAt = new Date(now).toISOString();
const snapshot = { openrouter: { credits: { ok: true, observedAt, balanceUsd: 9.99945728, totalUsageUsd: .00054272 }, key: { ok: true, observedAt, usageUsd: 0, limitUsd: null, remainingUsd: null } } };
test('account credits remain separate from a zero-use key with no spending cap', () => {
  const value = openRouterFunds(snapshot, now);
  expect(value.accountBalance.usd).toBe(9.99945728);
  expect(value.accountSpentUsd).toBe(.00054272);
  expect(value.keyUsage.usd).toBe(0);
  expect(value.keyLimitKnown).toBe(true); expect(value.keyLimitUsd).toBeNull();
});
test('failed credits never fall back to key allowance and stale observations stop claiming a balance', () => {
  const failed = openRouterFunds({ openrouter: { ...snapshot.openrouter, credits: { ok: false, observedAt } } }, now);
  expect(failed.accountBalance.usd).toBeNull(); expect(failed.keyUsage.usd).toBe(0);
  const stale = openRouterFunds(snapshot, now + 601000);
  expect(stale.accountBalance.freshness.status).toBe('stale'); expect(stale.accountBalance.usd).toBeNull(); expect(stale.keyLimitKnown).toBe(false);
});
