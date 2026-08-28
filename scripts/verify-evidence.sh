#!/usr/bin/env bash
# End-to-end check of the evidence path: seed a store, serve it, export every
# audit bundle over the real HTTP route, and verify each one.
#
# This is the middleware's own acceptance test. `npm run check` proves the code
# behaves; this proves the artifact a reviewer walks away with is well formed
# and carries no credential-shaped string.
#
#   npm run verify:evidence
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${VERIFY_PORT:-3199}"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$ROOT"

if [ ! -f apps/server/dist/index.js ]; then
  echo "Building the server first..."
  npm run build -w @launchpad/server
fi

echo "Seeding a throwaway store..."
APP_DATA_DIR="$WORK/data" AGENT_WORKSPACE_ROOT="$WORK/workspaces" \
  node scripts/seed-demo.mjs > /dev/null

echo "Starting the control plane on port $PORT..."
env -u APP_AUTH_TOKEN -u ARK_API_KEY \
  NODE_ENV=production HOST=127.0.0.1 PORT="$PORT" \
  APP_DATA_DIR="$WORK/data" AGENT_WORKSPACE_ROOT="$WORK/workspaces" \
  CODEX_HOME="$WORK/codex" \
  TRACE_COST_INPUT_PER_MTOK=0.14 \
  TRACE_COST_CACHED_INPUT_PER_MTOK=0.014 \
  TRACE_COST_OUTPUT_PER_MTOK=0.28 \
  node apps/server/dist/index.js > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
  echo "The server did not come up. Log:" >&2
  cat "$WORK/server.log" >&2
  exit 1
fi

AGENT_ID="$(curl -fsS "http://127.0.0.1:$PORT/api/agents" \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>console.log(JSON.parse(raw).agents[0].id))')"
RUN_IDS="$(curl -fsS "http://127.0.0.1:$PORT/api/agents/$AGENT_ID/runs" \
  | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>console.log(JSON.parse(raw).runs.map(r=>r.id).join(" ")))')"

if [ -z "$RUN_IDS" ]; then
  echo "The seeded Agent has no Runs to export." >&2
  exit 1
fi

STATUS=0
for RUN_ID in $RUN_IDS; do
  curl -fsS "http://127.0.0.1:$PORT/api/runs/$RUN_ID/audit" -o "$WORK/$RUN_ID.json"
  node scripts/verify-audit.mjs "$WORK/$RUN_ID.json" || STATUS=1
done

# The route is authenticated in every deployment that sets a token; prove the
# evidence path is behind the same hook as everything else.
echo "Checking that the export route is guarded when a token is configured..."
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
env -u ARK_API_KEY NODE_ENV=production HOST=127.0.0.1 PORT="$PORT" \
  APP_AUTH_TOKEN=verify-evidence-token \
  APP_DATA_DIR="$WORK/data" AGENT_WORKSPACE_ROOT="$WORK/workspaces" \
  CODEX_HOME="$WORK/codex" \
  node apps/server/dist/index.js > "$WORK/server-auth.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  if curl -fsS -H "Authorization: Bearer verify-evidence-token" \
    "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then break; fi
  sleep 0.2
done

FIRST_RUN="$(echo "$RUN_IDS" | awk '{print $1}')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/runs/$FIRST_RUN/audit")"
if [ "$CODE" != "401" ]; then
  echo "  FAILED: unauthenticated audit export returned $CODE, expected 401" >&2
  STATUS=1
else
  echo "  OK: unauthenticated audit export is refused (401)"
fi

if [ "$STATUS" -eq 0 ]; then
  echo
  echo "Evidence path verified end to end."
fi
exit "$STATUS"
