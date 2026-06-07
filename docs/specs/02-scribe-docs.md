# SPEC 02 — Scribe writes documentation INTO the generated app (ships + pushes with the code)

Status: DRAFT · No creds needed (pure code) · High value, low risk · Grounds: reference research §3.

## Goal (owner's mandate)

> "Lots of code gets written but their DOCUMENTATION should have been written by Scribe — it should add that among the code/files too, and it should go to GitHub."

Today: ZERO docs in a generated app. Proto emits only runnable code ("do not add tests," never a README — `ProtoAgent.ts:67-77`); Scribe is spec-only. So a built+pushed app has no README.

## The gate-safe design (the 4 moments)

The build is one linear pipeline (`Orchestrator.ts`). The file set is digest-bound at verify (`:404`) and re-checked at push (`pushGate.ts:40`). Therefore docs MUST be in the file set BEFORE verify — then they ride through verification, become part of the VerifyToken's `codeDigest`, and ship via the SAME existing Gate 4 push. No new gate, no new token.

**Injection point — the single choke point** `Orchestrator.ts:333`:
```
const candidate = mergeFiles(baseFiles, proto.files)              // existing
const docs = await this.s.scribe.writeDocs({ spec: approved.spec, files: candidate })  // NEW
const candidateWithDocs = docs ? mergeFiles(candidate, [docs]) : candidate             // NEW (stable path README.md overlays; no dupes on iterate/edit rounds)
// …use candidateWithDocs from :336 (validate) onward: critic, store.update, verify
```

## Components

1. **New producer `ScribeAgent.writeDocs({spec, files}) → RepoFile | undefined`.**
   - Separate method (NOT folded into `run()`'s discriminated `ScribeOutcome` — that would be a breaking overload).
   - Zero gate authority — only the LLM provider + the event bus (identical trust posture to Proto).
   - Emits `agent_start`/`tool_call`/`tool_result`/`agent_end` on the bus so it's visible on the live stream (a "Scribe is documenting…" lane).
   - Returns a single `{ filePath: 'README.md', content }` (a stable path so re-runs overlay, never duplicate).
   - **Fail-soft:** throws/empty → proceed with `candidate` unchanged. Docs are additive; they NEVER block a build. Keyless/mock provider stays green (returns undefined).

2. **Validator language fix (REQUIRED)** `Orchestrator.ts:337`: today every file is labeled `language:'typescript'`; `SyntaxCheck.checkBalance` runs bracket-balance on ts/js and a normal README (`[links]`, prose `(`, ``` fences) can flip `validation.passed` false → blocks approval. Fix: per-file language by extension — `*.md`→`'markdown'`, `*.txt`→`'text'`, `*.json`→`'json'`, else `'typescript'`. `SyntaxCheck` already no-ops on non-ts/js/json. Verify `StructureCheck`/`ImportCheck`/`SecurityCheck` no-op on `.md`.

3. **Prompt (grounded, no hallucination):** author a concise README from the APPROVED spec + the actual files — title, what it does, how to run locally (per Proto rule 3), the acceptance criteria as a feature list. Preserve the old repo's no-invention directive ("ONLY repository evidence; emit `TODO: Add X` instead of inventing") — matches AKIS's provenance posture. Bound the output (a few KB) so it never floods the digest/context.

## Verification (all unit, no creds)

- After a build, `code.files` contains `README.md` with the spec's title/run instructions.
- Digest invariant: `VerifyToken.codeDigest === digestFiles(candidateWithDocs)` and the push gate re-check passes (the README ships).
- Validator: a README with brackets/fences/links does NOT fail `validation.passed`.
- Fail-soft: a throwing `writeDocs` leaves the build green with `candidate` unchanged.
- Mock/keyless: `writeDocs` returns undefined → no README, build still green (no fabricated empty file).
- Idempotent on iterate/edit: a second round overlays README.md, never adds README-2.md.

## Optional later (from old repo, reusable as-is)

`DocContract.ts` (`DOC_PACK_TARGETS`, `targetToPath` → README.md + docs/*.md, `buildContractPrompt`, depth/token limits) — a drop-in if a multi-file Doc Pack (`docs/ARCHITECTURE.md`, `API.md`) is wanted. Watch the 64k token budget split + char-truncation on large apps.

## Effort: SMALL–MED, fully offline. Independent of the MCP work — can land first.
