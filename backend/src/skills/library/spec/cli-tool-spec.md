---
name: cli-tool-spec
description: How to write a spec for a command-line tool
appliesToRole: scribe
triggers: [cli, command line tool, command-line, terminal tool, build a cli, cli utility, shell tool, make a command]
status: draft
version: 0.1.0
---

Turn a CLI idea into a spec a developer can implement with predictable UX. Produce:

1. Purpose & usage — one-line description and the top usage example(s).
2. Command structure — the binary name and any subcommands; synopsis (`tool <cmd> [options] <args>`).
3. Commands — each command/subcommand, its purpose, positional arguments.
4. Options & flags — name (long/short), type, default, required?, effect for each.
5. Input/output — stdin handling, stdout format (human vs JSON/quiet), stderr usage, file I/O.
6. Exit codes — 0 for success plus specific non-zero codes mapped to error conditions.
7. Config & environment — config file location/format, relevant env vars, precedence.
8. Acceptance criteria — concrete invocations with expected output and exit code.

Use real command strings. Flag ambiguous defaults as open questions rather than guessing.
