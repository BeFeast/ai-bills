# Zecori — your AI treasurer

<img src="public/brand/zecori-avatar-256.png" width="96" height="96" align="right" alt="Zecori, a brass android treasurer with cyan eyes">

**Zecori** (technical slug `ai-bills`, by BeFeast) is an attentive, calm and slightly ironic android
treasurer for your AI resources. It keeps the books on subscriptions, real payments, prepaid credits,
remaining quota, reset windows and upcoming renewals, and answers three questions: what can I use
right now, how much is left and when does it reset, and what is paid, what does my AI cost and which
charges are ahead. Payments, accrued costs, prepaid balances and API-equivalent estimates stay separate
figures; quotas that are not comparable are never added up; a reset window is not a renewal; unknown,
freshness and coverage stay visible. Zecori does not move money, route requests or run an LLM.

Brand assets live in `public/brand/` (avatar, portrait, outlined wordmark) and `src/app/` (favicon,
apple icon); the working interface keeps the BeFeast design system.

AI subscription and usage dashboard. The overview shows subscription count, recurring
prices, renewal dates, API-equivalent usage and the largest consumers. Subscription
rows link to sign-in and billing settings; recorded prices and dates can be maintained
in the dashboard. Models, routing and detailed accounting have their own sections.

The existing append-only usage ledger, direct Claude/Codex collection, proxy usage
ingestion, provider balances and account quota views remain available. See the
[product overview data contract](docs/product-overview.md) for evidence and coverage rules.

Canonical repository: [BeFeast/ai-bills](https://git.oklabs.uk/BeFeast/ai-bills).
Management Home: `Dev/Areas/ai-bills`. License: [MIT](LICENSE). Every pull request runs
typecheck, unit tests, the production build and the collector tests through `.forgejo/workflows/ci.yml`;
every push to `main` builds and rolls the image through `.forgejo/workflows/deploy.yml` (see [DEPLOYMENT.md](DEPLOYMENT.md)).

This is a sanitized source import of the existing application. The original private
repository and its complete history remain preserved privately. Archived browser-extension
sources are retained there and are not part of the active Next.js application. This public
repository contains no production account config, ledger, payment records or credentials.

## Install

- Self-host on one machine, no login: [docs/self-host.md](docs/self-host.md) (`deploy/selfhost/`, collector from cron).
- Feeding a hosted instance from your machine: [docs/partner-collector.md](docs/partner-collector.md).
- Operating a hosted instance with sign-in: [DEPLOYMENT.md](DEPLOYMENT.md).

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
