---
name: vitest-unit-suite
description: How to generate a real vitest unit-test suite that actually executes and asserts behavior
appliesToRole: trace
triggers: [unit test, vitest, jest, test suite, unit tests, add tests, write tests]
status: draft
version: 0.1.0
---

Generate a REAL unit-test suite for the code under review — tests that execute and assert behavior. Never produce empty or always-passing tests.

Approach:
- Identify the units that carry logic (pure functions, services, reducers) and test those directly; skip trivial glue.
- For each unit, cover: the happy path, at least one edge case, and one failure/error path.
- Assert concrete outputs and side effects — exact values, thrown errors, emitted events — not just "did not throw".
- Use vitest `describe`/`it`/`expect`. Keep tests deterministic (no real network/time/random; inject or mock those).
- One test file per unit, co-located or under test/.

Report the REAL number of tests written and run. A suite with zero executing tests is NOT verification — it must be reported as unverified, never green.
