#!/bin/bash
# SessionStart hook — installs the document/report tooling we use to build and
# edit the AKIS bitirme (graduation) report (.docx) and generate its charts.
#
# The Claude Code on the web container is ephemeral and rebuilt from the repo on
# every session, so anything installed at runtime is lost. This hook re-installs
# the tools each session. It is idempotent (safe to re-run) and runs only in the
# remote/web environment so it never modifies a developer's local machine.
set -euo pipefail

# Only run in the Claude Code on the web (remote) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REQ_FILE="$PROJECT_DIR/.claude/report-requirements.txt"

# --- System packages (PDF text/render + universal document conversion) ---
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

need_apt=()
command -v pdftotext >/dev/null 2>&1 || need_apt+=(poppler-utils)
command -v pandoc    >/dev/null 2>&1 || need_apt+=(pandoc)

if [ "${#need_apt[@]}" -gt 0 ]; then
  echo "[session-start] installing apt packages: ${need_apt[*]}"
  $SUDO apt-get update -qq || true
  $SUDO apt-get install -y "${need_apt[@]}"
fi

# --- Python packages (python-docx, matplotlib, openpyxl, pandas, ...) ---
if [ -f "$REQ_FILE" ]; then
  echo "[session-start] installing Python report tooling from $REQ_FILE"
  python3 -m pip install --quiet --disable-pip-version-check -r "$REQ_FILE"
fi

echo "[session-start] report tooling ready."
