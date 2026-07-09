#!/bin/bash
# SessionStart hook — report/document tooling for the AKIS bitirme (graduation)
# report (.docx). The report was DELIVERED and graded (2026-07: 93/100, AA), so
# this tooling is no longer installed by default — it cost 30-60s of apt/pip on
# every ephemeral web-container session.
#
# To re-enable (e.g. to rework the report into a paper), set AKIS_REPORT_TOOLING=1
# in the environment, or install manually:
#   pip install -r .claude/report-requirements.txt
#   apt-get install -y poppler-utils pandoc
set -euo pipefail

# Only ever runs in the Claude Code on the web (remote) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Report tooling is opt-in since the report was delivered.
if [ "${AKIS_REPORT_TOOLING:-}" != "1" ]; then
  echo "[session-start] report delivered — skipping report tooling (set AKIS_REPORT_TOOLING=1 to install)."
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
