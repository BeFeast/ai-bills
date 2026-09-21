import { readFile } from 'node:fs/promises';
import { readSnapshot, type Scope } from './storage';
import { loadConfig, type AppConfig } from './config';

/** One rule evaluation as the collector-side alerts process reported it. `state` is the condition now; `severity` is what a page would carry. */
export type AlertCondition = { key: string; severity: 'P3' | 'P4' | 'P5'; state: 'ok' | 'warn' | 'bad'; title: string; message: string; value: number | null; since: string | null };
export type AlertEvent = { at: string; kind: 'raised' | 'escalated' | 'eased' | 'recovered'; key: string; severity: 'P3' | 'P4' | 'P5'; state: 'ok' | 'warn' | 'bad'; title: string; message: string };
export type AlertsReport = { generatedAt: string | null; snapshotAt: string | null; conditions: AlertCondition[]; active: AlertCondition[]; events: AlertEvent[]; available: boolean };

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown) => typeof value === 'string' ? value : '';
const iso = (value: unknown) => { const v = text(value); return v && Number.isFinite(Date.parse(v)) ? v : null; };
const severity = (value: unknown): AlertCondition['severity'] => value === 'P5' || value === 'P4' ? value : 'P3';
const state = (value: unknown): AlertCondition['state'] => value === 'bad' || value === 'warn' ? value : 'ok';
const kind = (value: unknown): AlertEvent['kind'] => value === 'raised' || value === 'escalated' || value === 'eased' ? value : 'recovered';
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The alerts block is optional in the snapshot: an operator without the alerts process sees "not configured", never invented silence. */
export function parseAlerts(snapshot: unknown): AlertsReport {
  const root = row(snapshot); const block = row(root.alerts);
  const generatedAt = iso(block.generated);
  const conditions = rows(block.conditions).filter(c => text(c.key) && text(c.title)).map<AlertCondition>(c => ({ key: text(c.key), severity: severity(c.severity), state: state(c.state), title: text(c.title), message: text(c.message), value: number(c.value), since: iso(c.since) }));
  const order: Record<AlertCondition['state'], number> = { bad: 0, warn: 1, ok: 2 };
  conditions.sort((a, b) => order[a.state] - order[b.state] || a.severity.localeCompare(b.severity) * -1 || a.title.localeCompare(b.title));
  const events = rows(block.events).filter(e => text(e.key) && iso(e.at)).map<AlertEvent>(e => ({ at: text(e.at), kind: kind(e.kind), key: text(e.key), severity: severity(e.severity), state: state(e.state), title: text(e.title), message: text(e.message) })).sort((a, b) => b.at.localeCompare(a.at));
  return { generatedAt, snapshotAt: iso(root.generated), conditions, active: conditions.filter(c => c.state !== 'ok'), events, available: generatedAt !== null };
}

export async function alertsReport(config: AppConfig = loadConfig(), scope?: Scope): Promise<AlertsReport> {
  // An unreadable snapshot reports as unavailable below.
  return parseAlerts((await readSnapshot(config, scope)).body);
}
