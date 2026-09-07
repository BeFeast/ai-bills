# Managed native execution v1

This patch is pinned to upstream `router-for-me/CLIProxyAPI` commit
`934fb7928c42a8dd0aeaf39a321bef6601b55eb6` (v7.2.153). It is not a replacement
upstream source tree. Build with `build.sh SOURCE_CHECKOUT OUTPUT_BINARY` in a clean,
isolated checkout of that commit. No service installation or restart is performed.

Both ordinary API authentication and the private `AI_BILLS_MANAGED_TOKEN` are required.
The server strips the private headers before request logging and upstream execution.
The HTTP request contract is:

- POST `/v1/chat/completions`, `/v1/responses` or `/v1/messages`.
- `X-AI-Bills-Managed: 1` and `X-AI-Bills-Token` matching the private server environment.
- `X-AI-Bills-Attempt-ID`: fresh UUID; duplicate attempts are rejected.
- `X-AI-Bills-Auth-ID`: actual manager `auth.ID`, never `auth_index`.
- `X-AI-Bills-Upstream-Model`: exact canonical provider model. It must match the
  requested public alias mapping for the selected account; native model pools are
  never retried. Kimi canonical normalization is applied explicitly.
- Optional `X-AI-Bills-Request-ID`: gateway logical request ID, copied into queue joins.
- Paid attempts require `X-AI-Bills-Max-Output` and `X-AI-Bills-Service-Tier` (default).

The manager looks up the exact enabled auth and validates model registration, then
calls only an audited HTTP executor once. It bypasses model pools, account selection,
Home dispatch, auth refresh/replay and after-auth request mutation. Managed requests
also bypass model-router and before-auth plugins. Codex Auto/WebSocket wrappers select
Codex HTTP explicitly. Only Claude, Codex HTTP, Kimi and OpenAI-compatible HTTP executors
opt in; unsupported executors, including Antigravity/credit fallback, reject execution.
Non-managed requests keep the existing paths and behavior for ordinary accounts.
Configure `AI_BILLS_MANAGED_ONLY_AUTH_IDS` as comma-separated actual account IDs for
all paid upstreams. Those accounts reject ordinary/Home execution and direct executor
HTTP calls without a matching managed attempt and output reservation. This prevents
existing ordinary API credentials from bypassing the router's paid budget. Provider
credentials and privileged administration remain operator authority, not a gateway
spending boundary.

An atomic claim blocks any second generation invocation in the same request context,
including handler bootstrap retry. A shared HTTP transport guard blocks additional
network dispatches, redirects and body replay. It checks the final translated JSON
model. Paid requests additionally require an actual output cap at or below admission,
a cap field supported by the actual final endpoint, the priced service tier, one generation (`n`, `best_of`, `candidate_count`), and no
unpriced fast mode/provider-built-in tool or malformed tool list. Final paid payloads
also reject external content, audio/image modalities, retained conversation context,
background generation and prediction before network dispatch. Missing
provider cap support fails closed. Paid input bounds and provider pricing remain the
gateway's responsibility: reserve the provider-enforced maximum input/context size,
not an arbitrary lower application estimate. The native adapter has no generic
provider tokenizer. Unknown provider ceilings/prices must keep paid routes blocked.

Only manager-accepted execution sets `X-AI-Bills-Managed-Version: 1`, echoed attempt,
actual auth and requested upstream model headers. Header acceptance is not proof of
successful inference or zero cost. Query final evidence without consuming the usage
queue at `GET /v0/management/ai-bills-receipts/:attemptID`, using ordinary API auth and
private token (omit the managed POST flag). Capabilities are at
`GET /v0/management/ai-bills-capabilities` with the same authentication.

Receipt fields: `attempt_id`, `auth_id`, `model`, `accepted`, `started`, `terminal`,
`complete`, `failed`, `usage_complete`, `usage_known`, `observed_at`, and `usage`.
Normalized usage input is **uncached** input; cache read/write are separate disjoint
buckets. Output includes reasoning exactly once. `token_breakdown` is the upstream
SDK v2 canonical contract. Only valid complete accounting with positive total usage
sets `usage_complete`; absent/ambiguous/failed usage never becomes zero.
`billable_zero` is true only for a failed managed invocation before any guarded HTTP
dispatch. A dispatched failure remains potentially billable.

Receipts are process-local, non-destructive and bounded to 100,000 attempt IDs without
eviction; capacity fails closed. They do not replace the gateway's durable budget
journal. Native restart loses receipts: missing evidence must retain unresolved
liability, never release a reservation. The existing single usage-queue consumer is
unchanged; queue records add `attempt_id` and `managed_request_id` for gateway joins.

OpenAI-compatible execution defaults to chat/completions. Explicitly bind
Responses-only upstream account IDs in `AI_BILLS_RESPONSES_AUTH_IDS`; managed calls
then use `/responses` with the generic Responses translator, including streaming
terminal events and normalized usage. It does not apply Codex-specific transforms.
The base URL contains the provider prefix such as `/zen/v1`, not `/responses`.
Fixtures verify both client protocols (chat/completions and Responses), stream and
nonstream; live Muse access and current zero-price evidence remain rollout checks.
Do not mix chat-only and Responses-only models under the same account binding.

Validation covers manager error/stream replay, actual HTTP executor error paths,
transport header/cap/model/tier controls, private middleware/duplicate IDs, plus
existing unauthorized-refresh, bootstrap and usage queue regression tests. These use
local fake providers, never real inference. The compiled binary and checksum are
operator artifacts outside the source repository; rollout is owned separately.
