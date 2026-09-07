# Request routing and paid admission

Issues #9 (runtime), #10 (native managed execution), and #11 (integration) own this P1 work.

The standalone Python service keeps the last applied policy, session bindings, request
attempts, and an append-only export outbox in its operational SQLite journal.
An independent sibling `<database>.budget.sqlite` is the paid liability authority. It does not
depend on the dashboard or collectors to serve requests. Credentials and actual
account identities stay in a private runtime JSON file and environment variables;
the public policy uses operator-assigned logical IDs.

## Run and test

```sh
cd routing
uv sync
uv run pytest
uv run python server.py --config /path/to/private-runtime.json
```

Start from `routing/fixtures/runtime.example.json` and apply a reviewed policy based
on `routing/fixtures/policy.json`. These fixtures contain fictional models and accounts;
they are not a production model recommendation. A new database starts with an empty
catalog and denies inference until accounts, client subsets, and approved models
are applied. The `database` parent directory must already exist.

## Dashboard control contract

Every `/control/*` request requires `Authorization: Bearer` with the value referenced
by `control_token_env`. The dashboard backend forwards it; browsers never receive it.

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /control/state` | — | `policy`, `budget`, `requests`, `suggestions`, `capabilities` |
| `GET /control/events?after=0&limit=100` | — | `events` (`seq`, `kind`, `body`, `created_at`), `next_cursor` |
| `POST /control/policy/validate` | `{ "policy": ... }` | `valid`, `errors`, `diff`, `active_version` |
| `POST /control/policy/apply` | `{ "policy": ..., "expected_version": 1 }` | applied `policy`, `active_version`; 409 on conflict |
| `POST /control/suggestions/:id` | `{ "action": "accept", "expected_version": 1 }` | `suggestion`, active `policy`, `proposed_policy` |

Accepting a suggestion only prepares a proposal. It never modifies the active policy;
the operator validates and explicitly applies the resulting draft. Rejection sets
the suggestion status to `rejected`. Policy `version` is assigned transactionally by
the service, not trusted from the draft. State reads return the loaded applied version.

Events are non-destructive cursor reads. Consumers persist their cursor after an
idempotent import. Admission IDs join attempt telemetry to native usage; do not add
router usage to native token totals as if they were different requests.

## Weekly catalog suggestions

The service's managed process runs a metadata refresh task every minute, checking
each source only when its interval is due (default seven days; retry failed metadata
reads hourly). Configure private `catalog_sources` entries with `id`, `kind`, and
either `url` plus optional `api_key_env` for `openai-models`, or `path` and
`provider_id` for `opencode-cache`. Optional `account_id` matches existing routes;
`model_prefix` sets proposal IDs. Source endpoints and credential references are
not included in control state. State `discovery` exposes only source ID, check and
success timestamps, and a sanitized failure indicator.

New metadata entries generate deduplicated hidden suggestions with unknown prices,
no assumed callable protocol, and no enrolled routes. Accepting such a proposal can
save it as hidden inventory; the operator must fill verified bounds, routes and
capabilities before approval. A model disappearing from a previously read catalog
creates a review suggestion, not automatic removal or an assertion of unavailability.
Catalog size and HTTP read time are bounded; discovery performs no inference.

The example policy defines the exact model, role, account, and client shapes. Model
status `hidden` removes it from discovery and new selections but allows an existing
bound session to continue; `denied` prohibits all dispatch. Removing a model from a
client subset also prohibits dispatch, including existing sessions. New provider
catalog entries must be enrolled into the policy before becoming selectable.

Prices are **integer micro-USD per million tokens**: a rate of $1/M is `1000000`.
All four prices (`input`, `output`, `cache_read`, `cache_write`) are required, or
`prices` is null. **Dispatch uses route-specific prices**, with `price_version` and
`price_evidence` bound to that exact account and upstream route. Model-level prices
are display estimates only. A route's optional `upstream_canonical_model` approves
one exact canonical target when `upstream_model` is a registered native alias.
Native must resolve that alias to exactly one target and verify equality; model pools
are not accepted. Each admission stores its canonical model and immutable price snapshot, so
later policy edits cannot change settlement. Zero is a known zero price; null is unknown. Unknown prices cannot
admit a paid attempt. Usage cost is a ceiling-rounded integer micro-USD amount.

Request rows have `id` (attempt ID), `request_id`, `client_id`, `session_id`,
`requested_model`, nullable `role`, actual logical `model` and `account_id`,
`billing`, `status`, `admitted_date`, `reserved_microusd`, nullable `cost_microusd`,
`created_at`, nullable `fallback_reason`, normalized `usage`, sanitized `error`, and
`policy_version`. Prompts and outputs are never written to the ledger or outbox.

## Inference contract

Client API keys are environment references under runtime `clients`; one key maps to
one logical client. `/v1/models` exposes only that client's approved models and roles.
Each entry includes `context_length`, `max_output_tokens`, and `tool_call`. Only
models whose policy explicitly records evaluation-verified `tool_call: true`
advertise tools. A role advertises tools only when all its approved client candidates
do; its exposed limits are the minimum across those candidates.
Dispatch enforces the same subset even when the caller guesses a hidden model ID.
Supported paths are `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`.

Supply a stable `X-Session-ID` for the conversation. `Session_id`,
`X-OpenCode-Session-ID`, `conversation_id`, and supported metadata session fields are
also accepted. Missing identity is rejected; the service does not pretend a prompt
hash guarantees stable sessions. Concurrent requests in the same session return 409.
Different sessions may run concurrently under a shared atomic budget.

Send a fresh `X-Request-ID` for each logical model call, preserving that value across
SDK HTTP retries. The service stores it per client and rejects duplicates with 409,
including after a restart. `X-Client-Turn-ID` optionally joins several model calls in
one client turn. Neither replaces the gateway's immutable request and attempt IDs.

Models are sticky within a role session; manual selections retain the exact model
across account fallback. For a new session, included routes precede paid routes; an
existing bound model is attempted first across its eligible accounts. `general-cheap`
ranks paid candidates by the conservative reservation for the current request, using
known route prices; this bounds additional cost rather than predicting token usage.
Fresh quota observations
prioritize remaining quota relative to its reset; unknown quota permits included
attempts without treating unknown as zero or infinity. Fresh zero quota is skipped
until reset, after which its status becomes unknown until observed again.

Private `quota_snapshot_path` reads the collector snapshot's `account_quotas` map:
`{ "account_quotas": { "24-character-opaque-account-id": {
"observed_at": "ISO timestamp", "reset_at": "ISO timestamp",
"remaining_fraction": 0.6, "max_age_seconds": 600 } } }`.
Collector IDs use the account registry's SHA256(`oauth:` + filename) prefix (24 hex
characters), preventing ambiguous email matches from combining accounts. Optional
account `quota_source_key` maps a distinct policy identity to this canonical ID.
A standalone `{ "accounts": ... }` projection remains supported; optional runtime
`quota_projection_field` selects another top-level field. Request/control reads
reload the file; malformed, missing, expired, and reset-passed data becomes unknown.
Paid API bindings use
`quota_mode: "metered"`: subscription remainder is not invented for metered APIs.
Account `provider` matches native capability provider IDs; `account_health` reports
unsupported native executors separately from quota exhaustion or unknown quota.

Fallback occurs only among approved compatible role candidates or accounts for a
manually selected model. It never replays after bytes have been delivered, nor after
an uncertain transport failure. Response headers expose request/attempt ID, actual
logical model/account, applied policy version, and fallback reason. Authenticated
`GET /v1/routing/events?session_id=...&after=0` provides non-destructive receipts
limited to the authenticated client and exact session. It returns `events` with
`seq`, `kind`, `created_at`, and `body` containing `attempt_id`, `request_id`,
`client_request_id`, `client_turn_id`, `role`, `model`, `account_id`,
`fallback_reason`, `status`, and `error`, plus `next_cursor`. No native auth ID or
provider credentials are exposed. Clients must render
the fallback signal to meet the visible-notification requirement; server headers alone
do not prove a visible client notification.

## Strict budget boundary

Paid admission uses `BEGIN IMMEDIATE` in the independent budget authority.
The operational journal retains policy/session state when that authority is
unavailable: included routes continue; paid dispatch fails closed with 503. Control
state reports `budget.available: false` with null spend/reserved fields, so the UI
shows unknown allowance and a clear status. Losing the operational journal or the
whole writable filesystem blocks all routes because durable session/attempt
recording is then impossible.

On first upgrade, existing paid rows across every day are imported while holding the
operational write lock, then a durable migration marker is committed. Restarting
an interrupted migration preserves existing authority rows. Once marked, a missing
or corrupt budget database is never recreated as an empty allowance. Backups and
rollback must retain **both databases**; deleting the authority does not reset budget.
New paid liability is committed before the operational attempt; a later journaling
failure retains an orphan liability and sends no request. Settlement receipts can be
recorded during an authority outage; recovery reconciles them idempotently, retaining
the higher reservation until then.

Paid spend plus all open reservations cannot exceed
$2 for the admission date in `Asia/Jerusalem`. A request admitted before midnight is
settled against that original date, even after midnight or a process restart. Unknown
usage, interrupted streams, missing native receipts, and crashes retain reservations;
there is no timeout that silently frees uncertain spending. An old crashed session
also retains its pending guard and needs explicit reconciliation before reuse.

The reservation is the verified upstream model's **maximum context capacity** plus
its enforced output cap, at the greatest known applicable input/cache price. An
arbitrary smaller app input setting does not prove a bound and must not be used.
Each paid account binding therefore requires private `verified_input_limits`, keyed
by canonical upstream model, with `{ "tokens": 32000, "evidence": "provider source" }`.
Admission reserves the larger of this verified capacity and the public policy input
limit; missing proof blocks paid dispatch. Editing policy cannot lower this bound.
This is conservative and can reject large-context paid routes. Client-body byte
estimates are ignored, including entries marked `verified`: native translators and
payload rules may add content after those estimates. Any future tightening requires
verification of the final upstream request. Unpriced hosted tools, images/audio,
external context references, and paid priority tiers are rejected. Ordinary client-side
function schemas are allowed and included in the input bound. Reasoning tokens count
inside the completion cap and output usage; they are not double-counted.

## Native managed attempt boundary

The service requires an owned CLIProxyAPI extension pinned to upstream commit
`934fb7928c42a8dd0aeaf39a321bef6601b55eb6`. Unmodified CLIProxyAPI has SDK account pinning,
but does not expose the required HTTP contract or a reliable one-attempt guarantee.

The native handshake is `GET /v0/management/ai-bills-capabilities`, authenticated by
`X-AI-Bills-Token`, returning `{ "version": 1, "exact_account": true,
"single_attempt": true, "usage_receipts": true }`. Generation requests also carry
`X-AI-Bills-Managed: 1`, `X-AI-Bills-Attempt-ID`, and `X-AI-Bills-Auth-ID`, alongside
the configured native API credential. Native replies must echo attempt and auth ID
and `X-AI-Bills-Managed-Version: 1`. These private headers must be consumed and stripped
before upstream dispatch. The router does not forward the native auth ID downstream.

The native extension must enforce exactly the chosen account and one upstream
generation attempt, disabling retry rounds, alias-pool fallback, unauthorized refresh
replay, stream bootstrap replay, inner executor retries, and implicit credits for each
managed request. A selected-auth hook alone cannot meet that contract. The service
fails closed until native capability and per-response receipts are verified.

Paid requests additionally send `X-AI-Bills-Max-Output` and
`X-AI-Bills-Service-Tier: default`. Native validates the final transformed upstream
request against the exact model, output bound, and priced tier, after payload overrides.
An executor that strips the required cap must refuse the paid request before dispatch.

Paid settlement requires the non-destructive native endpoint
`GET /v0/management/ai-bills-receipts/:attemptID` with both configured credentials.
It must match attempt/auth/model and report `terminal`, `usage_complete`, and no
failure. Native `usage.input_tokens` excludes both cache buckets; `output_tokens`
includes reasoning once; `cache_read_tokens` and `cache_write_tokens` are disjoint.
The service retries receipt reconciliation every minute using the immutable admission
price snapshot. Missing receipts after a native restart keep the reservation open.
Provisional translated response usage is never enough to settle a paid request.

## Managed installation

`routing/deploy/ai-bills-routing.service` is an example system service with a dedicated
unprivileged account. Install a reviewed repository release in `/opt/ai-bills-routing`,
then run `uv sync --project /opt/ai-bills-routing/routing --python /usr/bin/python3 --frozen --no-dev`
with a supported system Python to provision locked dependencies. Verify that the
virtual environment interpreter resolves outside home directories because the unit
uses `ProtectHome`. Adapt the service paths to the host, placing
private runtime JSON and the environment file in `/etc/ai-bills-routing` with access
restricted to the service identity. Configure the database beneath its writable
`StateDirectory`, and place an atomically replaced quota snapshot at a service-readable
path. `ProtectHome` means a snapshot under a user's home is not readable by this example.
Keep the listener on loopback or a protected private interface; expose only authenticated
routes needed by clients. Native credentials stay local to the native host.

Before activation, verify the managed native capability/receipt contract and save the
current native binary, service settings, dashboard configuration, and router database.
Install the unit through the host's service lifecycle manager, validate its environment
without printing values, and start it against an empty or reviewed policy. Apply a
validated policy through the authenticated control endpoint and check the acknowledged
version. Update native through the owned managed-artifact workflow so an automatic
official-binary update cannot silently remove the required contract. Rollback switches
the service release and policy deliberately while retaining the admission journal;
never replace either database with an older copy that forgets admitted paid requests.
