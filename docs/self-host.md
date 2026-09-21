# Self-host in 30 minutes

One machine, no login, no proxy: the dashboard runs in Docker, the collector runs from cron on
the same machine (where Claude Code and/or Codex CLI are signed in) and pushes a snapshot every
five minutes. Nothing leaves the machine except the calls the collector makes to the providers'
own usage endpoints.

What you get: quota windows and reset times for the signed-in Claude/Codex accounts, the native
usage ledger (tokens, requests, models, outcomes) and, if you configure them, subscriptions,
OpenRouter balance and alerts. What stays unknown without further sources: payments, invoices,
proxy credentials, providers without a usage API. The dashboard says so instead of showing zero.

## Requirements

- Docker with Compose, git.
- On the collector machine: `python3` (3.11+), `jq`, `curl`; PyYAML only if you supply a pricing file.
- Claude Code signed in with a claude.ai subscription and/or Codex CLI signed in with ChatGPT.
  API-key sign-ins have no quota window and are reported as skipped.

## 1. Dashboard

```bash
git clone https://git.oklabs.uk/BeFeast/ai-bills.git zecori && cd zecori/deploy/selfhost
./new-token.sh                     # prints ZECORI_INGEST_TOKEN=… plus the three lines .env needs
cp .env.example .env               # paste AI_BILLS_INGEST_TOKEN_SHA256 and the two POSTGRES_* lines into .env
docker compose up -d --build       # dashboard + its Postgres; migrations run at boot
curl -fsS http://127.0.0.1:13180/api/health
```

The image is built from the checkout (the BeFeast registry is private). The dashboard listens on
`127.0.0.1:13180`; there is no sign-in in this mode, so expose it only on a private network
(`AI_BILLS_BIND` in `.env`) or put it behind your own auth. For a login-protected instance on a
public address use hosted mode (`DEPLOYMENT.md`, Clerk).

## 2. Collector

```bash
mkdir -p ~/.config/zecori && chmod 700 ~/.config/zecori
printf '%s\n' 'zk_…' > ~/.config/zecori/token && chmod 600 ~/.config/zecori/token   # the token from step 1
export ZECORI_SNAPSHOT_URL=http://127.0.0.1:13180/api/snapshot ZECORI_INGEST_TOKEN_FILE=~/.config/zecori/token
ZECORI_DRY_RUN=1 ./collector/zecori-collect    # shows accounts found / skipped, delivers nothing
./collector/zecori-collect                     # {"delivered":"…","bytes":…}
```

Cron every five minutes (paths absolute; cron has no PATH):

```
*/5 * * * * ZECORI_SNAPSHOT_URL=http://127.0.0.1:13180/api/snapshot ZECORI_INGEST_TOKEN_FILE=/home/you/.config/zecori/token /home/you/zecori/collector/zecori-collect >> /home/you/.local/state/zecori/collect.log 2>&1
```

Plain `http` is accepted only for `127.0.0.1`/`localhost`; a collector on another machine must
use `https`. Options (timezone, pricing, subscriptions file, OpenRouter key, alerts) are listed in
`docs/partner-collector.md`; the dashboard lists the accounts from each delivered snapshot, so
`config.toml` needs no edits when an account is added.

## 3. Check

- `http://127.0.0.1:13180/api/health` reports `collection: fresh` after the first delivery.
- The Accounts view shows one card per signed-in account; the Overview hero lists the accounts used in the last 24 hours.
- `~/.local/state/zecori/last-delivery.json` holds the dashboard's answer to the last push.

## Updating

```bash
cd zecori && git pull && cd deploy/selfhost && docker compose up -d --build
```

The collector's state directory (`~/.local/state/zecori`) holds the ledger; `deploy/selfhost/data/postgres`
holds the dashboard's database (snapshots, quota history, accounting, edits). Both survive updates;
neither is read by git. Back the database up with `docker compose exec db pg_dump -U zecori zecori`.
