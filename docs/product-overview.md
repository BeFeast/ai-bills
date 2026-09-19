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
in for month rankings. `usage.last24h` is present only when the collector ships
a `usage_ledger.last_24h` projection labelled `rolling_24h`; it lists proxy
upstreams (provider plus account) with requests, failures, HTTP 429 counts and
the last request time, and it is the only recency evidence the overview uses.
Raw API keys appearing as account names are masked to a fingerprint. When some models lack prices, `apiEquivalentUsd` is null
and `pricedApiEquivalentUsd` preserves the priced subtotal; token rankings still
cover all captured usage. These are estimates of API list-price equivalent, not
payments or proof of complete provider history.

## Projects and CSV export — 2026-09-19

`usage.byProject` on `/api/overview` is the ledger's `by_project` grouping: operator rules on the
collector host (`projects.json`) attribute each observation to a project; unmatched usage shows as
`unassigned`. It is ranked beside client, model and account under "Who uses the most?".

`GET /api/usage/export?period=today|month|last_24h&by=project|client|model|account|upstream`
returns the rollup as CSV, one row per group with requests, failures, rate limits, tokens,
API-equivalent (empty when any model in the group is unpriced; `priced_api_equivalent_usd`
keeps the priced part), a `pricing` state, the period bounds and the period's reconciliation
state. When the period holds unreconciled native observations they are appended as one
explicitly labelled row that may overlap with the rows above. Nothing is recomputed on export.
