import { loadConfig } from './config';
import { peekUsageObservations } from './usage-observations';

/** No network, refresh, browser acquisition or private source payloads. */
export function sourceHealth(now = Date.now()) {
  const config = loadConfig();
  const observations = peekUsageObservations();
  const sources = config.accounts.map(account => {
    const observation = observations.find(row => row.account.key === account.key);
    const observedAt = observation?.fetchedAt || null;
    const time = Date.parse(observedAt || '');
    const current = Number.isFinite(time) && time <= now + 60_000 && now - time <= 600_000;
    const status = !observedAt ? 'missing' : !current ? 'stale' : observation?.ok ? 'fresh' : 'error';
    const browser = ['kimi', 'cursor'].includes(account.provider);
    return { id: account.key, provider: account.provider, expected: true, status, observedAt, maxAgeSeconds: 600,
      ...(browser ? { cdp_path: { mode: !observedAt ? 'idle' : current ? 'observed' : 'stale', observedAt,
        ok: observation ? observation.ok : null, live: false } } : {}) };
  });
  return { ok: true, service: 'ai-bills', generatedAt: new Date(now).toISOString(),
    collection: sources.every(row => row.status === 'fresh') ? 'fresh' : 'degraded', sources };
}
