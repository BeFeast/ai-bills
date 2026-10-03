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
manage_url = "https://claude.ai/new#settings/usage"
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

### Distinguish an unavailable profile from a login page

A configured remote URL must not be opened when profile acquisition fails. The
API can return that URL together with `unavailable` (HTTP503, or HTTP409 for a
manage action); navigating anyway exposes the reverse proxy's generic unavailable
page for an idle profile. The client must retain the actionable dashboard error
and close its newly reserved tab. A running browser with `login_required`,
`identity_unknown` or `mismatch` remains a valid manual-access destination.

HTTP200 plus an HTML content type is insufficient noVNC acceptance. Verify a real
noVNC document, successful WebSocket/RFB connection and a rendered canvas. In the
September10 follow-up, the active Kimi manual profile passed public WebSocket and
1920×1080 canvas verification with `view_only=true` and shared VNC; the idle Cursor
URL returned HTTP503 with the generic unavailable placeholder. Without the user's
specific URL, these observations do not identify which page their screenshot showed.

### Identity without an open provider tab

A shared resident profile often has no tab of a given provider open. That is not
missing auth: the identity probe opens a background tab on the provider's origin,
asks the provider's own account endpoint, and closes the tab again. Only a 401/403
from that endpoint (or a session without a user) is `login_required`. Manage and
login actions focus a tab that already shows the configured page instead of
opening another one after a restart.

### Claude quota from the signed-in website

With `claude_web_quota = true` on a Claude `[[accounts]]` entry (it also needs
`claude_org_id`, `cdp_http` and `cdp_profile_id` of the account's resident profile),
the dashboard reads `claude.ai`'s own usage answer for the organisation in a
background tab that is closed afterwards. It is the fallback while the proxy's
observation fails (at most every 5 minutes) and the second source of the
consistency checker (every 30 minutes). The card names the source; a dead proxy
credential stays visible beside website numbers. Without the flag nothing changes.

### Reconnect proxy

`[proxy_management]` (`base_url`, `management_key`, optional `client_key`, both
secret references) enables the "Reconnect proxy" button on a card whose proxy
credential is expired. A signed-in admin confirms it; the proxy's Claude OAuth flow
then runs in a foreground tab of the account's profile. Authorize is clicked only on
claude.ai's consent page while claude.ai reports the expected e-mail; a different
account stops the flow without a callback, and a profile that is not signed in gets
"Open account browser" instead. The tab is closed in every outcome. Where the proxy
authenticates management writes as a client request, `client_key` is required.

### Quota guards

`GET /api/guards` reports five up/down guards: no usable Claude quota from any
source for more than 5 hours, proxy and website disagreeing on two consecutive
checks (state, or more than 10 percentage points), the collector's hourly model
probe, configured quota links (`quota_snapshot_key`, a collector-shaped
`proxy_account_id`, Claude/Codex binding members) that name nothing in the snapshot,
and Codex credits spent while another Codex account has room.
A collector outage is reported as unchecked, not as drift. `collector/ai-bills-guards`
relays them to push monitors.

### Codex paying from credits

A Codex account whose rate limit is used up keeps answering when it has credits:
each request is charged to the credit balance, and no 429 reaches the proxy, so
it neither cools the account down nor fails over. The account card, the Overview
hero and the widget then say "paying from credits" instead of a bare 0 %, with
the credits spent per hour (measured from the balances stored with the last hour
of quota observations, starting after the last top-up) and the manual resets the
provider would apply now. When the direct quota request fails and the proxy's
headers stand in, the payload has no credits block; the newest stored observation
of the last hour then decides whether the account can still pay (credits on hand,
no spend cap or overage limit) and supplies the balance. The widget also adds "(paying from credits)" to the
used-up window's label, so clients that predate the `creditDrain` field show it
under the meter. The `credits` guard goes down while such an account is seen
spending and another Codex login (a different workspace or seat) still has room;
spending when every account is out is the expected fallback and stays up, and an
unmeasured rate is reported as such, never as nothing spent.

### Credential renames

The proxy renames an OAuth credential's auth file on re-login, which changes every
file-name id. The collector therefore also publishes each Claude quota under a
rename-proof id, `sha256("oauth-account:claude:" + lower(e-mail))[:24]`, and the
inventory carries it as an alias of the file-name row. Configure
`quota_snapshot_key` and binding members with that id to survive renames; until then
a stale key falls back to the e-mail key when no other configured account of the
provider shares the address. When several credentials hold one e-mail, neither key
is published and only the file id identifies a credential.
