# Account-specific website management

Browser bindings open a provider website in a dedicated persistent profile. They
do not refresh CLIProxyAPI OAuth, change routing enrollment or maintain a second
budget. Website identity and current proxy policy/health are shown separately.

Configure accounts with their exact expected email, then add one binding per
account. `subscription_id` is optional for an account without a subscription row.
The configured proxy account ID is the existing logical routing ID, never a native
credential filename or token. Omit it when that relationship is not established.

```toml
[[account_browsers]]
subscription_id = "subscription-example"
account_key = "example-account"
profile_id = "ai-bills-example-account"
cdp_http = "http://browser-host.example:18811"
remote_url = "https://browser.example/vnc.html?autoconnect=true&resize=scale"
login_url = "https://claude.ai/login"
manage_url = "https://claude.ai/settings/billing"
proxy_account_id = "existing-routing-account"
```

The profile ID and CDP endpoint must be dedicated to exactly one binding. Expected
email and provider come from `accounts[account_key]`, not request input. Missing
email, duplicate bindings and unsupported navigation hosts disable the action.
Provider navigation is restricted to configured HTTPS URLs on known provider hosts;
the browser accepts only an account/subscription selector and `manage`/`login`.
CDP transport rejects redirects and browser WebSocket endpoints on another origin.
CDP and remote UI endpoints are trusted operator configuration, not client URLs.

`GET /api/account-browser?subscriptionId=...` (or `?accountKey=...`) observes existing
provider tabs without creating, navigating, focusing or closing a tab. `POST` with
the same selector and `action` enforces the shared same-origin policy. Every Manage
action re-verifies the website identity; a previous `ready` response cannot grant
access. Freshness expires after 30 seconds. POST returns a typed state with HTTP 409
when Manage cannot establish the intended identity. Login opens a dedicated recovery
tab and returns its configured noVNC URL, without signing out or switching accounts.
The frontend opens that URL after the explicit click; a noVNC URL alone does not
navigate the provider website.

Claude identity reads only the email field from `/api/account`; OpenAI reads only
`user.email` from `/api/auth/session` inside the intended website origin. API shape
changes, blocked responses or missing fields remain unknown; anonymous profiles
require login. No cookie values, OAuth tokens or full provider responses leave the
browser through this API. Cursor selects only `email` from its existing `/api/auth/me`
endpoint. Kimi identity remains unverified until a supported adapter exists; its
dedicated login UI is available without fabricating readiness.
Initial real-account identity acceptance requires the user's website login/2FA in
each dedicated profile. OAuth credentials do not supply website authentication.

Manage creates or focuses its own configured billing tab. Other tabs are preserved.
Login redirects, including third-party SSO, retain and focus the same owned login
tab without navigation. Billing tabs are reused only at the configured billing URL;
if the user turns one into a chat, that chat is preserved and a new billing tab opens. A mismatched email
prevents billing navigation and exposes login recovery. Browser sessions are retained
when the app disconnects. Profile provisioning, backup and HTTPS/noVNC ingress remain
operator-owned and are not started or modified by a dashboard GET.

When `AI_BILLS_ROUTING_URL` and `AI_BILLS_ROUTING_TOKEN` are configured, the service
reads `/control/state` and joins the exact logical account ID. `nativeBound` means
the routing runtime has a configured native binding; it does not establish that
the provider credential is valid. Active policy version, enrollment and quota state
are separate from verified website identity. The gateway's local reservation ledger
remains the only authority for the paid budget. Website actions never rebind native
IDs, clear reservations or infer proxy identity from a matching email.
