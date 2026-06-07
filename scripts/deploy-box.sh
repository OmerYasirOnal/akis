#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-box.sh — ship the current tree to a self-host box that runs the bundled
# `akis:deploy` image via docker-compose (no source/git on the box).
#
# What it does (codifies the manual flow that used to live only in operator memory):
#   1. cross-build a linux/amd64 image to a COMPLETE docker tarball,
#   2. back up the box's current image as a rollback tag,
#   3. transfer + load the new image,
#   4. recreate the app container, then probe /health,
#   5. AUTO-ROLLBACK to the previous image if /health does not come up.
#
# Usage:
#   AKIS_DEPLOY_HOST=1.2.3.4 ./scripts/deploy-box.sh
# Env (no secrets are ever passed on the command line or baked into the image):
#   AKIS_DEPLOY_HOST   (required) ssh host/IP of the box
#   AKIS_DEPLOY_USER   (default: ubuntu)
#   AKIS_DEPLOY_DIR    (default: ~/akis-deploy) — holds docker-compose.yml + .env on the box
#   AKIS_DEPLOY_PORT   (default: 3000) — the host port the app publishes (for the /health probe)
#   AKIS_IMAGE_TAG     (default: akis:deploy) — must match `image:` in the box compose
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HOST="${AKIS_DEPLOY_HOST:?set AKIS_DEPLOY_HOST to the box ssh host/IP}"
USER="${AKIS_DEPLOY_USER:-ubuntu}"
DIR="${AKIS_DEPLOY_DIR:-~/akis-deploy}"
PORT="${AKIS_DEPLOY_PORT:-3000}"
TAG="${AKIS_IMAGE_TAG:-akis:deploy}"
SSH="ssh -o ConnectTimeout=10 ${USER}@${HOST}"
TAR="$(mktemp -t akis-amd64.XXXXXX.tar)"
trap 'rm -f "$TAR"' EXIT
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "▸ 1/5 cross-building linux/amd64 → $TAR"
# FOOTGUN: buildx's DEFAULT provenance/attestation makes `--load` produce a HOLLOW image
# (the layers stay in the build cache, not the docker store). ALWAYS pass --provenance=false
# --sbom=false AND export to a tarball with `-o type=docker,dest=…` so the artifact is a
# complete, self-contained image (gzipped — a ~135MB tar inflates to the real ~650MB image).
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -t "$TAG" -o "type=docker,dest=$TAR" "$ROOT"

echo "▸ 2/5 backing up the box's current image as ${TAG}-prev (rollback)"
# `|| true`: a first-ever deploy has no current image to back up — not a failure.
$SSH "docker tag '$TAG' '${TAG}-prev' 2>/dev/null || echo '(no current image to back up — first deploy)'"

echo "▸ 3/5 transferring + loading the image (~$(du -h "$TAR" | cut -f1))"
# Stream the tarball straight into `docker load` on the box (no scp round-trip on disk).
$SSH "docker load" < "$TAR"

echo "▸ 4/5 recreating the app container"
$SSH "cd $DIR && docker compose up -d app"

echo "▸ 5/5 probing /health (up to ~60s)"
ok=0
for _ in $(seq 1 12); do
  if $SSH "wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1"; then ok=1; break; fi
  sleep 5
done

if [ "$ok" = "1" ]; then
  echo "✓ deploy healthy on ${HOST}:${PORT}"
  exit 0
fi

echo "✗ /health did not come up — ROLLING BACK to ${TAG}-prev" >&2
# Roll back only if a previous image exists; otherwise leave the failed container for inspection.
$SSH "if docker image inspect '${TAG}-prev' >/dev/null 2>&1; then docker tag '${TAG}-prev' '$TAG' && cd $DIR && docker compose up -d app && echo 'rolled back'; else echo 'no rollback image — inspect manually' >&2; fi"
exit 1
