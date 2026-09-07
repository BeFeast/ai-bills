# Product overview

`GET /api/overview` provides subscription plans, recurring cost by currency,
current-month API-equivalent and the largest consumers/models. It reads the same
snapshot as billing and never enumerates credentials as subscriptions. Provider
aggregate rows are replaced by explicit individual plans for that provider.

Configure `[[subscriptions]]` with `id`, `provider`, `label`, `plan`, `status`,
`amount`, `currency`, `period` (`month` or `year`), `quantity`, `account_keys`,
`renews_at`, `ends_at`, `manage_url`, `login_url`, `source_note`, `observed_at`, and
`cost_evidence` (`verified`, `declared`, `estimated`, or `unknown`). `amount` is the
whole row's recurring charge per period, not the price per account. Annual totals
are divided by twelve for the monthly projection without currency conversion.
Never put credentials into subscription records or login URLs.

Grouped inventory with unknown quantity is excluded from the known subscription
count and sets `subscriptionCountComplete=false`. Missing inventory is not a
confirmed zero. Undated subscriptions remain visible with links to their billing
settings. Observed plan entitlement can support subscription count; it does not
prove the invoice amount or next renewal date.

Monthly usage requires the collector's actual `usage_ledger.month` projection
matching the current local month. Today's totals and a short trend cannot stand
in for month rankings. When some models lack prices, `apiEquivalentUsd` is null
and `pricedApiEquivalentUsd` preserves the priced subtotal; token rankings still
cover all captured usage. These are estimates of API list-price equivalent, not
payments or proof of complete provider history.
