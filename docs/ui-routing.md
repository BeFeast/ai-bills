# Accounting and routing dashboard

The month overview separates recorded payments, provider accrued consumption and
hypothetical API-equivalent estimates. Payments and consumption are never added
into a single expense. Subscription schedules are forecasts; prepaid balances are
assets. Missing observations and unknown prices are displayed as unavailable.

Choose a month to inspect its records. Add a manual record against a registered
account, with an effective date, currency and optional invoice reference. Negative
payments represent refunds. Retries preserve a record identity so an ambiguous
network response cannot duplicate the same submission. Editing the form starts a
new record. Non-USD records remain in their original currency unless the accounting
source supplies verified conversion evidence.

Source receipts explain missing, stale and unsupported coverage. Account discovery
is separate from quota availability and routing enrollment. Quota cards require a
recent successful provider observation (ten-minute UI freshness window); failures,
missing windows or stale observations show unknown availability. A newly generated
dashboard response cannot refresh an old embedded observation.

## Routing policy

Routing controls connect through the Next.js server using `AI_BILLS_ROUTING_URL`
and `AI_BILLS_ROUTING_TOKEN`. Set `AI_BILLS_PUBLIC_ORIGIN` to the public HTTPS
origin when the app sits behind a reverse proxy. The token stays on the server. The proxy only exposes
the metadata control protocol, not arbitrary upstream endpoints.

- **Models:** edit names and distinguish approved, hidden for new sessions, and
  denied for subsequent requests (including existing sessions).
- **Roles:** select and order candidates. The request service owns eligibility and
  included-quota preference; the UI is not an admission authority.
- **Clients:** choose each authenticated client's concrete models and roles.
- **Accounts:** discoveries enter the draft disabled. Enrollment requires an
  existing private upstream binding, and explicit validation and application.
- **Weekly suggestions:** accept into a draft or reject. Acceptance alone does not
  activate a suggestion. Existing draft edits must be resolved before acceptance.

Review the change list, validate, then explicitly apply. Application uses the
expected active version; concurrent edits are rejected. The UI rereads the active
service version before reporting confirmation. Discard reloads the active policy.

Requests and budget update every three seconds using lightweight control reads.
Account metadata and monthly records refresh once per minute, separately from
provider quota refreshes. The budget view distinguishes settled admission cost,
reserved/unresolved liability and remaining allowance. Per-request evidence shows
the actual selected model/account and fallback reason. A transport failure keeps
previous observations visible with a failure notice; it does not imply a healthy
or newly applied policy.

The dashboard warns when the request service cannot verify native attempt
admission. It does not claim a strict allowance for unmanaged traffic. An offline
dashboard does not own or reset the request service's durable policy and budget.
