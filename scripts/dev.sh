#!/usr/bin/env bash
# Run the AKIS backend + frontend dev servers IN PARALLEL. Ctrl-C stops both.
#
#   Keyless demo (default):  ./scripts/dev.sh
#       runs on the deterministic mock provider — no API key needed.
#
#   Real keys from a .env:   AKIS_ENV_FILE=/path/to/.env ./scripts/dev.sh
#       sources that .env (AI_PROVIDER + AI_API_KEY + AI_MODEL, or ANTHROPIC_API_KEY)
#       and runs on the REAL provider. AKIS_DEMO_VERIFY=1 (default) lets a run reach
#       done+preview without real browsers (real LLM output, demo verify); set
#       AKIS_REAL_TESTS=1 for real Playwright+Cucumber verification (browsers needed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Source an env file if given (values exported, never echoed). Explicit AKIS_ENV_FILE
# wins; otherwise a local backend/.env (gitignored) is used if present.
ENV_FILE="${AKIS_ENV_FILE:-$ROOT/backend/.env}"
if [ -f "$ENV_FILE" ]; then echo "→ env: sourcing $ENV_FILE"; set -a; . "$ENV_FILE"; set +a; fi

# No real provider key configured → fall back to the keyless mock demo.
if [ -z "${AI_API_KEY:-}${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${OPENROUTER_API_KEY:-}${GOOGLE_API_KEY:-}" ]; then
  export AKIS_ALLOW_MOCK="${AKIS_ALLOW_MOCK:-1}"
fi
export AKIS_RAG="${AKIS_RAG:-1}"
export AKIS_DEMO_VERIFY="${AKIS_DEMO_VERIFY:-1}"   # complete the loop without real browsers
export NODE_ENV="${NODE_ENV:-development}"          # never 'test' (that forces the mock)
export PORT="${PORT:-3000}"

echo "→ backend  http://127.0.0.1:$PORT   (mock=${AKIS_ALLOW_MOCK:-off}, rag=$AKIS_RAG, demo-verify=$AKIS_DEMO_VERIFY)"
echo "→ frontend http://127.0.0.1:5173   (open this; proxies /sessions,/api,/preview → backend)"
pnpm -C "$ROOT/backend" dev & BACK=$!
pnpm -C "$ROOT/frontend" dev --host 127.0.0.1 --port 5173 & FRONT=$!
trap 'kill "$BACK" "$FRONT" 2>/dev/null || true' EXIT INT TERM
wait
