# Agent instructions — ai-bills

Management Home: `Dev/Areas/ai-bills`.
Canonical repository: [BeFeast/ai-bills](https://git.oklabs.uk/BeFeast/ai-bills).

Use bun for Node.js operations and uv for Python. Keep the existing Docker Node/npm
build contract until a separately scoped and tested migration. Do not update packages
as part of source onboarding. Run the existing typecheck and tests when dependencies
are already available; never execute collectors against production as a test.

Public source must contain no credentials, account IDs, private host paths, internal
endpoints, ledger/snapshot/payment records or operator config. Use explicit configuration.
The private source provenance and operational identity are maintained in Management Home.

Issue-first implementation; assign the work tier before changes. Onboarding is a P3
bootstrap exception. Keep incidental accounting and freshness defects in separate issues.
Do not dispatch a paused project or deploy from a source commit. Live install/update,
restart, auth/permissions/configuration changes and paid inference require an approved
concrete operational package. Preserve sessions, append-only usage records and rollback.

Model catalog, callable inference and actual client availability are separate evidence.
Do not silently substitute models or transition a consumer to a paid API.
