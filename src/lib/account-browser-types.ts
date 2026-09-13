/** Browser-safe metadata. Website identity and proxy credential health are separate. */
export type AccountBrowserStatus = 'unconfigured' | 'login_required' | 'identity_unknown' | 'mismatch' | 'ready' | 'unavailable';
export type AccountBrowserSelector = { subscriptionId: string; accountKey?: never } | { accountKey: string; subscriptionId?: never };
export type AccountBrowserState = {
  subscriptionId: string | null; accountKey: string | null; provider: string | null;
  intendedEmail: string | null; configured: boolean; status: AccountBrowserStatus;
  observedAt: string | null; maxAgeSeconds: number; verifiedEmail?: string;
  remoteUrl?: string; profileId?: string; proxyAccountId: string | null; message: string;
  manualLeaseExpiresAt?: string | null;
  proxy: { status: 'unlinked' | 'unavailable' | 'not_found' | 'linked'; policyVersion: number | null;
    enabled: boolean | null; nativeBound: boolean | null; quotaState: string | null; observedAt: string | null };
};

/** A configured URL is not evidence that its browser actually started. */
export function canOpenAccountBrowser(state: Pick<AccountBrowserState, 'status' | 'remoteUrl'>, httpStatus: number): boolean {
  return Boolean(state.remoteUrl) && [200, 409].includes(httpStatus)
    && ['ready', 'login_required', 'identity_unknown', 'mismatch'].includes(state.status);
}
