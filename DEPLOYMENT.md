# Deployment contract

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

Rollback source independently from append-only records. Do not restore old OAuth tokens
blindly or run a second collector against the same consumptive queue.

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
renews it on further opens or Keep open, and releases it on Close browser.
**Close browser affects all providers sharing that profile.** Read-only account
checks reuse an active manual lease. Lease expiry remains controlled by the
lifecycle owner. A bookmarked noVNC URL alone does not acquire a lease or start an
idle browser. Use the dashboard's **Bookmark browser access** link instead:
`/account-browser?accountKey=claude-example` (or a configured `subscriptionId`)
resolves the intended account and exposes the existing Open browser, Keep open
and Close browser controls. Visiting this stable entrance is passive; only an
explicit action acquires a lease. The old raw noVNC URLs remain unchanged.

Configuration changes do not move cookies, start browsers, or register profiles
with the lifecycle owner. Provisioning/migration remains a separately approved
operation; preserve existing profiles and their sign-in state. Configure quota
collector `cdp_profile_id`/`cdp_http` consistently in the private account rows when
those collectors use the same browser. This change does not alter collector
scheduling or the lifecycle owner's concurrency policy.
