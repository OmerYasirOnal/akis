#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# P2 (ops / self-host) artifact validation — a fast static guard that the lane's
# config files exist AND encode the SHARED CONTRACT correctly (no docker daemon
# needed). Run: bash scripts/validate-p2-artifacts.sh
#
# This is the "test" for config-only artifacts (CI workflow, env template,
# self-hosting docs): there is no runtime behavior to vitest, so we assert the
# load-bearing contents instead. It must stay GREEN.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "FAIL: $*" >&2; exit 1; }
have() { grep -q -- "$1" "$2" || fail "$2 missing: $1"; }

# ── 1) all six lane artifacts present ────────────────────────────────────────
for f in Dockerfile .dockerignore docker-compose.yml \
         .github/workflows/ci.yml backend/.env.example docs/SELF_HOSTING.md; do
  test -f "$f" || fail "MISSING $f"
done

# ── 2) CI workflow: the pieces the contract pins ─────────────────────────────
ci=.github/workflows/ci.yml
have "actions/checkout@v4"      "$ci"
have "pnpm/action-setup@v4"     "$ci"
have "actions/setup-node@v4"    "$ci"
have "node-version: 22"         "$ci"   # one Node major, pinned (no 'lts')
have "cache: pnpm"              "$ci"
have "install --frozen-lockfile" "$ci"
have "pnpm -C backend test"     "$ci"
have "pnpm -C frontend test"    "$ci"
grep -q "on:" "$ci" && grep -q "push:" "$ci" && grep -q "pull_request:" "$ci" \
  || fail "$ci must trigger on push + pull_request"
# Reject ACTUAL use (a `run:` step), not the explanatory comment about avoiding it.
grep -E "^\s*(run:|-)\s*.*pnpm -r typecheck" "$ci" && fail "$ci must NOT use 'pnpm -r typecheck' (shared has no local tsc)" || true
grep -q "anthropics/claude-code-action" "$ci" && fail "$ci must NOT duplicate the claude AI-review workflows" || true
grep -qi "version: 9" "$ci" || fail "$ci pnpm/action-setup must pin version 9"

# ── 3) env template: self-host/DB block added, existing keys kept ────────────
env=backend/.env.example
have "postgres://akis:akis@db:5432/akis" "$env"   # compose default for DATABASE_URL
have "SERVE_STATIC" "$env"
have "HOST" "$env"
have "0.0.0.0" "$env"                              # the container-HOST note
have "DATABASE_URL" "$env"
have "ANTHROPIC_API_KEY" "$env"                    # existing provider key kept
have "AUTH_JWT_SECRET" "$env"                      # existing auth key kept
have "AI_KEY_ENCRYPTION_KEY" "$env"                # existing keystore key kept

# ── 4) self-hosting docs: the load-bearing sections ──────────────────────────
doc=docs/SELF_HOSTING.md
have "docker compose up" "$doc"                    # quickstart
have "DATABASE_URL"      "$doc"                     # env reference + persistence
grep -qi "vector"        "$doc" || fail "$doc must document the vector/RAG-index rebuild-on-restart deferral"
grep -qi "backup"        "$doc" || fail "$doc must document the postgres volume backup/restore"
grep -qi "sandbox"       "$doc" || fail "$doc must carry the no-sandbox security warning"
grep -qi "single-user"   "$doc" || fail "$doc must state the single-user posture"

echo "P2 artifact validation OK (CI workflow + env template + self-host docs)"
