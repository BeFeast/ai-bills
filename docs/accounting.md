# Accounting and inventory

`GET /api/accounts` returns a secret-free accounting inventory. Existing configured
cards, declared external accounts, local OAuth/config discovery and remote collector
inventory are supported. Discovery never enrolls an account for routing and never
assumes OAuth means zero additional charges. Unknown quotas remain unknown.

The existing collector remains the sole destructive proxy usage-queue consumer.
`ai-account-inventory` only reads local files and contributes `account_registry` to
the existing billing snapshot. Install it beside `ai-bill-collect.sh`; configure
`AI_BILLS_CLIPROXY_CONFIG` and `AI_BILLS_CLIPROXY_AUTH_DIR` on the collector host.
The application reads that projection from `billing.snapshot_path`, or an explicit
`accounting.registry_snapshot_path`. No OAuth tokens need to move to the app host.

Private TOML configuration can extend the existing `[accounting]` section:

```toml
[accounting]
journal_path = "/data/accounting.jsonl"

[[accounting.declared_accounts]]
id = "example-external"
provider = "example"
label = "Example native subscription"
origin = "external"
billing_mode = "unknown"
source_ids = ["example-invoices"]

[[accounting.sources]]
id = "example-invoices"
kind = "json-file"
path = "/data/example-invoices.json"
max_age_seconds = 86400
```

Sources support `json-file`, read-only `json-http`, `manual` and `unsupported`.
HTTP sources use configured `url` and optional `authorization = { env = "..." }`
or an existing Infisical reference. Redirects are disabled to preserve credential
destination. Nothing runs when merely importing the module.

The default source envelope is `{observedAt, records:[...]}`. `records_path`,
`observed_at_path`, `fields` (dot paths), `provider`, `account_id`, `record_kind`
and `currency` adapt supported provider payloads. A successful file/API read does
not manufacture source freshness; missing observation time stays missing.

`GET /api/accounts/accounting?month=YYYY-MM` returns monthly records, separate
`paymentsUsd`, `accruedUsd`, `apiEquivalentUsd`, source coverage and diagnostics.
`POST` accepts `{records:[...]}` (1–1000 records). Each record requires:

```json
{
  "sourceId": "example-invoices",
  "sourceRecordId": "invoice-unique-reference",
  "accountId": "example-external",
  "provider": "example",
  "kind": "payment",
  "amount": 20,
  "currency": "USD",
  "date": "2026-09-07",
  "note": "Optional operator explanation"
}
```

Kinds are `payment`, `accrual`, `api-equivalent`, `balance`, `subscription`.
Do not import the same provider event under multiple source identities. The stable
source-record pair is idempotent; conflicting reuse returns 409 without overwriting.
Use new, explicitly signed adjustment records for corrections. Cross-process lock
and fsync protect append operations; an uncertain orphan lock is not auto-reclaimed.
Recovery requires inspecting the original journal and writer before removing its lock.

No records yields null, not zero. Non-USD records remain visible and are excluded
from USD totals until verified conversion is supplied. Payments, consumption,
balances and estimates are never summed as one spending number. `complete:false`
is deliberate: discovered/configured sources alone cannot prove all external accounts
or full historical period coverage. Manual entries do not prove invoice completeness.

The report reconciles matching upstream request IDs between native and proxy
observations in its read projection, preserving original JSONL files. Attempt IDs
preserve separate retries. Model price-table billing labels no longer establish an
account's marginal cost; missing per-account billing evidence leaves marginal cost
unknown. API-equivalent totals with unpriced observations are likewise unknown.
Reports group days in `Asia/Jerusalem` (`AI_USAGE_TIMEZONE` can override).

Price entries may include `long_context: {input_tokens_above: 272000, in: 8,
out: 30}` beside the short-context `in`/`out` rates. The reporter sums exact
uncached, cache-read and cache-write input buckets. Above the configured boundary,
the selected rates apply to the entire request, including output. Output tokens
do not select the tier. Missing input evidence stays unpriced. Cache multipliers
inherit from the short-context entry unless the long-context entry overrides them.
Keep provider source URLs and observation dates in private price metadata; context
thresholds must be verified per model. Unsupported modality/context pricing stays
unknown. API-equivalent means the configured public list-price comparison, not an
invoice or proof of actual service-tier charges. This projection does not modify
the gateway's separate admission prices or budget policy.

Atomic snapshot delivery is optional. Set `AI_BILLS_SNAPSHOT_SSH_HOST`,
`AI_BILLS_SNAPSHOT_RECEIVER` (fixed installed executable), and
`AI_BILLS_SNAPSHOT_DESTINATION`. The collector sends stdin through SSH to the
sudo receiver. Its explicit destination directory must already be provisioned;
JSON validation, file fsync, same-directory rename and directory fsync preserve
the previous snapshot on invalid/truncated input. Existing SCP mode remains when
SSH receiver configuration is absent. Installation, paths and privileges are
operator-owned; this source does not enable schedules or change permissions.
