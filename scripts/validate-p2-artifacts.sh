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
have "pnpm -C shared typecheck" "$ci"   # shared is types-only; gated directly
grep -q "on:" "$ci" && grep -q "push:" "$ci" && grep -q "pull_request:" "$ci" \
  || fail "$ci must trigger on push + pull_request"
# Boot smoke: the ops job must RUN the built image keyless and probe /health (the
# `docker build` only compiles it; nothing else BOOTS the server, which is how
# default-path boot crashes reached main green). Pin the load-bearing pieces so the
# smoke can't be silently dropped: the keyless run, the /health probe, and the
# "ok":true assertion + the loud-fail/cleanup that make a boot crash fail the PR.
have "docker run -d --name akis-smoke" "$ci"   # boots the freshly built image
have "AKIS_ALLOW_MOCK=1"                "$ci"   # keyless: mock provider, no key/DB
have "/health"                         "$ci"   # probes the liveness route
have '"ok":true'                       "$ci"   # asserts the real health handler body
have "docker logs akis-smoke"          "$ci"   # captures logs on failure (loud)
have "docker rm -f akis-smoke"         "$ci"   # always cleans up the container
# Reject ACTUAL use (a `run:` step), not the explanatory comment about avoiding it.
# `-r typecheck` would re-run the backend+frontend tsc their `test` steps already do;
# shared is gated by its own `pnpm -C shared typecheck` step instead.
grep -E "^\s*(run:|-)\s*.*pnpm -r typecheck" "$ci" && fail "$ci must NOT use 'pnpm -r typecheck' (redundant; shared is gated by its own typecheck step)" || true
grep -q "anthropics/claude-code-action" "$ci" && fail "$ci must NOT duplicate the claude AI-review workflows" || true
# pnpm version is pinned via package.json's `packageManager` (action-setup reads it);
# ci.yml must NOT also set a `version:` input or action-setup errors ERR_PNPM_BAD_PM_VERSION.
grep -qE '"packageManager":[[:space:]]*"pnpm@' package.json || fail "package.json must pin pnpm via packageManager"
grep -qE "^\s*version:\s*9" "$ci" && fail "$ci must NOT set a pnpm/action-setup 'version:' input (conflicts with packageManager)" || true

# ── 2b) Dockerfile: OCI image-provenance labels so live-box drift is one
#       `docker inspect` (the 2026-06-07 drift audit had no labels / static 0.0.0
#       and had to fall back to source inspection). The git sha + build timestamp
#       arrive as build-args and are stamped as the standard OCI annotation keys.
df=Dockerfile
have "ARG GIT_REVISION"                          "$df"   # caller passes the git sha
have "ARG BUILD_CREATED"                          "$df"   # …and the build timestamp
have "ARG IMAGE_VERSION"                          "$df"   # …and the release version
# Assert the labels are actually WIRED to the build-args (a hardcoded literal would
# still contain the key but silently break provenance) — guard the interpolation.
have 'image.revision="${GIT_REVISION}"'           "$df"   # → inspectable revision label
have 'image.created="${BUILD_CREATED}"'           "$df"   # → inspectable build-date label
have 'image.version="${IMAGE_VERSION}"'           "$df"   # → inspectable version label

# ── 2c) Release workflow: the published image MUST carry those labels, so the
#       build step has to feed the args (else every release ships unlabeled again).
rel=.github/workflows/release.yml
have "GIT_REVISION="                              "$rel"
have "IMAGE_VERSION="                             "$rel"
have "BUILD_CREATED="                             "$rel"

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
grep -qi "org.opencontainers.image.revision" "$doc" || fail "$doc must document stamping the OCI provenance labels (build-args) so a local build is drift-inspectable"

echo "P2 artifact validation OK (CI workflow + env template + self-host docs)"
