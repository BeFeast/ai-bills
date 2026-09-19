# Usage collectors

These are the existing collector sources. Publishing them does not install or enable them.
The tap owns the consumptive proxy usage queue and appends to the ledger. Direct collectors
merge Claude/Codex records with cursors and deduplication. Never start a second queue reader.

## Configuration

Keep deployment values and secrets outside git. The snapshot collector requires:

- `AI_BILLS_PROVIDERS_DIR`: provider Markdown directory.
- `AI_BILLS_PAYMENTS_FILE`: private payments YAML.
- `AI_BILLS_MAESTRO_DB`: existing orchestrator SQLite database (read-only access).
- `AI_BILLS_SNAPSHOT_TARGET`: approved SCP destination for the snapshot.
- `INFISICAL_PROJECT_ID`: secret-manager project identifier.

`AI_BILLS_INFISICAL_ENV` overrides the machine environment file; its default is
`~/.config/infisical/machine.env`. It supplies API URL and universal-auth credentials.
`AI_USAGE_KEYS_FILE`, `AI_BILLS_CLIPROXY_AUTH_DIR`, and `AI_BILLS_CLIPROXY_MGMT_URL`
configure local proxy access. Tokens remain local to their owner.

`AI_USAGE_PRICING` selects pricing YAML; the default is
`~/.config/ai-usage/pricing.yml`. Existing hosts/key mappings remain private operator files.
Python operations use uv; the Python reporting utility also needs PyYAML available in
its approved runtime. Remote extractor shell settings remain per-host configuration.

The systemd files are source examples. Review runtime paths/dependencies before any
installation. Source import leaves existing schedules, collector state and permissions
untouched. Provider balance and token estimates are not verified invoice spend.

## Proxy-owned quota observations and registry bindings

The snapshot collector includes `codex_usage` from `ai-codex-quotas`, using a
read-only WHAM request with the proxy-owned access token and account header. It
never refreshes tokens. Each account has its opaque registry ID; an email lookup
is added only when unique. Failures retain their observation time and HTTP status.
`AI_USAGE_REPORT_BIN` overrides the report executable for staged deployments.

An app account may set `quota_snapshot_key` to its opaque proxy registry ID. This
explicit binding prefers collector evidence and prevents a fallback credential
refresh when the source is missing or reports an error. Existing unbound profiles
retain their original direct path when no matching snapshot exists.

`accounting.account_bindings` is a private array of `{id, members, label?,
quota_account_key?, billing_mode?}`. `members` contains known opaque registry IDs;
`id` is the canonical identity used by the routing policy and manual records.
Only these explicit aliases merge identities; shared email or provider names do
not. `quota_account_key` references an existing app account's key. Billing mode is
never inferred from OAuth filenames. Exact native auth bindings remain exclusively
in the routing service's private configuration.

Account inventory reads cached quota observations without polling providers. It
also uses matching collector quota observations, retaining their source timestamps.
Unsupported, stale and failed quotas remain unknown. Routing enrollment is read
from the active authenticated control policy, and becomes unknown on control-source
failure. `accounting.declared_inventory_complete` can mark the operator's declared
external inventory complete; it does not assert quota or financial completeness.

The report's `--rollup` output preserves `today` and adds `month`: the complete
current calendar month in `AI_USAGE_TIMEZONE`, independently of trend length.
Both carry per-client/model rankings, full API-equivalent (null if any price is
missing), and `priced_api_equivalent_usd` as the known subtotal. Ledger files are
never rewritten. Rankings sort by total tokens; API-equivalent is not a debit.

Native rows carry the identity the client is signed into on the host: `ai-usage-extract`
reads the Claude Code config (`~/.claude.json`, or `CLAUDE_CONFIG_DIR`) for the OAuth
email and each Codex home's `auth.json` for the id-token email, and stamps it as
`account_email`; `ai-usage-collect-direct` stores it as the ledger `account` with
`provider` set only when the log names a native model (`claude-*` in a Claude log, any
non-proxied Codex session). A host entry in `hosts.json` may list extra profile homes:
`{"host": "box", "codex_homes": ["/home/me/.codex-work"]}`; the default home
(`CODEX_HOME` or `~/.codex`) is always scanned. API-key Codex auth has no email, and a
signed-out client leaves `account` empty.

Current Claude Code logs carry no request id, so the report reconciles native Claude
rows against proxy rows by fingerprint: the same base model and identical token buckets
observed by the proxy within ten minutes is the same request, and the proxy row (which
names the credential that served it) is kept. Native rows that match nothing and carry a
signed-in identity are attributed to that account like proxy rows; rows without identity
remain `unreconciled_native` and stay out of unique totals and rankings.

`last_24h` is a third projection with `period: "rolling_24h"`: every row whose
timestamp falls in the 24 hours before the report ran, independent of the report
timezone, so it never empties at midnight. It is recency evidence for the
dashboard, not a substitute for the calendar day or month. Every projection also
reports `rate_limited` (rows the provider answered with HTTP 429; a subset of
`failed`) and a `by_upstream` breakdown keyed by provider and account with
`last_request_at`, because one identity can serve several providers and
upstream-key providers are only identifiable by provider. `by_account` keeps
merging one identity across providers and now carries `last_request_at` too.

Provider frontmatter can declare individual `subscriptions` with plan, amount,
currency, month/year period, renewal/end dates, account keys, manage/login links
and evidence. The collector only projects allowed metadata fields. Optionally set
`AI_BILLS_SUBSCRIPTIONS_FILE` to a private JSON array of the same individual plan
records; these travel with the snapshot and survive later collection. Explicit
`[[subscriptions]]` in app config override source records for that provider.
Unknown renewal dates stay null; quota reset times are never renewal dates.

## Alerts

`ai-bills-alerts` turns the snapshot into edge-triggered notifications without a
second source of truth: it reads the snapshot the collector just produced, never a
provider. Rules (thresholds match the dashboard): remaining allowance on the limiting
window per Claude/Codex account (warn below 25 % left, bad below 10 % or exhausted),
HTTP 429 counts in the rolling 24h window, failed or stale sources including the
snapshot itself, subscriptions renewing or ending within a few days, and the OpenRouter
prepaid balance. A condition is notified once when it enters a non-ok state or
escalates and once when it recovers. Per-condition state lives in the state directory,
history in `alerts-YYYY-MM.jsonl`, and `alerts.json` is included in the next snapshot
under `alerts` so the dashboard shows current conditions and recent events. Delivery is
ntfy topics from the private config (`config/alerts.example.yml`); with none configured
the process still records state and history. Run it after each collect and once a day
with `--summary`; `--dry-run` prints the evaluation without side effects.

## Portable partner collector

`zecori-collect` runs the same extractor, ledger report and quota collectors on a partner's
machine without the proxy or the secret manager: `zecori-auth-shim` exposes the credentials
Claude Code and Codex CLI already keep locally, `ai-usage-collect-direct` reads the local session
logs (`AI_USAGE_LEDGER_DIR`, `AI_USAGE_EXTRACTOR`, `AI_USAGE_HOSTS` point it at the private state
directory), and the snapshot is `PUT` to the hosted instance. Details: `docs/partner-collector.md`.

## Projects (attribution)

`ai-usage-report` groups every period by `project` as well: rules in `AI_USAGE_PROJECTS`
(default `~/.config/ai-usage/projects.json`, example `config/projects.example.json`) map a
row's `client`, `client_prefix`, `host` (native rows only: the part of the client before `:`),
`account`, `provider` or `via` to a project name; the first rule whose every condition matches
wins, and rows no rule claims are reported as `unassigned`, never guessed. Each period carries
`attribution: {rules, assigned_requests, unassigned_requests}`. `ai-usage-report --by project`
prints the same grouping in text mode; the dashboard exports it as CSV (`/api/usage/export`).
