---
name: api-contract-tests
description: How to generate real API contract tests against the spec's endpoints
appliesToRole: trace
triggers: [api test, contract test, endpoint test, integration test, http test, api contract]
status: draft
version: 0.1.0
---

Generate REAL contract tests that exercise the API against its spec. Never produce empty or always-passing tests.

Approach:
- For each endpoint in the spec, test: a valid request returns the documented status + response shape; a invalid/missing-field request returns the documented error status; an unauthorized request is rejected when the endpoint is protected.
- Assert on status code AND body shape (key fields, types), not just reachability.
- Drive the running app (in-process server or a test client); keep tests hermetic (seed/teardown data, no shared mutable state, no external network).
- Cover at least one pagination/filter case if the contract defines one.

Report the REAL number of tests written and run. Zero executing tests is NOT verification — report unverified, never green.
