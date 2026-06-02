---
name: cli-tool-scaffold
description: How to scaffold a command-line tool with a clean command/flag structure
appliesToRole: proto
triggers: [cli, command line tool, terminal tool, cli scaffold, build a cli, shell tool]
status: draft
version: 0.1.0
---

Scaffold a runnable CLI with a clear command structure and testable core.

Layout (under src/): a thin bin entry (the executable) that parses args and dispatches; a commands/ folder with one file per command; a core/ (or lib/) holding the actual logic as plain functions that DON'T touch process.argv or stdout directly; a config module for env/flags.

Rules:
- Separate parsing from doing: the bin entry parses, commands orchestrate, core/ functions are pure and unit-testable.
- Map outcomes to explicit exit codes (0 success; documented non-zero failures).
- Write human output to stdout, errors/diagnostics to stderr; support a `--json` (machine) mode where useful.
- Support `--help` and `--version`.
- Read configuration from flags > env > config file, in that precedence.
- Provide package.json `bin` + scripts: build, test.

Deliver a minimal tree where one command runs end-to-end and returns the right exit code.
