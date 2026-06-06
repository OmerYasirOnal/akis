# Contributing to AKIS

Thanks for your interest. AKIS turns an idea into a real, tested, running app through a team of AI
agents behind **four structural gates** — and the gates are sacred. Read this before opening a PR.

## Dev setup

```bash
pnpm install                 # pnpm workspace: backend / frontend / shared
# backend (Fastify + tsx, strict TS)
cd backend && npm run dev    # reads AKIS_ENV_FILE / backend/.env (see backend/.env.example)
# frontend (Vite + React, strict TS)
cd frontend && npm run dev
```

Requirements: Node ≥ 20 (some publish/runtime features want ≥ 22.13 for `node:sqlite`), pnpm, and —
for the optional read-only GitHub-via-MCP feature — Docker. AKIS runs **keyless by default** (mock
providers / offline embeddings); add a provider key in Settings for live builds.

## The non-negotiable rule: don't weaken the gates

The product's thesis is *verification cannot be bypassed by construction*. The four gates are
server-minted capability tokens (`backend/src/gates/`), the VerifyToken is Trace-only and fail-closed,
and the frontend holds **no** gate authority. A change that lets any agent, route, chat turn, or MCP
tool bypass, forge, or client-mint a gate will be rejected. When in doubt, ask in an issue first.

## Before you open a PR

- **Typecheck + tests must pass:** `cd backend && npx tsc --noEmit && npm test` and
  `cd frontend && npx tsc -p tsconfig.json --noEmit && npm test` (both must be green).
- Match the surrounding code's idiom (strict TS — `exactOptionalPropertyTypes` +
  `noUncheckedIndexedAccess`; dense WHY-comments; explicit fakes over mock libraries; i18n strings in
  **both** `frontend/src/i18n/catalog.ts` EN + TR blocks).
- Pin new behavior with a test that would fail on the old code; adapt coverage, don't delete it.
- Keep PRs focused. Describe what changed and why.

## Reporting security issues

Do **not** file a public issue — see [SECURITY.md](./SECURITY.md).

By contributing you agree your contributions are licensed under the project's [Apache-2.0](./LICENSE) license.
