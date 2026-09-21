# Deployment contract

## Continuous deployment (since 2026-09-19)

Every push to `main` runs `.forgejo/workflows/deploy.yml` on the org's `heavy` runner:
build the image from the repository root, push `git.oklabs.uk/befeast/ai-bills:<sha12>`
and `:latest` to the OK Forge registry, pull it on the app host through Dockhand,
`down` + `start` the stack, and verify `/api/health` plus the served page. The stack's
compose file is owned by `BeFeast/infra-stacks` (`devbox/ai-bills/compose.yaml`); the
job refuses to roll onto a copy that drifted from it. Rollback is a tag swap in that
compose file (`:latest` → `:<sha12>` of the previous good build) followed by Dockhand
`down` + `start`; previous tags stay in the registry. Config, `.env`, data and Codex
profiles never travel through this pipeline, and the collector on its own host is
deployed separately.

The existing deployment lifecycle remains owned by the operator's stack manager.
Do not infer deployment authority from a source commit or repository publication.
The example Compose file is an operator template, not the installed configuration.

Configure private paths for the TOML config, data directory and Codex profiles using
`AI_BILLS_CONFIG_FILE`, `AI_BILLS_DATA_DIR`, and `AI_BILLS_CODEX_PROFILES_DIR`.
The example binds only localhost; endpoint exposure requires an explicit operator decision.
Provide credentials through the private `.env` file or the existing secret manager.
Never commit account exports, OAuth profiles, snapshots, payment records, or ledger data.

The Docker build retains Node 22, package-lock/npm installation, the complete `@openai`
scope and system CA certificates. Do not silently replace this contract during onboarding.

Before any live rollout: record the currently running image/source, back up protected
config and persistent data, preserve ledger cursors and dedup state, and prepare exact
restore commands. Only one proxy usage queue consumer and one OAuth refresh owner may
run. A successful health response does not prove snapshot/card freshness or complete usage.
`/api/health` reports each collector-observed quota source at the observation time recorded in
the snapshot itself, so an instance nobody is looking at still reports honestly; a source ageing
past ten minutes is a collector or delivery problem, not an idle dashboard. The quota cards read
the snapshot again whenever the file on disk changes, within the configured refresh interval.

Rollback source independently from append-only records. Do not restore old OAuth tokens
blindly or run a second collector against the same consumptive queue.

## Hosted mode (Clerk sign-in)

Set `AI_BILLS_AUTH=clerk` and the instance requires a Clerk session for every page and
API except `/api/health`, `/api/snapshot`, brand assets and the auth pages. Who may use the
instance is then decided in one of two ways. **With a database** (`DATABASE_URL`, tenancy
phase 2) the `memberships` table decides: the middleware proves the session and forwards the
identity, every API route resolves the tenant by membership before handling, and a signed-in
account without a membership gets 403 by name. An address named in `AI_BILLS_ALLOWED_EMAILS`
(admin if also in `AI_BILLS_ADMIN_EMAILS`) is adopted into the default tenant (`AI_BILLS_TENANT`)
on its first sign-in, so the lists migrate themselves; an existing membership always wins over
the lists, and an empty allow list stays open. **Without a database** the lists decide directly,
as before: a second list independent of Clerk's own allowlist, so removing an address revokes
access on the next request; an empty list keeps the instance open and is logged.
Denied accounts see a page naming the account with a sign-out button. Runtime configuration:
`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` (read per request; the build-time
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is only a fallback), `AI_BILLS_PUBLIC_ORIGIN`. A partner
instance on another host of the same Clerk instance runs as a satellite: set
`AI_BILLS_CLERK_PRIMARY_ORIGIN` to the primary's origin and people sign in there; the primary
lists satellites in `AI_BILLS_CLERK_ALLOWED_REDIRECT_ORIGINS` (comma-separated, wildcards
allowed). The Clerk session token must carry an `email` claim. Self-hosted instances leave
`AI_BILLS_AUTH` unset and never load Clerk.

A hosted instance receives its data through `PUT /api/snapshot` with
`Authorization: Bearer <token>`; the instance stores only digests. With a database the token
names the tenant through `ingest_tokens` (digests from `AI_BILLS_INGEST_TOKEN_SHA256` are
adopted for the default tenant at boot, so the collector keeps working; a revoked row stops
working at once); without one `AI_BILLS_INGEST_TOKEN_SHA256` (hex digests, comma-separated)
decides. The collector sends with `AI_BILLS_SNAPSHOT_URL` and reads
the token from the secret manager (`AI_BILLS_SNAPSHOT_TOKEN_SECRET`, path
`AI_BILLS_SNAPSHOT_TOKEN_PATH`, default `/ai-bills`; workspace `AI_BILLS_SNAPSHOT_TOKEN_WORKSPACE`,
default the collector's own project).

## Database (tenancy phase 1)

The instance can run with a Postgres database beside the snapshot file
(spec: `Dev/Areas/ai-bills/specs/2026-09-21-multi-tenancy.md`). Set `DATABASE_URL`
(application role `zecori_app`, no BYPASSRLS) and optionally `DATABASE_ADMIN_URL` (table
owner) and the instance applies the SQL migrations in `drizzle/` at boot, creates the default
tenant (`AI_BILLS_TENANT`, default `default`) and, on every `PUT /api/snapshot`, stores the
snapshot body and its quota observations for that tenant in addition to writing the file. The
file remains what the dashboard reads in this phase; the ingest response reports
`stored.database` as `stored`, `disabled` (no `DATABASE_URL`) or `failed` (logged, ingest still
succeeds). Every tenant table is under row-level security keyed by `app.tenant_id`, which the
application sets per transaction; a connection without a tenant context sees no tenant data.
Without `DATABASE_URL` nothing changes. Retention: the last 48 snapshot bodies per tenant;
observations are kept.

**Reading from the database (phase 3)** is switched with `AI_BILLS_STORAGE=db`. Every reader —
usage cards, accounts, overview, accounting, alerts, billing history, the usage export — then
reads the requesting tenant's rows (`snapshots`, `journal_records`, `subscription_overrides`,
`history_points`) instead of the files; the collector's file is still written, so setting the
variable back to `file` (or unsetting it) restores the previous behaviour without a deploy. At
the first boot in `db` mode the operator-entered files are imported once for the default tenant
while their tables are empty: the accounting journal (`accounting.journal_path`) and
`subscription-overrides.json`; balance history and alert state start fresh. `/api/health`
reports the default tenant's snapshot in this mode.

The platform operator — addresses in `AI_BILLS_OPERATOR_EMAILS`, or the single admin of a
non-Clerk instance — gets `/operator` and `GET /api/operator`: every tenant with ingest
freshness, member and token counts and the latest quota observation per account, read under a
read-only operator context (`app.operator`) that the row-level-security policies honour for
`snapshots` and `quota_observations` only.

## Partner instances fed by the portable collector

An instance whose config declares no `[[accounts]]` lists its Claude/Codex accounts from the
`collector.accounts` rows of the snapshot it receives, re-reading them whenever the snapshot
file changes. Partners run `collector/zecori-collect` on their own machine; see
`docs/partner-collector.md` for what it reads, what it sends and how to configure it.

## Shared account browsers

By default each `account_browsers` entry owns an isolated `ai-bills-*` profile.
To reuse one browser across providers authenticated with the same sign-in identity,
set `shared_identity_email` on every binding that shares it. Its normalized value
must match each referenced account's `email`; this declares the intended identity,
not evidence of a signed-in Google or provider session. Provider website identity
is still checked separately before billing navigation. Unsupported identity checks
(such as Kimi) remain unknown.

For example, with `claude-example` and `chat-example` account rows both declaring
`email = "person@example.test"`:

```toml
[[account_browsers]]
account_key = "claude-example"
profile_id = "identity-example"
shared_identity_email = "person@example.test"
cdp_http = "http://127.0.0.1:18811"
remote_url = "https://browser.example.test/vnc.html?autoconnect=true"
login_url = "https://claude.ai/login"
manage_url = "https://claude.ai/settings/billing"

[[account_browsers]]
account_key = "chat-example"
profile_id = "identity-example"
shared_identity_email = "person@example.test"
cdp_http = "http://127.0.0.1:18811"
remote_url = "https://browser.example.test/vnc.html?autoconnect=true"
login_url = "https://chatgpt.com/auth/login"
manage_url = "https://chatgpt.com/"
```

Each shared resource must use the same profile ID, CDP origin, full remote URL
(including query parameters), and normalized identity. A profile supports one
binding per provider; use separate profiles for different identities. Profile IDs
with explicit sharing use the lifecycle owner's identifier syntax (letters, digits,
underscores and hyphens, up to 81 characters, starting with a letter or digit).
Optional `subscription_id` and `proxy_account_id` keep their existing meanings.
OpenCode is not an account provider in this configuration; sharing does not add
quota adapters or change native OAuth ownership.

Operations serialize per profile. Each provider/account owns its own login and
billing tabs, including tabs temporarily redirected to an SSO page. The browser
lifecycle integration still acquires a bounded manual lease on Open browser,
renews it on further opens or Extend session, and releases it on Close session.
**Close session releases the shared access lease for all providers using that profile.**
Whether the browser stops or remains available is controlled by the lifecycle
owner; releasing access does not assert that the browser process stopped. Read-only account
checks reuse an active manual lease. Lease expiry remains controlled by the
lifecycle owner. A bookmarked noVNC URL alone does not acquire a lease or start an
idle browser. Use the dashboard's **Bookmark browser access** link instead:
`/account-browser?accountKey=claude-example` (or a configured `subscriptionId`)
resolves the intended account and exposes the existing Open browser, Extend session
and Close session controls. Visiting this stable entrance is passive; only an
explicit action acquires a lease. The old raw noVNC URLs remain unchanged.

Configuration changes do not move cookies, start browsers, or register profiles
with the lifecycle owner. Provisioning/migration remains a separately approved
operation; preserve existing profiles and their sign-in state. Configure quota
collector `cdp_profile_id`/`cdp_http` consistently in the private account rows when
those collectors use the same browser. This change does not alter collector
scheduling or the lifecycle owner's concurrency policy.
