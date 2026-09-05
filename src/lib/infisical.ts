import { loadConfig, type SecretRef } from './config';

/**
 * Infisical client: universal-auth login + raw secret reads, cached in-process.
 * Machine credentials arrive via env (INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET),
 * never via the TOML config or git.
 */

let token: { value: string; expiresAt: number } | null = null;
const secretCache = new Map<string, { value: string; fetchedAt: number }>();
const SECRET_TTL_MS = 5 * 60 * 1000;

async function infisicalToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 30_000) return token.value;
  const { infisical } = loadConfig();
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET not set');
  const response = await fetch(`${infisical.api_url}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!response.ok) throw new Error(`Infisical login failed: HTTP ${response.status}`);
  const body = (await response.json()) as { accessToken: string; expiresIn: number };
  token = { value: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 };
  return token.value;
}

async function fetchInfisicalSecret(ref: string): Promise<string> {
  const hit = secretCache.get(ref);
  if (hit && hit.fetchedAt > Date.now() - SECRET_TTL_MS) return hit.value;
  const [secretPath, key] = ref.includes(':') ? ref.split(/:(?!.*:)/) : ['/', ref];
  if (!key) throw new Error(`Malformed infisical ref ${JSON.stringify(ref)} — expected "path:KEY"`);
  const { infisical } = loadConfig();
  const url = new URL(`${infisical.api_url}/api/v3/secrets/raw/${encodeURIComponent(key)}`);
  url.searchParams.set('workspaceId', infisical.workspace_id);
  url.searchParams.set('environment', infisical.environment);
  url.searchParams.set('secretPath', secretPath || '/');
  const response = await fetch(url, { headers: { authorization: `Bearer ${await infisicalToken()}` } });
  if (!response.ok) throw new Error(`Infisical read ${ref} failed: HTTP ${response.status}`);
  const body = (await response.json()) as { secret: { secretValue: string } };
  secretCache.set(ref, { value: body.secret.secretValue, fetchedAt: Date.now() });
  return body.secret.secretValue;
}

/** Resolve a secret reference from config: literal string, { env }, or { infisical }. */
export async function resolveSecret(ref: SecretRef | undefined): Promise<string | null> {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  if ('env' in ref) return process.env[ref.env] ?? null;
  return fetchInfisicalSecret(ref.infisical);
}

/** Test hook. */
export function resetInfisicalCache() {
  token = null;
  secretCache.clear();
}
