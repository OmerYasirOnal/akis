#!/usr/bin/env bash
# Run the AKIS backend + frontend dev servers IN PARALLEL. Ctrl-C stops both.
#   Keyless demo (default): runs on the deterministic mock provider — no API key needed.
#   Real models: `ANTHROPIC_API_KEY=sk-... AKIS_ALLOW_MOCK= ./scripts/dev.sh`
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AKIS_ALLOW_MOCK="${AKIS_ALLOW_MOCK-1}"   # keyless demo by default
export AKIS_RAG="${AKIS_RAG-1}"                 # zero-touch RAG on
echo "→ backend  http://127.0.0.1:3000   (AKIS_ALLOW_MOCK=${AKIS_ALLOW_MOCK:-off}, AKIS_RAG=${AKIS_RAG:-off})"
echo "→ frontend http://127.0.0.1:5173   (open this; it proxies /sessions,/api,/preview → backend)"
pnpm -C "$ROOT/backend" dev & BACK=$!
pnpm -C "$ROOT/frontend" dev & FRONT=$!
trap 'kill "$BACK" "$FRONT" 2>/dev/null || true' EXIT INT TERM
wait
