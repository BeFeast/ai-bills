#!/usr/bin/env bash
# ai-bill-collect — gather AI billing/status data on the collector host, ship snapshot.json to the dashboard host.
# Sources: CLIProxy mgmt API, maestro.db (tokens×pricing), RunPod/Vast APIs (keys via Infisical),
#          vault provider frontmatter + payments.yml.
# Ships snapshot to ai-bills (Next.js); history.jsonl owned by the app.
set -euo pipefail

# Required deployment values stay in the operator environment, outside git.
: "${AI_BILLS_PROVIDERS_DIR:?Set AI_BILLS_PROVIDERS_DIR}"
: "${AI_BILLS_PAYMENTS_FILE:?Set AI_BILLS_PAYMENTS_FILE}"
: "${AI_BILLS_MAESTRO_DB:?Set AI_BILLS_MAESTRO_DB}"
if [ -z "${AI_BILLS_SNAPSHOT_SSH_HOST:-}" ]; then
  : "${AI_BILLS_SNAPSHOT_TARGET:?Set AI_BILLS_SNAPSHOT_TARGET or AI_BILLS_SNAPSHOT_SSH_HOST}"
fi
: "${INFISICAL_PROJECT_ID:?Set INFISICAL_PROJECT_ID}"
export AI_BILLS_MAESTRO_DB AI_BILLS_PAYMENTS_FILE
CLIPROXY_KEYS_FILE="${AI_USAGE_KEYS_FILE:-/opt/cliproxyapi/.keys}"
CLIPROXY_AUTH_DIR="${AI_BILLS_CLIPROXY_AUTH_DIR:-/opt/cliproxyapi/auths}"
CLIPROXY_MGMT_URL="${AI_BILLS_CLIPROXY_MGMT_URL:-http://127.0.0.1:23020/v0/management}"
export AI_BILLS_CLIPROXY_AUTH_DIR="$CLIPROXY_AUTH_DIR"
COLLECTOR_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OUT=$(mktemp /tmp/ai-bill-snapshot.XXXXXX.json)
trap 'rm -f "$OUT"' EXIT

source "${AI_BILLS_INFISICAL_ENV:-$HOME/.config/infisical/machine.env}"
TOKEN=$(infisical login --method=universal-auth \
  --client-id="$INFISICAL_CLIENT_ID" --client-secret="$INFISICAL_CLIENT_SECRET" \
  --domain="$INFISICAL_API_URL" --plain 2>/dev/null | tail -1)
EXT_PROJECT="$INFISICAL_PROJECT_ID"
secret() {
  curl -sf -G "${INFISICAL_API_URL}/v3/secrets/raw/$2" -H "Authorization: Bearer $TOKEN" \
    --data-urlencode "workspaceId=$EXT_PROJECT" --data-urlencode "environment=prod" \
    --data-urlencode "secretPath=$1" | jq -r '.secret.secretValue'
}

MGMT=$(sed -n 's/^MGMT=//p' "$CLIPROXY_KEYS_FILE")

# --- balances ---
RUNPOD=$(curl -sf -m 15 https://api.runpod.io/graphql \
  -H "Authorization: Bearer $(secret /ai/gpu-providers RUNPOD_API_KEY)" \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { myself { clientBalance currentSpendPerHr } }"}' \
  | jq '.data.myself // {}') || RUNPOD='{}'
VAST=$(curl -sf -m 15 "https://console.vast.ai/api/v0/users/current/" \
  -H "Authorization: Bearer $(secret /ai/gpu-providers VAST_API_KEY)" \
  | jq '{credit}') || VAST='{}'

# --- proxy: auth-file (subscription) health + upstream request counters ---
AUTHS=$(curl -sf -m 10 "$CLIPROXY_MGMT_URL/auth-files" -H "Authorization: Bearer $MGMT" \
  | jq '[.files[] | {provider, email, status,
        today_success: ([.recent_requests[]?.success] | add // 0),
        today_failed:  ([.recent_requests[]?.failed]  | add // 0)}]') || AUTHS='[]'
USAGE=$(curl -sf -m 10 "$CLIPROXY_MGMT_URL/api-key-usage" -H "Authorization: Bearer $MGMT" \
  | jq 'to_entries | map({upstream: .key,
        success: ([.value[]?.success] | add // 0),
        failed:  ([.value[]?.failed]  | add // 0),
        last_hour: ([.value[]?.recent_requests[-6:][]?.success] | add // 0)})') || USAGE='[]'

# --- Claude subscription usage via cliproxy OAuth tokens ---
# Replaces the browser/CDP path (legacy CDP path retired): same JSON shape the
# dashboard's ClaudeUsagePayload expects, fetched with the access_token cliproxy
# keeps refreshed in /opt/cliproxyapi/auths/. Tokens never leave the collector host.
CLAUDE_USAGE=$(uv run --project "$COLLECTOR_DIR" --frozen python "$COLLECTOR_DIR/ai-claude-quotas") || CLAUDE_USAGE='{}'
[ -n "$CLAUDE_USAGE" ] || CLAUDE_USAGE='{}'

# Read-only Codex quota collection; the proxy remains the OAuth refresh owner.
CODEX_USAGE=$(AI_BILLS_CLIPROXY_AUTH_DIR="$CLIPROXY_AUTH_DIR" uv run --project "$COLLECTOR_DIR" --frozen python "$COLLECTOR_DIR/ai-codex-quotas") || CODEX_USAGE='{}'
ACCOUNT_QUOTAS=$(jq -n --argjson claude "$CLAUDE_USAGE" --argjson codex "$CODEX_USAGE" '{claude_usage:$claude,codex_usage:$codex}' | uv run --project "$COLLECTOR_DIR" --frozen python "$COLLECTOR_DIR/ai-quota-projection") || ACCOUNT_QUOTAS='{}'

# --- maestro cost-obs: today tokens × per-backend pricing ---
COST=$(uv run --project "$COLLECTOR_DIR" --frozen python - <<'PYEOF'
import sqlite3, json, datetime, re, os
db = sqlite3.connect('file:' + os.environ['AI_BILLS_MAESTRO_DB'] + '?mode=ro', uri=True)
today = datetime.date.today().isoformat()
pricing = {}
for name, y in db.execute("SELECT name, definition_yaml FROM backends"):
    m_in = re.search(r'input_usd_per_mtok:\s*([\d.]+)', y)
    m_out = re.search(r'output_usd_per_mtok:\s*([\d.]+)', y)
    # ollama-provider backends ride the flat Ollama Cloud Pro sub — $0 marginal
    # regardless of the legacy pricing block in maestro.db (see llm-subscriptions-catalog)
    if re.search(r'provider:\s*ollama', y):
        pricing[name] = (0.0, 0.0)
    else:
        pricing[name] = (float(m_in.group(1)) if m_in else None,
                         float(m_out.group(1)) if m_out else None)
tok = {}
for b, sj in db.execute("SELECT backend, session_json FROM sessions WHERE updated_at >= ?", (today,)):
    try: t = json.loads(sj).get('tokens_used_total', 0) or 0
    except Exception: t = 0
    tok[b] = tok.get(b, 0) + t
out = []
for b, t in sorted(tok.items(), key=lambda x: -x[1]):
    pin, pout = pricing.get(b, (None, None))
    # blended 70/30 in/out estimate, same convention as llm-subscriptions-catalog
    est = t / 1e6 * (0.7 * pin + 0.3 * pout) if pin is not None and pout is not None else None
    out.append({'backend': b, 'tokens_today': t, 'est_usd_today': round(est, 2) if est is not None else None,
                'flat': pin == 0 and pout == 0})
print(json.dumps(out))
PYEOF
) || COST='[]'

# --- vault: provider cards frontmatter + payments ---
PROVIDERS_STATUS=fresh
PROVIDERS=$(uv run --project "$COLLECTOR_DIR" --frozen python "$COLLECTOR_DIR/ai-subscription-inventory" "$AI_BILLS_PROVIDERS_DIR") || { PROVIDERS='[]'; PROVIDERS_STATUS=error; }
SUBSCRIPTIONS='[]'
if [ -n "${AI_BILLS_SUBSCRIPTIONS_FILE:-}" ]; then
  SUBSCRIPTIONS=$(jq -ce 'if type == "array" then . else error("Expected subscriptions array") end' "$AI_BILLS_SUBSCRIPTIONS_FILE") || { SUBSCRIPTIONS='[]'; PROVIDERS_STATUS=error; }
fi
PAYMENTS_STATUS=fresh
PAYMENTS=$(uv run --project "$COLLECTOR_DIR" --frozen python -c "
import yaml, json, sys, os
d = yaml.safe_load(open(os.environ['AI_BILLS_PAYMENTS_FILE']))
print(json.dumps(d.get('payments', []), default=str))
" 2>/dev/null) || { PAYMENTS='[]'; PAYMENTS_STATUS=error; }

# --- token ledger rollup (see [[ai-usage-ledger]]) — real per-request accounting,
# --- unlike maestro_cost_today, which only ever saw the Maestro orchestrator.
LEDGER_STATUS=fresh
LEDGER=$(uv run --project "$COLLECTOR_DIR" --frozen python "${AI_USAGE_REPORT_BIN:-$HOME/.local/bin/ai-usage-report}" --rollup 2>/dev/null) || { LEDGER='{}'; LEDGER_STATUS=error; }
[ -n "$LEDGER" ] || LEDGER='{}'
REGISTRY=$(uv run --project "$COLLECTOR_DIR" --frozen python "$COLLECTOR_DIR/ai-account-inventory") || REGISTRY='{"accounts":[],"sources":[{"id":"inventory","status":"error"}]}'

jq -n \
  --arg providers_status "$PROVIDERS_STATUS" --arg payments_status "$PAYMENTS_STATUS" --arg ledger_status "$LEDGER_STATUS" \
  --argjson runpod "$RUNPOD" --argjson vast "$VAST" \
  --argjson auths "$AUTHS" --argjson usage "$USAGE" \
  --argjson cost "$COST" --argjson providers "$PROVIDERS" \
  --argjson payments "$PAYMENTS" \
  --argjson subscriptions "$SUBSCRIPTIONS" \
  --argjson ledger "$LEDGER" \
  --argjson registry "$REGISTRY" \
  --argjson claude_usage "$CLAUDE_USAGE" \
  --argjson codex_usage "$CODEX_USAGE" \
  --argjson account_quotas "$ACCOUNT_QUOTAS" \
  '{generated: (now | todate), source_receipts: [{id: "provider-subscriptions", status: $providers_status, observedAt: (now|todate)}, {id: "payments", status: $payments_status, observedAt: (now|todate)}, {id: "token-ledger", status: $ledger_status, observedAt: (now|todate)}], runpod: $runpod, vast: $vast,
    proxy_auths: $auths, proxy_usage: $usage,
    maestro_cost_today: $cost, providers: $providers, subscriptions: $subscriptions, payments: $payments,
    usage_ledger: $ledger, claude_usage: $claude_usage, codex_usage: $codex_usage, account_quotas:$account_quotas, account_registry: $registry}' > "$OUT"

if [ -n "${AI_BILLS_SNAPSHOT_SSH_HOST:-}" ]; then
  : "${AI_BILLS_SNAPSHOT_RECEIVER:?Set fixed receiver executable path}"
  : "${AI_BILLS_SNAPSHOT_DESTINATION:?Set fixed snapshot destination}"
  # Strict path alphabet prevents interpretation by the remote login shell.
  [[ "$AI_BILLS_SNAPSHOT_RECEIVER" =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 2
  [[ "$AI_BILLS_SNAPSHOT_DESTINATION" =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 2
  ssh -- "$AI_BILLS_SNAPSHOT_SSH_HOST" "sudo -- $AI_BILLS_SNAPSHOT_RECEIVER $AI_BILLS_SNAPSHOT_DESTINATION" < "$OUT"
else
  scp -q "$OUT" "$AI_BILLS_SNAPSHOT_TARGET"
fi
