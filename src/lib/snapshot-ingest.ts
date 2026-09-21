import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** Tokens are configured as hex SHA-256 digests (`AI_BILLS_INGEST_TOKEN_SHA256`, comma-separated); plaintext never lives on the app host. */
export function parseTokenDigests(value: string | undefined): string[] {
  return (value ?? '').split(/[,\s]+/).map(entry => entry.trim().toLowerCase().replace(/^sha256:/, '')).filter(entry => /^[0-9a-f]{64}$/.test(entry));
}

/** The SHA-256 hex digest of a presented bearer token, or null when the header is not a bearer. */
export function bearerDigest(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? createHash('sha256').update(match[1]).digest('hex') : null;
}

export function bearerAccepted(header: string | null, digests: string[]): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match || !digests.length) return false;
  const presented = Buffer.from(createHash('sha256').update(match[1]).digest('hex'), 'hex');
  return digests.some(digest => { const expected = Buffer.from(digest, 'hex'); return expected.length === presented.length && timingSafeEqual(expected, presented); });
}

/** Same envelope rule as the SSH receiver: a JSON object with a string `generated`. */
export function validateSnapshot(raw: string): { ok: true; generated: string } | { ok: false; error: string } {
  if (raw.length > MAX_SNAPSHOT_BYTES) return { ok: false, error: 'snapshot too large' };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, error: 'snapshot is not valid JSON' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { generated?: unknown }).generated !== 'string') return { ok: false, error: 'invalid snapshot envelope' };
  return { ok: true, generated: (value as { generated: string }).generated };
}

/** Read at most `limit` bytes from a request body, stopping (and cancelling the stream) as soon as the cap is exceeded, so an oversized upload never sits in memory. */
export async function readBounded(request: Request, limit = MAX_SNAPSHOT_BYTES): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) return { ok: false };
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); return { ok: false }; }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}
