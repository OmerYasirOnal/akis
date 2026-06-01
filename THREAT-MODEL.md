# AKIS MVP — Threat Model (sub-project #1: agentic core + 4 gates)

> **Thesis:** AKIS's value is *quality trust* — that a result marked **verified** really was produced through Scribe → human approval → Proto → Validator → Critic → Trace (a real test) → human push-confirm. This document states **exactly what the gates guarantee and what they do not**, so the claim is honest and defensible.
>
> Per `HANDOFF.md` (line 142): the thesis is **quality trust, not security**. This model scopes the gates accordingly.

## Trust domain

- **One trust domain, one process.** All of `backend/` + `shared/` is first-party code written by the author and is **trusted**.
- **No untrusted input** reaches the gate logic in this sub-project. The provider is a deterministic mock; no end-user-supplied code is executed (the `TestRunner` is a no-op digest, not a real executor yet).
- **Attacker NOT in scope (this sub-project):** a malicious or buggy *first-party module* that deliberately edits the source tree or calls internal capabilities. A `git push` re-opens that surface regardless; defending it requires a real trust boundary (below), deliberately deferred.

## What the gates guarantee STRUCTURALLY (enforced by construction, tested)

1. **No literal/accidental forgery of a gate token.** `VerifyToken`, `ApprovalToken` (in `@akis/shared`) and `ApprovedPush`, `TestRunResult` (backend) are **nominal `unique symbol` brands**. A token cannot be written as an object literal nor satisfied with `as T` — proven by `@ts-expect-error` tripwires in `backend/test/unit/gates.test.ts` that fail to compile if a brand is weakened.
2. **The minting capabilities are not importable.** `mintVerifyToken`, the mock-runner class, and the approval brand are **module-private**; the only public surfaces are the `Verifier` (`createVerifier`) and `ApprovalAuthority` (`createApprovalAuthority`) capabilities, vended by the DI container. A forging `import` is a **compile error (TS2305)** — asserted by tripwires in `gates.test.ts`. This is the conversion of "convention" into "construction" within one realm.
3. **Verification is bound to a real run and to the tested code.** A `VerifyToken` is produced only by the `Verifier`, only when the `TestRunner` reported **≥1 executed + passing** test (fail-closed: 0 tests or a failing run → no token). The token carries a **runner-computed digest** of the files actually tested; `mintApprovedPush` requires the pushed files to match that digest (verified-code = pushed-code). Digests are length-prefixed (collision-resistant).
4. **Producer ≠ verifier (by capability).** Only the `trace` (verifier) role is given a `Verifier` in the DI container; producers (`scribe`, `proto`) receive none. Verification is the **presence of a persisted `VerifyToken`** (read via `isVerified`), never a free boolean or a bus event — a forged `verify` event is ignored.
5. **Spec-approval and push are structural.** Code-write (`ProtoAgent.run`) requires an `ApprovedSpec`, mintable only from a session whose `approval` token (set only via `store.recordApproval`, from the orchestrator's `ApprovalAuthority`) is **bound to the session's reviewed spec** (spec-substitution rejected). Push requires an `ApprovedPush`, mintable only from a session's `VerifyToken`. The store's generic `update` patch **omits** `approval` and `verifyToken`, so neither gate field can be set through the ordinary mutation path (asserted at the type level).

All five are covered by the contract test (`backend/test/contract/agentic-gates.contract.test.ts`) which drives the **real** orchestrator and tries to break each gate, plus the unit tripwires. `npm test` runs `tsc --noEmit && vitest run`, so the compile-time guarantees are part of the suite (not silently skipped).

## What the gates do NOT guarantee (the honest boundary)

- **In a single process, a first-party module can still reach a capability it is handed (or call `createVerifier`/`createApprovalAuthority` itself).** TypeScript cannot prevent same-realm code from constructing a verifier with a fake-passing mock runner. In the mock, "passing" is configured; with a **real** `TestRunner` the only way to get `passed:true` is to actually run passing tests, which shrinks this to "a first-party author edits the tree" — out of scope here.
- **No confidentiality / no defense against a hostile in-tree author.** The brands give **integrity** (no forgery-by-accident, no tamper, no literal), not confidentiality against a collaborator in the same realm.

## The real trust boundary (deferred, named)

> *In a single process the verification gates guarantee **integrity, not confidentiality**: a `VerifyToken` / `TestRunResult` / `ApprovalToken` / `ApprovedPush` cannot be forged by a literal, by `as T`, or by a fabricated object, and the verifier/approval capabilities are not importable — but they do not defend against a malicious or edited first-party module in the same OS process. Closing that requires a real trust boundary (separate verifier process + results signed with an externally-held Ed25519 key), deliberately deferred to the sub-project that introduces **sandboxed execution of untrusted AI-generated code** — the same boundary that work requires regardless.*

When `TestRunner.run()` stops being a digest and actually executes AI-generated code, that code is **untrusted** and must run in a real isolate (microVM / Firecracker / gVisor — not `worker_threads`, `node:vm`, or a container, which are not security boundaries). The verifier moves into that isolate and **signs** its result; the orchestrator then can only *trust* (verify a signature with a public key), never *mint*. The branded-token design is already the seam: `Verifier.verify(sessionId, files) → VerifyToken | null` becomes an async RPC + signature-verify with no change to its callers.
