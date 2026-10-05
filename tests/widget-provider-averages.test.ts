import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const panel = readFileSync('integrations/omarchy/befeast.zecori/Panel.qml', 'utf8');
// Execute the actual QML JavaScript helpers, without requiring a running desktop or collector.
const helpers = [...panel.matchAll(/^  function \w+\([^]*?^  }/gm)].map(match => match[0]).join('\n');
const alarmExpression = panel.match(/readonly property bool alarming: (.*)/)![1];
const fixtureRoot = 'integrations/macos/ZecoriBar/Tests/ZecoriCoreTests/Fixtures/';
const cases = JSON.parse(readFileSync(fixtureRoot + 'provider-averages.json', 'utf8'));

function present(payload: any, errorText = '') {
  const context = { payload, accounts: payload?.accounts ?? [], models: payload?.models ?? [], errorText, stale: payload?.snapshot?.stale === true };
  return runInNewContext(`${helpers}
    var providers = providerSummaries(accounts);
    ({ label: barLabel(), tooltip: barTooltip(), alarming: ${alarmExpression} });`, context);
}

describe('Linux bar provider averages (shared with macOS)', () => {
  for (const entry of cases) {
    it(entry.name, () => {
      expect(present(entry.payload)).toMatchObject({ label: entry.label, alarming: entry.alarming });
    });
  }

  it('explains equal weighting, unknown coverage, and retains model details', () => {
    const payload = JSON.parse(readFileSync(fixtureRoot + 'widget-payload.json', 'utf8'));
    expect(present(payload)).toEqual({
      label: 'Claude 27% · Codex 81% · Cursor – · Kimi –',
      tooltip: 'Zecori: average remaining per provider (equal weight per account) · Claude 27% (2/2 accounts known) · Codex 81% (2/2 accounts known) · Cursor – (0/1 accounts known) · Kimi – (0/1 accounts known) · Fable 25% (Claude · two@example.test)',
      alarming: false,
    });
  });

  it('preserves loading, fetch errors, and stale warnings', () => {
    expect(present(null)).toMatchObject({ label: '…', alarming: false });
    expect(present(null, 'offline')).toMatchObject({ label: '!', tooltip: 'Zecori: offline', alarming: true });
    const payload = cases[0].payload;
    expect(present(payload, 'offline')).toMatchObject({ label: cases[0].label, alarming: true });
    expect(present({ ...payload, snapshot: { stale: true } })).toMatchObject({ label: cases[0].label, alarming: true });
  });

  it('excludes non-finite percentages and keeps stable provider ordering', () => {
    const accounts = [
      { provider: 'codex', headline: { remainingPercent: NaN } },
      { provider: 'claude', headline: { remainingPercent: Infinity } },
      { provider: 'claude', headline: { remainingPercent: 40 } },
    ];
    expect(present({ accounts }).label).toBe('Claude 40% · Codex –');
    expect(present({ accounts: accounts.reverse() }).label).toBe('Claude 40% · Codex –');
  });
});
