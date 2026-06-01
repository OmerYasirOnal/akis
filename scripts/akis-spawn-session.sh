#!/usr/bin/env bash
# akis-spawn-session.sh — open a new iTerm window running an ultracode Claude Code
# session that reads + follows a prompt file, and register it for status tracking.
#
# Usage:
#   scripts/akis-spawn-session.sh <session-name> <prompt-file> [project-dir]
#
# What it does (in a fresh iTerm window):
#   1. cd into the project dir (default: this repo)
#   2. start:  claude --dangerously-skip-permissions
#      (the real "bypass permissions" flag; --bypass-permission is not a valid flag)
#   3. set effort:  /effort ultracode
#      (NOTE: verify this matches your build's command; adjust EFFORT_CMD below if needed)
#   4. tell the session to READ AND FOLLOW <prompt-file>
#      (passing the prompt as a file avoids multi-line paste/quoting problems)
#   5. append a row to .akis/sessions/registry.tsv and create a status file the
#      spawned session is asked to update, so progress is trackable from this repo.
#
# Honest limit: a spawned external Claude session is independent — there is no API
# to read its internal task IDs from outside. Tracking works ONLY via the status
# file the session writes (the prompt file should instruct it to update that file).
set -euo pipefail

NAME="${1:?usage: akis-spawn-session.sh <session-name> <prompt-file> [project-dir]}"
PROMPT_FILE="${2:?missing <prompt-file>}"
PROJECT_DIR="${3:-/Users/omeryasironal/Projects/akis-platform-mvp}"
EFFORT_CMD="/effort ultracode"   # adjust if your CLI uses a different effort command

if [ ! -f "$PROMPT_FILE" ]; then echo "prompt file not found: $PROMPT_FILE" >&2; exit 1; fi
PROMPT_FILE="$(cd "$(dirname "$PROMPT_FILE")" && pwd)/$(basename "$PROMPT_FILE")"

SESS_DIR="$PROJECT_DIR/.akis/sessions"
mkdir -p "$SESS_DIR"
STATUS_FILE="$SESS_DIR/$NAME.status.md"
STAMP="$(date '+%Y-%m-%dT%H:%M:%S')"

# Seed the status file and register the session.
printf '# session: %s\nstarted: %s\nprompt: %s\nstatus: launched\n\n(awaiting the session to update this file)\n' \
  "$NAME" "$STAMP" "$PROMPT_FILE" > "$STATUS_FILE"
printf '%s\t%s\t%s\t%s\n' "$STAMP" "$NAME" "$PROMPT_FILE" "$STATUS_FILE" >> "$SESS_DIR/registry.tsv"

# Drive iTerm via AppleScript. write text sends the line + Enter.
osascript <<OSA
tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "cd ${PROJECT_DIR}"
    write text "claude --dangerously-skip-permissions"
    delay 8
    write text "${EFFORT_CMD}"
    delay 2
    write text "Read and follow the instructions in ${PROMPT_FILE} . Write your progress/result to ${STATUS_FILE} (overwrite it) as you go and when you finish."
  end tell
end tell
OSA

echo "spawned '$NAME' → status: $STATUS_FILE"
echo "track with:  cat \"$STATUS_FILE\"   |   registry: $SESS_DIR/registry.tsv"
