# Partner collector (`zecori-collect`)

The portable collector feeds a hosted Zecori instance from the machine where Claude Code and/or
Codex CLI are signed in. It needs no proxy, no secret manager and no SSH: nothing is installed
system-wide, and the only network destinations are the providers' own usage endpoints and the
instance's `PUT /api/snapshot`.

## What leaves the machine

| Data | Source on the machine | Sent as |
|---|---|---|
| Quota windows (percent used, reset time) | Claude Code / Codex CLI OAuth tokens, read by `zecori-auth-shim` and used once per run to call the provider | percentages and timestamps only; tokens stay in `$ZECORI_STATE/auths` (mode 0600) |
| Native usage (tokens, requests, model, outcome) | the CLIs' local session logs (`~/.claude/projects`, `$CODEX_HOME/sessions`) | rolled-up ledger (`usage_ledger`): per day, per model, per account; no prompts or file paths |
| Signed-in addresses | the same credential files | `collector.accounts` (`{type, email}`) — the instance lists its accounts from this |
| Optional: subscription list, OpenRouter balance, alert state | files/keys you configure | as-is |

Everything the dashboard can show but the collector cannot observe (payments, proxy
credentials, other providers) is delivered empty and rendered as unknown, never as zero.

## Requirements

`python3` (3.11+), `jq`, `curl`. Copy the `collector/` directory anywhere; run `zecori-collect`
from a cron or a timer every 5 minutes.

```bash
export ZECORI_SNAPSHOT_URL=https://<instance>/api/snapshot
export ZECORI_INGEST_TOKEN_FILE=~/.config/zecori/token   # or ZECORI_INGEST_TOKEN
./collector/zecori-collect
# {"delivered":"2026-09-19T09:31:34Z","bytes":15330}
```

The token is issued by the instance operator; it only authorises `PUT /api/snapshot`.

| Variable | Default | Meaning |
|---|---|---|
| `ZECORI_SNAPSHOT_URL` | required | `https://<instance>/api/snapshot` |
| `ZECORI_INGEST_TOKEN` / `ZECORI_INGEST_TOKEN_FILE` | required | bearer token, or a file holding it |
| `ZECORI_STATE` | `~/.local/state/zecori` | private state: auth copies, usage ledger, last snapshot |
| `AI_USAGE_TIMEZONE` | `UTC` | day boundary of the ledger (IANA name) |
| `AI_USAGE_PRICING` | bundled `pricing.default.yml` (no models) | list prices; unknown models are reported as unpriced |
| `ZECORI_SUBSCRIPTIONS_FILE` | none | JSON array of subscriptions to show on the Overview |
| `OPENROUTER_API_KEY` | none | adds the OpenRouter balance |
| `ZECORI_ALERTS_CONFIG` | none | enables `ai-bills-alerts` (ntfy publish) on the produced snapshot |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | the CLIs' defaults | where the credentials and session logs are |
| `ZECORI_DRY_RUN=1` | off | build the snapshot, print a summary, deliver nothing |

## What the run reports

The JSON summary names every account it found and, for each provider it could not read, the
reason (`skipped`), e.g. Claude Code signed in through an API key or a proxy has no claude.ai
OAuth token and therefore no quota window. The instance shows an account as soon as it appears
in a delivered snapshot; no restart or config edit is needed.

## Checks

- `ZECORI_DRY_RUN=1 ./collector/zecori-collect` prints the accounts, the quota keys and the ledger period without contacting the instance.
- `curl -fsS https://<instance>/api/health` reports `collection` freshness after a delivery.
- `$ZECORI_STATE/last-delivery.json` holds the instance's answer to the last `PUT`.
