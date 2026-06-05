#!/usr/bin/env bash
# Run the AKIS backend + frontend dev servers IN PARALLEL. Ctrl-C stops both.
#
#   Keyless demo (default):  ./scripts/dev.sh
#       runs on the deterministic mock provider — no API key needed.
#
#   Real keys from a .env:   AKIS_ENV_FILE=/path/to/.env ./scripts/dev.sh
#       sources that .env (AI_PROVIDER + AI_API_KEY + AI_MODEL, or ANTHROPIC_API_KEY)
#       and runs FULLY REAL by default: real provider + REAL verification (the boot-smoke
#       verifier actually boots the produced app and probes it over HTTP — no browsers
#       needed). Set AKIS_DEMO_VERIFY=1 explicitly to fake verification (demo only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Source an env file if given (values exported, never echoed). Explicit AKIS_ENV_FILE
# wins; otherwise a local backend/.env (gitignored) is used if present.
ENV_FILE="${AKIS_ENV_FILE:-$ROOT/backend/.env}"
if [ -f "$ENV_FILE" ]; then echo "→ env: sourcing $ENV_FILE"; set -a; . "$ENV_FILE"; set +a; fi

# No real provider key configured → fall back to the keyless mock demo.
if [ -z "${AI_API_KEY:-}${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${OPENROUTER_API_KEY:-}${GOOGLE_API_KEY:-}${GEMINI_API_KEY:-}" ]; then
  export AKIS_ALLOW_MOCK="${AKIS_ALLOW_MOCK:-1}"
fi
export AKIS_RAG="${AKIS_RAG:-1}"
# REAL BY DEFAULT (owner decision 2026-06-05: "artık mock olmasın"): with a real key,
# verification is the REAL boot-smoke (boots the app, probes it). Demo-verify is an
# EXPLICIT opt-in only — never a silent default.
if [ -z "${AKIS_ALLOW_MOCK:-}" ]; then
  export AKIS_REAL_TESTS="${AKIS_REAL_TESTS:-1}"
fi
export AKIS_DEMO_VERIFY="${AKIS_DEMO_VERIFY:-}" 
export NODE_ENV="${NODE_ENV:-development}"          # never 'test' (that forces the mock)
export PORT="${PORT:-3000}"

# Serve the frontend on the SAME host the CSRF guard trusts. When PUBLIC_BASE_URL is set,
# the backend enforces that browser Origin EXACTLY, so a localhost-vs-127.0.0.1 mismatch
# would block every login/signup/key-save. Derive the host from it (else loopback) so the
# URL we print is always the exact one to open.
FE_HOST=127.0.0.1
if [ -n "${PUBLIC_BASE_URL:-}" ]; then
  FE_HOST="$(printf '%s' "$PUBLIC_BASE_URL" | sed -E 's#^[a-zA-Z]+://([^:/]+).*#\1#')"
  echo "→ note: PUBLIC_BASE_URL set → serving the frontend on '$FE_HOST' to match the CSRF origin"
fi

echo "→ backend  http://127.0.0.1:$PORT   (mock=${AKIS_ALLOW_MOCK:-off}, rag=$AKIS_RAG, real-tests=${AKIS_REAL_TESTS:-off}, demo-verify=${AKIS_DEMO_VERIFY:-off})"
echo "→ frontend http://$FE_HOST:5173   (OPEN THIS; proxies /sessions,/api,/preview,/auth → backend)"
pnpm -C "$ROOT/backend" dev & BACK=$!
pnpm -C "$ROOT/frontend" dev --host "$FE_HOST" --port 5173 & FRONT=$!
trap 'kill "$BACK" "$FRONT" 2>/dev/null || true' EXIT INT TERM
wait
