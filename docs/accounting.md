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

Set optional `AI_USAGE_ROUTING_DB` to the local gateway SQLite database to attribute
managed usage to the actual client, role, selected account and billing mode. The
report opens it read-only and joins by exact `attempt_id`, checking the managed
request ID when both exist. A managed request ID alone is usable only when it has
exactly one attempt; retries are never guessed. Provider model IDs and token facts
remain unchanged. Missing/unavailable routing data preserves original metadata and
marks `routing_attribution` in the projection. Raw JSONL files are never rewritten,
and this reader never drains the native usage queue.

Atomic snapshot delivery is optional. Set `AI_BILLS_SNAPSHOT_SSH_HOST`,
`AI_BILLS_SNAPSHOT_RECEIVER` (fixed installed executable), and
`AI_BILLS_SNAPSHOT_DESTINATION`. The collector sends stdin through SSH to the
sudo receiver. Its explicit destination directory must already be provisioned;
JSON validation, file fsync, same-directory rename and directory fsync preserve
the previous snapshot on invalid/truncated input. Existing SCP mode remains when
SSH receiver configuration is absent. Installation, paths and privileges are
operator-owned; this source does not enable schedules or change permissions.

## Audit receipt — 2026-09-10

Read-only inspection found a disagreement between the account inventory and
routing quota projection. A Claude observation with an inactive five-hour window
(`utilization: 0`, `resets_at: null`) and an exhausted, unexpired weekly window
was correctly shown as exhausted by the inventory, but
`collector/ai-quota-projection` invalidated both windows and emitted unknown quota.
The scoped patch ignores only that inactive five-hour shape. It preserves the
weekly limit and reset; malformed active windows, stale observations, and an
inactive session without another usable window remain unknown.

Validation: 19 tests passed across `tests/test_claude_quota_collector.py`,
`tests/test_codex_quota_collector.py`, and `tests/accounting-collectors.test.py`.
An offline replay of the observed snapshot reproduced unknown results before
the patch and exhausted results after it for both affected accounts. No collector
installation, deployment, provider inference, account change, or ledger rewrite
was performed. Runtime acceptance remains pending deployment.

Separate read-only attribution inspection confirmed a reporting limitation:
newer Claude assistant records can omit the upstream request ID, preventing the
existing request-ID reconciliation from matching native observations to proxy
observations. Repeated assistant content blocks can carry the same usage tuple.
Matching session, model, and token buckets established overlap in the inspected
records, but this receipt does not introduce a heuristic deduplication rule or
claim exact request identity from those fields alone. Private source records and
consumer identifiers remain outside this repository. A follow-up must preserve
legitimate repeated requests and retry attempts while reconciling observations.
The quota patch does not repair historical accounting totals.

Snapshot delivery was current during the audit while browser-dependent operations
timed out. Provider snapshot freshness, website/CDP availability, routing quota
projection, and consumer attribution therefore require separate status evidence.
The overview currently offers month-wide client/model rankings; it does not expose
the account and time-window breakdown needed to explain a particular quota limit.

### Retained-week attribution follow-up

The September ledger and tap journal span the inferred current weekly windows
(provider reset minus seven days). This establishes retained time coverage, not
complete ingestion or complete account activity. The journal records four HTTP403
drain failures during September7 and two tap restarts. Earlier operation also used
a one-record batch against a finite-retention queue, so unobserved traffic cannot
be reconstructed merely from the presence of a monthly ledger file.

Only proxy observations were aggregated by account; native rows were not added to
them. After session metadata became available on September7, exact proxy session
IDs could be resolved against local native log paths. Before that, account/client/
model evidence survives but project attribution is incomplete. A bounded scan of
14,556 matching native log files found 33,913 assistant records and no upstream
request IDs; it therefore recovered no exact earlier request-ID joins. Matching
token tuples near the same timestamp offers corroboration only, not exact request
identity, and was excluded from the proven project totals.

The two accounts have different histories: one has no successful retained Claude
requests on September9–10, while the other still has successful activity then.
Consequently a recent high-volume consumer cannot alone explain both whole-week
limits. Known session-linked consumers, unknown pre-session observations, native
activity outside the proxy, and shared client-key labels must remain distinguishable.
Token buckets and failed attempts do not translate into provider quota percentages.
Private per-account aggregates and session mappings are retained in the operator
audit context, not this public-source document. No further code or live changes
were made for this attribution follow-up.

## Reliability candidate — September 10, 2026

Issues #23, #24 and #25, with the application side of #26, are addressed by the
following source changes. This receipt describes a tested candidate, not a live
rollout or a claim that every subscription has an automatic adapter.

- An inactive zero-use Claude session window no longer discards a valid exhausted
  weekly window. Active malformed and stale windows remain unknown.
- Native assistant message IDs survive collection. Repeated content blocks for the
  same native message are collapsed before routing enrichment. Native records
  without an exact upstream join are retained as unresolved observations and are
  excluded from confirmed request/token subtotals. Identical token counts alone
  never identify a duplicate. Combined totals remain unknown where overlap exists;
  confirmed subtotals do not establish complete historical capture or quota shares.
- The first view shows account quotas, observation freshness, source failures and
  the configured CLIProxyAPI management link. Account usage rankings accompany the
  confirmed subtotal. Independently declared accounts have their own provider
  website and optional operator note; inventory does not imply quota, funds or
  successful authentication. A direct Meta account remains separate from an
  OpenCode model route. Unsupported sources stay explicitly unknown.
- Dashboard rendering never polls dedicated browser identities. Manual account
  access is explicit; ordinary provider links work independently of browser CDP.
  Identity freshness ages locally without network polling. A manual lease can be
  reopened, renewed and explicitly closed before another account opens. No tracked
  lease means closure cannot be confirmed, including after an app restart; an
  outstanding controller lease then expires by its bounded TTL.
- API/snapshot sources publish results independently while browser sources run
  serially. A failed shared refresh can recover. The existing collector optionally
  requests one bounded dashboard refresh after delivering its snapshot; no extra
  polling daemon is introduced.

### Optional deployment configuration

`AI_BILLS_BROWSER_LIFECYCLE_URL` and `AI_BILLS_BROWSER_LIFECYCLE_TOKEN` enable the
reviewed external lease controller. Browser quota accounts require `cdp_profile_id`
matching an allowed controller profile; manual browser bindings already carry a
profile ID. Acquisition allows 60 seconds and release 40 seconds. The controller
owns capacity, memory admission, exclusivity and TTL expiration. A quota scrape
must not take over a live manual account browser. Without lifecycle configuration,
legacy behavior remains available; enabling the controller is an explicit rollout
step, not an automatic consequence of deploying this source.

`AI_BILLS_BROWSER_REFRESH_URL` enables the existing collector's post-delivery
refresh hook (240-second whole-job bound). Keep the existing single-instance lock
and five-minute schedule. Configure the fixed SSH snapshot receiver so refresh
follows successful delivery, rather than running before a separate wrapper copy.
Do not execute production collectors merely to test these changes.

`accounting.declared_accounts` accepts `website_url` and `operator_note`. Both are
operator declarations, never provider verification. Explicit identity bindings can
merge a declared account with its known proxy inventory record while preserving
these annotations; accounts are never merged by a display label alone.

`GET /api/health` is read-only: it returns process availability plus expected
configured source observations (`status`, `observedAt`, `maxAgeSeconds`). Browser
sources include `cdp_path` historical observation with `live: false`; this is not a
live path probe. Missing/stale/failed expected observations degrade collection.
Unsupported independently declared accounts are coverage gaps, not required
background jobs. Monitoring must not use `/api/usage` as a passive health check,
because its TTL can start collection.

### Validation and acceptance boundary

The candidate passed 166 JavaScript tests across 18 files, the TypeScript check,
18 accounting collector tests, six provider quota tests and a production build.
Local browser acceptance uses synthetic accounts: the first screen and
subscriptions send zero unsolicited account-browser requests, management and
provider links are visible, unresolved combined totals remain explicit, and the
mobile layout fits a 390-pixel viewport. Backend lease tests cover repeated open,
renew, explicit close, switching accounts under a one-browser capacity limit, and
unknown ownership after restart. No production inference or browser login was used.

The live acceptance still requires an approved packaged rollout, existing session
preservation, one-browser memory canary, successful scheduled source refreshes,
manual open/close/switch from the actual clients, and replacement monitoring that
covers active consumers. Unsupported provider quota adapters and missing historic
usage identifiers cannot be recovered by a UI change. Neither existing usage logs
nor proxy auth enabled/disabled state are rewritten by this candidate.

### Compact status overview follow-up

The Overview now starts with compact account rows: allowance, reset, source freshness
and manual/provider access. Desktop acceptance requires all six configured fixture
accounts within the first 850-pixel viewport, with the first row above 200 pixels.
Header and navigation are compact; summary KPI cards, hypothetical API cost and
subscription price tables live in their dedicated accounting/subscription views.
Unknown source status and independent account declarations remain visible.

### Post-rollout access correction

Live acceptance found two deployment gaps that the original fixture did not model:
browser quota accounts retained legacy CDP endpoints while acquiring newly bound
profile leases, and two configured accounts had no linked subscription-plan entry,
which hid their manual access control in the compact row. The follow-up configuration
must use the endpoint of the exact leased profile. Account controls now fall back to
the configured account selector when a subscription link is absent; a regression
fixture deliberately omits those plan links. Duplicate provider prefixes and merged
provider/account label text are also corrected. Provider sign-in and quota readiness
still require live verification; successful CDP discovery alone is insufficient.

## OpenRouter automatic account credits and current-key usage

Issue #28 adds two bounded read-only API observations to the existing five-minute
snapshot collector: account-wide `/api/v1/credits` and current-key `/api/v1/key`.
They are independent scopes. Account remaining credit is total credits minus total
account usage; current-key usage is not the account's total usage. A null key limit
means no per-key spending cap, not unlimited account funds. No inference, model
availability check, browser login, funding operation or new daemon is involved.

The collector reads its credential from stdin, projects only numeric fields and
source status, rejects redirects, and never includes provider labels, hashes, raw
errors or credentials in the snapshot. Each endpoint has a ten-second deadline;
a credits permission failure does not hide an otherwise valid key observation.
Invalid numbers and failed/stale observations never become a zero balance.

The operator enables `AI_BILLS_OPENROUTER_SECRET_NAME` in the existing collector
environment and sets `accounting.openrouter_account_id` to an explicitly declared
account ID. The latter attaches the funds observation only to that account (or its
explicit identity binding), not every inventory row named OpenRouter. The dashboard
shows account balance/spend separately from key usage/cap and exposes both source
freshness states. Passive health reads the delivered snapshot; it never contacts
the provider. Financial journals and token accounting remain separate evidence.

Official reference: [account credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits).
The local candidate passed collector failure/allowlist tests, account/key scope and
staleness tests, explicit registry binding verification, TypeScript and build. A
bounded live read-only collector call returned both sources successfully. A captured
balance is a timestamped observation, not proof of subsequent inference availability.

### OpenRouter rollout verification (2026-09-10)

Source `356f3bd` is deployed. The existing scheduled collector delivered both independent API observations at 18:40 UTC; production showed exactly one bound OpenRouter account, fresh credits/key sources, and the configured CLIProxyAPI identity association. Browser acceptance issued zero account-browser requests. A separate automation routing policy is not evidence that a directly configured proxy account is disconnected. The optional failed-acquire browser guard remains outside this deployment. No inference was performed by this collector or its acceptance checks.
### Live acceptance and restart race

The compact UI and access correction were deployed through the application lifecycle
owner on September 10. Six configured account rows fit in the first desktop viewport;
manual controls also exist for configured accounts with no linked plan. The next
scheduled snapshot delivered fresh API-source observations. The requested Claude
management destination is `https://claude.ai/new#settings/usage`.

Kimi and Cursor manual leases both passed open, reopen, renew and explicit close,
with no active profile after close and a successful switch under capacity one.
Quota collection now reaches their intended browser profiles. The existing website
sessions are not authenticated for quota collection: Kimi reports a missing auth
cookie and Cursor returns HTTP401. These remain source/sign-in gaps, not zero quota
or proof that proxy OAuth is broken. No sign-in credentials were entered or changed.

A point-in-time idle deployment check is not a quiescence barrier. An automatic quota
lease started between the check and app recreation, leaving the old process's lease
until its five-minute controller TTL. Cleanup verified the exact lease ID, quota
purpose and start time before the new app's start, then released only that orphaned
quota lease through the normal controller API. The container/controller stayed up;
manual leases were not touched. A future coordinated refresh pause would remove
this race. Until then, verify ownership before any cleanup and never treat every
active browser as disposable during deployment.

## Limiting window and rolling 24-hour recency — 2026-09-18

`GET /api/accounts` and the Overview quota card chose the fuller of Claude's
five-hour and seven-day windows, so the scoped model week (`weekly_scoped`) that
Claude actually marks `is_active` was invisible: a Work account showed 57 % left
while its Fable week had 17 % left. Both surfaces now use one selector: the
window flagged `is_active` wins (the most used one when several are active);
without any flag the most used window, scoped windows included, is the limit.
Reset times follow the selected window.

The report's rollup gained `last_24h` (`period: "rolling_24h"`), a `rate_limited`
counter (HTTP 429, a subset of `failed`), a `by_upstream` breakdown keyed by
provider and account, and `last_request_at` per account and upstream. Native rows
without an account still stay out of these breakdowns until they are attributed.
The overview exposes the rolling window as `usage.last24h` only when the collector
labels it as such; calendar-day figures are never relabelled. Account names that
are raw API keys are shown as fingerprints.

Validation: `tests/accounting-collectors.test.py` (20 tests) and the Vitest suite
pass; no collector installation, deployment or ledger rewrite was performed.

## Native identity attribution — 2026-09-18

Native Claude Code logs no longer carry a request id, so the request-ID join that
kept native and proxy observations apart stopped matching anything: every native
Claude row became `unreconciled_native` and no native usage reached the per-account
breakdowns. Two changes:

- The extractor stamps the signed-in identity on every native row (Claude Code
  OAuth email from the client config; Codex email from each configured home's
  `auth.json`), and the direct collector stores it as `account` with `provider`
  set only when the log names a native model. Extra Codex profile homes are
  declared per host in `hosts.json` (`codex_homes`); nothing is bound by hand.
- The report reconciles native Claude rows by fingerprint: identical base model
  and token buckets seen by the proxy within ten minutes is the same request and
  the proxy row is kept. Unmatched rows with identity are attributed; unmatched
  rows without identity stay unreconciled.

Read-only replay on the live ledger: in the rolling 24-hour window 2,064 of 2,293
native Claude rows matched a proxy row (median distance nine seconds) and the
unreconciled count fell from 754 to 4; for the month it fell from 44,002 to
13,516, the remainder being historical rows written before identity stamping.
Residual risk: a native row for a proxied request whose tap row is missing would
be attributed to the host's signed-in account rather than the proxy credential.

Validation: `tests/accounting-collectors.test.py` (23 tests) passes; no collector
installation, deployment, provider inference, account change or ledger rewrite
was performed.

## Statement import and reconciliation — 2026-09-19

`POST /api/accounts/accounting/import` turns a provider's CSV export into financial records
(`{csv, sourceId, accountId, provider, kind, currency?, mapping?, dateFormat?, dryRun?}`).
Columns are matched by header name: date, amount, currency, reference (invoice number / id)
and description are detected from common headers, or named explicitly in `mapping`. The
statement's own reference is the `sourceRecordId`; without one, a digest of the row's date,
amount, currency and description is, so re-importing the same export inserts nothing twice.
Slash-separated dates are refused unless `dateFormat` is `mdy` or `dmy`; ISO and month-name
dates are always read. Amounts accept currency symbols and codes, thousands separators and
parentheses for negatives. Rows that cannot be read are returned as `skipped` with the row
number and reason; `dryRun: true` returns the same preview and writes nothing. Limits: 2 MB,
5000 rows. The dashboard's "Import a statement" form previews first, then imports.

`GET /api/accounts/accounting?month=` now carries `reconciliation`: one row per provider
(names normalised, gateway prefixes dropped) comparing the month's statement figure
(accruals when present, otherwise payments; USD only) with the ledger rollup's API-equivalent
for the same month. Statuses: `matched` (difference within 5% or $1), `partial` (both sides
present, larger difference), `no-usage-evidence` (statement without priced usage rows, or the
ledger rollup is for another month), `no-invoice` (priced usage without statement records).
The difference is displayed, never applied to either side; unpriced requests and non-USD
records are named in the note.

`[accounting.fx_rates]` declares conversion rates the operator vouches for:

```toml
[[accounting.fx_rates]]
currency = "EUR"
rate_to_usd = 1.08
as_of = "2026-09-01"
```

Records keep their own currency; with a declared rate they enter the USD totals, and the
overview's diagnostics name the rate and its date. Currencies without a rate stay excluded as
before. Malformed rates (non-positive, non-ISO code, no date) are ignored, not applied.
