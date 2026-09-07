import type { ProviderUsage } from './usage';
let observations: readonly ProviderUsage[] = [];
/** Read-only projection: inventory must never trigger provider quota requests. */
export function peekUsageObservations(): readonly ProviderUsage[] { return observations; }
export function rememberUsageObservations(results: readonly ProviderUsage[]) { observations = results; }
