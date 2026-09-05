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
: "${AI_BILLS_SNAPSHOT_TARGET:?Set AI_BILLS_SNAPSHOT_TARGET}"
: "${INFISICAL_PROJECT_ID:?Set INFISICAL_PROJECT_ID}"
export AI_BILLS_MAESTRO_DB AI_BILLS_PAYMENTS_FILE
CLIPROXY_KEYS_FILE="${AI_USAGE_KEYS_FILE:-/opt/cliproxyapi/.keys}"
CLIPROXY_AUTH_DIR="${AI_BILLS_CLIPROXY_AUTH_DIR:-/opt/cliproxyapi/auths}"
CLIPROXY_MGMT_URL="${AI_BILLS_CLIPROXY_MGMT_URL:-http://127.0.0.1:23020/v0/management}"
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
CLAUDE_USAGE=$(
  for f in "$CLIPROXY_AUTH_DIR"/claude-*.json; do
    [ -f "$f" ] || continue
    email=$(jq -r '.email // empty' "$f")
    ctok=$(jq -r '.access_token // empty' "$f")
    { [ -n "$email" ] && [ -n "$ctok" ]; } || continue
    if resp=$(curl -sf -m 15 https://api.anthropic.com/api/oauth/usage \
        -H "Authorization: Bearer $ctok" -H "anthropic-beta: oauth-2025-04-20"); then
      jq -n --arg email "$email" --argjson data "$resp" \
        '{($email): {ok: true, fetched_at: (now|todate), data: $data}}'
    else
      jq -n --arg email "$email" \
        '{($email): {ok: false, fetched_at: (now|todate), error: "oauth usage fetch failed"}}'
    fi
  done | jq -s 'add // {}'
) || CLAUDE_USAGE='{}'
[ -n "$CLAUDE_USAGE" ] || CLAUDE_USAGE='{}'

# --- maestro cost-obs: today tokens × per-backend pricing ---
COST=$(uv run --no-project python - <<'PYEOF'
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
        pricing[name] = (float(m_in.group(1)) if m_in else 0.0,
                         float(m_out.group(1)) if m_out else 0.0)
tok = {}
for b, sj in db.execute("SELECT backend, session_json FROM sessions WHERE updated_at >= ?", (today,)):
    try: t = json.loads(sj).get('tokens_used_total', 0) or 0
    except Exception: t = 0
    tok[b] = tok.get(b, 0) + t
out = []
for b, t in sorted(tok.items(), key=lambda x: -x[1]):
    pin, pout = pricing.get(b, (0, 0))
    # blended 70/30 in/out estimate, same convention as llm-subscriptions-catalog
    est = t / 1e6 * (0.7 * pin + 0.3 * pout)
    out.append({'backend': b, 'tokens_today': t, 'est_usd_today': round(est, 2),
                'flat': pin == 0 and pout == 0})
print(json.dumps(out))
PYEOF
) || COST='[]'

# --- vault: provider cards frontmatter + payments ---
PROVIDERS=$(uv run --no-project python - "$AI_BILLS_PROVIDERS_DIR" <<'PYEOF'
import sys, os, json, re
root = sys.argv[1]
cards = []
for dirpath, _, files in os.walk(root):
    for fn in files:
        if not fn.endswith('.md'): continue
        p = os.path.join(dirpath, fn)
        txt = open(p, encoding='utf-8').read()
        m = re.match(r'^---\n(.*?)\n---', txt, re.S)
        if not m: continue
        fm = {}
        for line in m.group(1).splitlines():
            km = re.match(r'^(\w[\w_]*):\s*(.+?)\s*$', line)
            if km: fm[km.group(1)] = km.group(2).strip('"\'')
        if 'provider' not in fm: continue
        cards.append({k: fm.get(k) for k in
            ('title','provider','plan','billing','cost_usd_month','tier','status','risk','verified','dashboard')})
print(json.dumps(cards))
PYEOF
) || PROVIDERS='[]'
PAYMENTS=$(uv run --no-project python -c "
import yaml, json, sys, os
d = yaml.safe_load(open(os.environ['AI_BILLS_PAYMENTS_FILE']))
print(json.dumps(d.get('payments', []), default=str))
" 2>/dev/null) || PAYMENTS='[]'

# --- token ledger rollup (see [[ai-usage-ledger]]) — real per-request accounting,
# --- unlike maestro_cost_today, which only ever saw the Maestro orchestrator.
LEDGER=$(~/.local/bin/ai-usage-report --rollup 2>/dev/null) || LEDGER='{}'
[ -n "$LEDGER" ] || LEDGER='{}'

jq -n \
  --argjson runpod "$RUNPOD" --argjson vast "$VAST" \
  --argjson auths "$AUTHS" --argjson usage "$USAGE" \
  --argjson cost "$COST" --argjson providers "$PROVIDERS" \
  --argjson payments "$PAYMENTS" \
  --argjson ledger "$LEDGER" \
  --argjson claude_usage "$CLAUDE_USAGE" \
  '{generated: (now | todate), runpod: $runpod, vast: $vast,
    proxy_auths: $auths, proxy_usage: $usage,
    maestro_cost_today: $cost, providers: $providers, payments: $payments,
    usage_ledger: $ledger, claude_usage: $claude_usage}' > "$OUT"

scp -q "$OUT" "$AI_BILLS_SNAPSHOT_TARGET"
