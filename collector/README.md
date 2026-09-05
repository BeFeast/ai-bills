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
