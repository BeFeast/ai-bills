import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { UsageCard } from '../src/components/UsageCard';
import { loadConfig, resetConfigCache, type AccountConfig } from '../src/lib/config';
import type { ProviderUsage } from '../src/lib/usage';

const CONFIG_PATH = fileURLToPath(new URL('./fixtures/accounts.toml', import.meta.url));
process.env.AI_BILLS_CONFIG = CONFIG_PATH;
resetConfigCache();

const account = (key: string): AccountConfig => loadConfig().accounts.find((item) => item.key === key)!;

/** claude-work as the API actually returned it on 2026-07-27: whole percents. */
function workResult(weeklyPercent: number): ProviderUsage {
  return {
    account: account('claude-work'),
    ok: true,
    status: 200,
    fetchedAt: '2026-07-27T12:06:00.000Z',
    sourceUrl: 'https://claude.ai/api/organizations/x/usage',
    data: {
      five_hour: { utilization: 4, resets_at: '2026-07-27T13:29:00.000Z' },
      seven_day: { utilization: weeklyPercent, resets_at: '2026-08-03T07:59:00.000Z' },
      limits: [
        { kind: 'session', group: 'session', percent: 4, severity: 'normal', resets_at: '2026-07-27T13:29:00.000Z', is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: weeklyPercent, severity: 'normal', resets_at: '2026-08-03T07:59:00.000Z', is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 2, severity: 'normal', resets_at: '2026-08-03T07:59:00.000Z', scope: { model: { display_name: 'Fable' } }, is_active: false },
      ],
    },
  };
}

function render(result: ProviderUsage): string {
  return renderToStaticMarkup(
    <UsageCard result={result} now={Date.parse('2026-07-27T12:06:00.000Z')} tz="Asia/Jerusalem" onAuthorized={() => {}} />,
  );
}

describe('Claude card rendering', () => {
  test('regression: a 1% weekly window renders as 1%, not a maxed-out bar', () => {
    const html = render(workResult(1));
    expect(html).toContain('1.0%');
    expect(html).not.toContain('100.0%');
    expect(html).toContain('All models available');
    expect(html).not.toContain('No models available');
  });

  test('normal percents still render unchanged', () => {
    const html = render(workResult(37));
    expect(html).toContain('4.0%');
    expect(html).toContain('37.0%');
    expect(html).toContain('2.0%');
    expect(html).toContain('All models available');
  });

  test('a genuinely exhausted weekly limit still blocks', () => {
    const html = render(workResult(100));
    expect(html).toContain('100.0%');
    expect(html).toContain('No models available');
  });
});
