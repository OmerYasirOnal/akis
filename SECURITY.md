# Security Policy

AKIS is a build pipeline whose entire value is **auditable, gate-enforced delivery**. We take
security reports seriously and ask you to disclose responsibly.

## Reporting a vulnerability

**Do NOT open a public issue for a security problem.** Instead, report it privately:

- Use GitHub's **[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** ("Report a vulnerability" under the repo's Security tab), **or**
- Email **onalomer44@gmail.com** with `SECURITY` in the subject.

Please include: a description, reproduction steps, the affected version/commit, and impact. We aim to
acknowledge within 72 hours and to coordinate a fix + disclosure timeline with you.

## What we especially care about

The four structural gates are the product's spine — report anything that could **bypass, weaken, or
client-mint** one of them:

- **ApprovedSpec** (Gate 1) — server-minted only; no code is written without it.
- **VerifyToken** (Gates 2+3) — Trace-only, fail-closed (a real ≥1-test pass; 0 tests can never verify).
- **ApprovedPush** (Gate 4) — minted only from a VerifyToken, digest-bound to the pushed files.

Also in scope: per-user secret handling (provider keys, GitHub OAuth tokens, SSH keys are AES-256-GCM
encrypted at rest and must never reach logs/argv/responses), owner-scoping of session routes, the
read-only MCP allowlist, the "publish to your own server" path (SSH option-injection, path traversal,
SSRF, host-key pinning), and the build-aware chat (must stay strictly read-only).

## Honest limitations (by design, documented — not vulnerabilities)

AKIS self-host is currently **single-user / single-tenant**: it binds to loopback by default and is
**not** hardened for exposure to untrusted users. Generated apps run on the host without an isolating
sandbox. See `docs/SELF_HOSTING.md` and the threat-model docs. Running it exposed to untrusted users
is out of the supported model — do not do it without your own isolation.

## Supported versions

This is pre-1.0, actively developed. Security fixes land on `main`; please test against the latest `main`.
