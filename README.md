# ai-bills

AI usage and billing dashboard with an existing append-only usage ledger, direct
Claude/Codex collection, proxy usage ingestion, provider balances, and account quota views.

Canonical repository: [BeFeast/ai-bills](https://git.oklabs.uk/BeFeast/ai-bills).
Management Home: `Dev/Areas/ai-bills`.

This is a sanitized source import of the existing application. The original private
repository and its complete history remain preserved privately. Archived browser-extension
sources are retained there and are not part of the active Next.js application. This public
repository contains no production account config, ledger, payment records or credentials.

## Development

Use bun for JavaScript/TypeScript commands and uv for Python operations.

```sh
bun run typecheck
bun run test
bun run build
```

Commands require dependencies installed by an explicitly approved development setup.
The existing Dockerfile retains its Node runtime and npm/package-lock build contract;
a bun lockfile/container migration is a separate change. No dependency versions are
changed by this source import.

Copy `config/default.toml` to a private operator-owned file, configure accounts and
paths there, then set `AI_BILLS_CONFIG` before starting the app. The example has no
accounts or credentials. Infisical credentials come from the environment; direct
provider secrets may use environment references. See [deployment](DEPLOYMENT.md)
and [collector configuration](collector/README.md).

## Scope and accounting

The current application distinguishes several usage shapes but does not yet provide
a verified complete financial ledger. Token-price estimates, quota, prepaid balances,
provider-reported accrued costs and actual payments must not be treated as interchangeable.
The current direct collector covers Claude and Codex records; other clients and providers
require explicit coverage work. Snapshot freshness, financial classification and expanded
provider APIs are separate implementation tasks, not claims completed by onboarding.

## Publication and deployment

Source publication does not activate collectors, replace a production checkout, run
scheduled jobs, modify accounts, or deploy the application. Preserve the current runtime
until a separately approved deployment and recovery package passes acceptance.
