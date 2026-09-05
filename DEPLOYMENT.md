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
