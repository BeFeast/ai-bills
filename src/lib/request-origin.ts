/** Reverse-proxy deployments declare their public origin explicitly. Do not trust
 * arbitrary forwarded-host headers when authorizing a browser mutation. */
export function hasAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const expected = new URL(process.env.AI_BILLS_PUBLIC_ORIGIN || request.url).origin;
    return origin === expected;
  } catch { return false; }
}
