import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadConfig, type AppConfig } from './config';
import { freshness, opaqueId, type Freshness, type AccountBinding } from './accounting';
import { openRouterFunds, type OpenRouterFunds } from './openrouter';
import { peekUsageObservations } from './usage-observations';
import { codexPrimaryWindow, codexWindowResetIso, cursorCycleEnd, cursorUsagePercent, kimiCodingUsage, type ProviderUsage, type ClaudeUsagePayload, type CodexUsagePayload, type CursorUsagePayload, type KimiUsagePayload } from './usage';

export type RegistryAccount = { id: string; provider: string; label: string; origin: 'declared' | 'oauth' | 'configured' | 'external'; funds?: OpenRouterFunds; proxyConfigured?: boolean; websiteUrl?: string; operatorNote?: string; billingMode: 'included' | 'metered' | 'unknown'; routingEnrolled: boolean | null; memberIds?: string[]; quota: { status: 'fresh' | 'stale' | 'error' | 'unknown'; remaining: number | null; resetAt: string | null; observedAt?: string | null; unit?: 'percent' | 'requests' }; coverage: { status: 'partial' | 'unsupported' | 'available'; reason: string }; observedAt: string };
export type AccountRegistry = { generatedAt: string; accounts: RegistryAccount[]; sources: Freshness[]; complete: boolean };
type ObjectRow = Record<string, unknown>;
const object = (value: unknown): ObjectRow => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRow : {};
const rows = (value: unknown): ObjectRow[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => typeof value === 'string' ? value : '';
function account(identity: string, provider: string, label: string, origin: RegistryAccount['origin'], observedAt: string, mode: RegistryAccount['billingMode'] = 'unknown'): RegistryAccount {
  return { id: opaqueId(identity), provider, label, origin, billingMode: mode, routingEnrolled: false, quota: { status: 'unknown', remaining: null, resetAt: null }, coverage: { status: 'partial', reason: 'Inventory discovered; quota and financial completeness are separate observations' }, observedAt };
}

/** Projection only: tokens, keys, headers, endpoints and raw auth files never leave the server. */
export function discoverConfiguredAccounts(config: unknown, observedAt: string): RegistryAccount[] {
  const raw = object(config); const result: RegistryAccount[] = [];
  for (const provider of ['gemini', 'codex', 'claude', 'vertex']) {
    for (const [index, row] of rows(raw[`${provider}-api-key`]).entries()) {
      // Fingerprint distinguishes equal prefixes without publishing credentials.
      const identity = `configured:${provider}:${text(row['api-key']) || text(row.id) || index}`;
      result.push(account(identity, provider, text(row.label) || `${provider} API ${index + 1}`, 'configured', observedAt));
    }
  }
  for (const [index, provider] of rows(raw['openai-compatibility']).entries()) {
    const name = text(provider.name) || `openai-compatible-${index + 1}`;
    const entries = rows(provider['api-key-entries']);
    // Empty key entries still represent a declared provider, not verified callable accounts.
    for (const [keyIndex, entry] of (entries.length ? entries : [{}]).entries()) {
      result.push(account(`configured:${name}:${text(entry['api-key']) || text(entry.id) || keyIndex}`, name, text(entry.label) || `${name} API ${keyIndex + 1}`, 'configured', observedAt));
    }
  }
  return result;
}

export async function accountRegistry(config: AppConfig = loadConfig()): Promise<AccountRegistry> {
  const generatedAt = new Date().toISOString(); const accounts: RegistryAccount[] = []; const sources: Freshness[] = [];
  const source = (id: string, status: Freshness['status'], message: string, observedAt: string | null = null) => sources.push({ id, status, message, observedAt, maxAgeSeconds: 300 });
  // Remote collector publishes a sanitized projection with the existing snapshot.
  let remoteInventory = false;
  let snapshot: ObjectRow = {};
  const snapshotPath = config.accounting?.registry_snapshot_path ?? config.billing.snapshot_path;
  try {
    snapshot = object(JSON.parse(await readFile(snapshotPath, 'utf8')));
    for (const row of rows(snapshot.source_receipts)) {
      const status = row.status === 'fresh' ? freshness(text(row.id), text(row.observedAt), 600).status : 'error';
      source(text(row.id), status, row.status === 'fresh' ? 'Collector source observation' : 'Collector source failed; an empty fallback is not evidence of zero usage', text(row.observedAt));
    }
    const registry = object(snapshot.account_registry ?? snapshot);
    if (Array.isArray(registry.accounts)) {
      remoteInventory = true;
      const observedAt = text(registry.generatedAt) || text(snapshot.generated);
      for (const row of rows(registry.accounts)) {
        if (!/^[a-f0-9]{24}$/.test(text(row.id))) continue;
        const a = account('remote-placeholder', text(row.provider) || 'unknown', text(row.label) || 'Discovered account', ['oauth', 'configured', 'external'].includes(text(row.origin)) ? row.origin as RegistryAccount['origin'] : 'declared', observedAt);
        a.id = text(row.id);
        // Snapshot is inventory evidence, not permission or billing classification.
        accounts.push(a);
      }
      sources.push(freshness('collector-account-registry', observedAt, 300));
      for (const row of rows(registry.sources)) {
        if (row.status !== 'fresh') source(`collector:${text(row.id)}`, 'error', 'Collector reports an incomplete inventory source', observedAt);
      }
    }
  } catch { /* Local discovery below remains available; no remote coverage is inferred. */ }
  for (const row of config.accounts) accounts.push(account(`declared:${row.key}`, row.provider, row.label, 'declared', generatedAt));
  for (const row of config.accounting?.declared_accounts ?? []) {
    const a = account(`declared:${row.id}`, row.provider, row.label, row.origin ?? 'external', generatedAt, row.billing_mode ?? 'unknown');
    try {
      const website = new URL(row.website_url ?? '');
      if (['https:', 'http:'].includes(website.protocol) && !website.username && !website.password) a.websiteUrl = website.href;
    } catch { /* A missing website is not a fabricated account connection. */ }
    if (row.operator_note) a.operatorNote = row.operator_note;
    const connected = (row.source_ids ?? []).filter(id => config.accounting?.sources?.some(s => s.id === id && s.kind !== 'unsupported'));
    if (!connected.length) a.coverage = { status: 'unsupported', reason: 'No financial source linked; manual accounting is available' };
    accounts.push(a);
  }
  const authDir = config.accounting?.proxy_auth_dir;
  if (!authDir && !remoteInventory) source('proxy-oauth', 'missing', 'OAuth inventory source is not configured');
  else if (authDir) {
    try {
      const names = (await readdir(authDir)).filter(name => name.endsWith('.json')).sort(); let failures = 0;
      for (const name of names) {
        try {
          const row = object(JSON.parse(await readFile(join(authDir, name), 'utf8')));
          const provider = text(row.type) || text(row.provider) || 'unknown';
          accounts.push(account(`oauth:${name}`, provider, text(row.label) || `${provider} OAuth ${opaqueId(name).slice(0, 6)}`, 'oauth', generatedAt));
        } catch { failures++; }
      }
      source('proxy-oauth', failures ? 'error' : 'fresh', failures ? `${failures} auth records could not be read; inventory is incomplete` : `${names.length} OAuth records discovered`, generatedAt);
    } catch { source('proxy-oauth', 'error', 'OAuth inventory cannot be read'); }
  }
  const proxyConfig = config.accounting?.proxy_config_path;
  if (!proxyConfig && !remoteInventory) source('proxy-configured', 'missing', 'Configured upstream inventory source is not configured');
  else if (proxyConfig) {
    try {
      const raw = parseYaml(await readFile(proxyConfig, 'utf8'));
      accounts.push(...discoverConfiguredAccounts(raw, generatedAt));
      source('proxy-configured', 'fresh', 'Configured upstream metadata discovered; availability and billing mode not inferred', generatedAt);
    } catch { source('proxy-configured', 'error', 'Configured upstream inventory cannot be read'); }
  }
  const unique = bindAccountIdentities([...new Map(accounts.map(a => [a.id, a])).values()], config.accounting?.account_bindings ?? []);
  const observations = [...peekUsageObservations()];
  for (const configured of config.accounts) {
    const entries = object(snapshot[`${configured.provider}_usage`]);
    const entry = object(entries[configured.quota_snapshot_key || configured.email]);
    if (Object.keys(entry).length) observations.push({ account: configured, ok: entry.ok === true, status: typeof entry.status === 'number' ? entry.status : entry.ok ? 200 : undefined,
      data: entry.ok ? object(entry.data) : undefined, fetchedAt: text(entry.fetched_at), sourceUrl: 'collector-quota', error: entry.ok ? undefined : 'Collector quota request failed' });
  }
  applyQuotaObservations(unique, observations, config.accounting?.account_bindings ?? []);
  for (const row of unique) {
    if (row.quota.status === 'fresh') row.coverage = { status: 'partial', reason: 'Current quota observed; financial completeness is reported separately' };
    sources.push({ id: `quota:${row.id}`, status: row.quota.status === 'unknown' ? 'unsupported' : row.quota.status, observedAt: row.quota.observedAt || null, maxAgeSeconds: 600,
      message: row.quota.status === 'fresh' ? 'Provider quota observation is current' : row.quota.status === 'unknown' ? 'No supported quota observation for this account' : 'Quota observation is stale or failed' });
  }
  if (config.accounting?.openrouter_account_id) {
    const identity = opaqueId(`declared:${config.accounting.openrouter_account_id}`);
    const row = unique.find(account => (account.memberIds || [account.id]).includes(identity));
    const funds = openRouterFunds(snapshot);
    if (row) { row.proxyConfigured = accounts.some(member => member.origin === 'configured' && (row.memberIds || [row.id]).includes(member.id)); row.funds = funds; row.websiteUrl ||= 'https://openrouter.ai/settings/credits'; row.coverage = { status: 'partial', reason: 'Account credits and key usage have independent API observations; inference availability is unverified' }; }
    sources.push(funds.accountBalance.freshness, funds.keyUsage.freshness);
  }
  const routing = await readRoutingEnrollment();
  if (routing.policy) applyRoutingEnrollment(unique, routing.policy);
  else for (const row of unique) row.routingEnrolled = null;
  sources.push(routing.source);
  source('declared-external', config.accounting?.declared_inventory_complete ? 'fresh' : 'missing', config.accounting?.declared_inventory_complete ? 'Operator declared the external account inventory complete' : 'External services not declared by the operator remain coverage gaps', generatedAt);
  return { generatedAt, accounts: unique, sources, complete: sources.every((row) => row.status === 'fresh') };

}

/** Merge only operator-supplied aliases. Similar names or shared email never imply identity. */
export function bindAccountIdentities(accounts: RegistryAccount[], bindings: AccountBinding[]): RegistryAccount[] {
  const owners = new Map<string, string>();
  for (const binding of bindings) {
    if (!binding.id || !Array.isArray(binding.members)) throw new Error('Invalid account binding');
    for (const member of [binding.id, ...binding.members]) {
      const previous = owners.get(member);
      if (previous && previous !== binding.id) throw new Error('Account belongs to conflicting identity bindings');
      owners.set(member, binding.id);
    }
  }
  const result = new Map<string, RegistryAccount>();
  for (const row of accounts) {
    const id = owners.get(row.id) || row.id;
    const binding = bindings.find((item) => item.id === id);
    const existing = result.get(id);
    if (existing) { existing.websiteUrl ||= row.websiteUrl; existing.operatorNote ||= row.operatorNote; existing.memberIds = [...new Set([...(existing.memberIds || []), row.id])]; continue; }
    result.set(id, { ...row, id, memberIds: [row.id], label: binding?.label || row.label, billingMode: binding?.billing_mode || row.billingMode, quota: { ...row.quota }, coverage: { ...row.coverage } });
  }
  return [...result.values()];
}

export function applyQuotaObservations(accounts: RegistryAccount[], observations: readonly ProviderUsage[], bindings: AccountBinding[], now = Date.now()) {
  for (const row of accounts) {
    const key = bindings.find((binding) => binding.id === row.id)?.quota_account_key;
    const matching = observations.filter((observation) => key ? observation.account.key === key : (row.memberIds || [row.id]).includes(opaqueId(`declared:${observation.account.key}`)));
    const observation = matching.sort((a, b) => (Date.parse(b.fetchedAt) || 0) - (Date.parse(a.fetchedAt) || 0))[0];
    if (!observation) continue;
    row.quota.observedAt = observation.fetchedAt || null;
    if (!observation.ok || (observation.status !== undefined && observation.status >= 400)) { row.quota.status = 'error'; continue; }
    const receipt = freshness(`quota:${row.id}`, observation.fetchedAt, 600, now);
    if (receipt.status !== 'fresh') { row.quota.status = receipt.status === 'stale' ? 'stale' : 'unknown'; continue; }
    let remaining: number | null = null; let resetAt: string | null = null; let unit: 'percent' | 'requests' = 'percent';
    if (observation.account.provider === 'claude') {
      const data = observation.data as ClaudeUsagePayload | undefined;
      const windows = [data?.five_hour, data?.seven_day].filter((window) => typeof window?.utilization === 'number');
      windows.sort((a, b) => (b?.utilization ?? 0) - (a?.utilization ?? 0));
      if (windows[0]) { remaining = Math.max(0, 100 - windows[0].utilization!); resetAt = windows[0].resets_at || null; }
    } else if (observation.account.provider === 'codex') {
      const data = observation.data as CodexUsagePayload | undefined;
      const windows = [codexPrimaryWindow(data), data?.rate_limit?.secondary_window].filter((window) => typeof window?.used_percent === 'number');
      windows.sort((a, b) => (b?.used_percent ?? 0) - (a?.used_percent ?? 0));
      if (windows[0]) { remaining = Math.max(0, 100 - windows[0].used_percent); resetAt = codexWindowResetIso(windows[0]); }
    } else if (observation.account.provider === 'kimi') {
      const detail = kimiCodingUsage(observation.data as KimiUsagePayload)?.detail;
      if (typeof detail?.remaining === 'number') { remaining = detail.remaining; resetAt = detail.resetTime || null; unit = 'requests'; }
    } else if (observation.account.provider === 'cursor') {
      const data = observation.data as CursorUsagePayload; const used = cursorUsagePercent(data);
      if (used !== null) { remaining = Math.max(0, 100 - used); resetAt = cursorCycleEnd(data); }
    }
    if (remaining !== null && Number.isFinite(remaining)) row.quota = { status: 'fresh', remaining, resetAt, unit, observedAt: observation.fetchedAt };
  }
}

type EnrollmentPolicy = { accounts?: { id: string; enabled: boolean }[]; models?: { routes?: { account_id: string; billing: string }[] }[] };
export function applyRoutingEnrollment(accounts: RegistryAccount[], policy: EnrollmentPolicy) {
  for (const row of accounts) {
    row.routingEnrolled = policy.accounts?.find((account) => account.id === row.id)?.enabled === true;
    const modes = new Set(policy.models?.flatMap((model) => (model.routes || []).filter((route) => route.account_id === row.id).map((route) => route.billing)) || []);
    if (modes.size === 1) { const mode = [...modes][0]; if (mode === 'included' || mode === 'paid') row.billingMode = mode === 'included' ? 'included' : 'metered'; }
  }
}

async function readRoutingEnrollment(): Promise<{ policy?: EnrollmentPolicy; source: Freshness }> {
  const id = 'routing-enrollment'; const maxAgeSeconds = 60;
  const url = process.env.AI_BILLS_ROUTING_URL; const token = process.env.AI_BILLS_ROUTING_TOKEN;
  if (!url || !token) return { source: { id, status: 'missing', observedAt: null, maxAgeSeconds, message: 'Routing policy source is not configured; enrollment is unknown' } };
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/control/state`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) throw new Error('Policy unavailable');
    const data = await response.json();
    if (!data.policy || !Array.isArray(data.policy.accounts)) throw new Error('Invalid policy');
    return { policy: data.policy, source: { id, status: 'fresh', observedAt: new Date().toISOString(), maxAgeSeconds, message: `Active routing enrollment observed (policy v${data.policy.version})` } };
  } catch { return { source: { id, status: 'error', observedAt: null, maxAgeSeconds, message: 'Routing policy unavailable; enrollment is unknown' } }; }
}
