# Spawned session tracking

`scripts/akis-spawn-session.sh <name> <prompt-file>` opens an iTerm ultracode
Claude session that reads + follows the prompt file, and records it here:

- `registry.tsv` — one row per spawn: `started \t name \t prompt-file \t status-file`
- `<name>.status.md` — the spawned session is asked to overwrite this with its
  progress/result. Track a session with `cat .akis/sessions/<name>.status.md`.

**Honest limit:** an external Claude session has no externally-readable task ID;
tracking is only via the status file it writes. For work the *orchestrator* runs
(Workflows / background agents), task IDs are tracked natively and notify on done.
