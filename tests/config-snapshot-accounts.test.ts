import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountsFromSnapshot, loadConfig, resetConfigCache } from '@/lib/config';

const dir = mkdtempSync(join(tmpdir(), 'zecori-config-'));
const snapshotPath = join(dir, 'snapshot.json');
const configPath = join(dir, 'config.toml');
const collector = (accounts: unknown[]) => JSON.stringify({ generated: '2026-09-19T09:00:00Z', collector: { kind: 'zecori-collect', accounts } });
function writeSnapshot(body: string, seconds: number) { writeFileSync(snapshotPath, body); utimesSync(snapshotPath, seconds, seconds); }

afterEach(() => resetConfigCache());

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

describe('loadConfig without declared accounts', () => {
  it('takes the accounts from the snapshot and follows the file as it changes', () => {
    writeFileSync(configPath, `[billing]\nsnapshot_path = "${snapshotPath}"\n`);
    writeSnapshot(collector([{ type: 'codex', email: 'dev@example.com' }]), 1_700_000_000);
    expect(loadConfig(configPath).accounts.map(a => a.key)).toEqual(['codex-dev@example.com']);
    writeSnapshot(collector([{ type: 'codex', email: 'dev@example.com' }, { type: 'claude', email: 'dev@example.com' }]), 1_700_000_060);
    expect(loadConfig(configPath).accounts.map(a => a.key)).toEqual(['codex-dev@example.com', 'claude-dev@example.com']);
    // An unreadable or malformed snapshot yields no accounts rather than a crash.
    writeSnapshot('{not json', 1_700_000_120);
    expect(loadConfig(configPath).accounts).toEqual([]);
  });

  it('never overrides accounts the operator declared', () => {
    writeFileSync(configPath, `[[accounts]]\nkey = "work"\nprovider = "claude"\nlabel = "Work"\nemail = "ops@example.com"\n\n[billing]\nsnapshot_path = "${snapshotPath}"\n`);
    writeSnapshot(collector([{ type: 'codex', email: 'dev@example.com' }]), 1_700_000_200);
    expect(loadConfig(configPath).accounts.map(a => a.key)).toEqual(['work']);
  });
});
