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
2. **The minting capabilities are not importable.** `mintVerifyToken`, the mock-runner class, the approval brand, **and the `Verifier` constructor (`createVerifier`)** are **module-private**. The only public Verifier surface is `resolveVerifier(spec)` (a *declarative* runner selection — mock-with-config / real-with-sandbox / the DI-owned injected runner), built inside `verifier.ts` from the trusted `TestRunner` factories; `ApprovalAuthority` is similarly vended via `createApprovalAuthority`. **B2:** previously `createVerifier(runner)` was exported, so an in-realm caller could wrap an arbitrary fake-passing runner into a Verifier — that admittance is now removed (no `createVerifier` to import; a forging `import` is a **compile error, TS2305**), asserted by `backend/test/unit/verifier-capability.test.ts` + `gates.test.ts`. This is the conversion of "convention" into "construction" within one realm.
3. **Verification is bound to a real run and to the tested code.** A `VerifyToken` is produced only by the `Verifier`, only when the `TestRunner` reported **≥1 executed + passing** test (fail-closed: 0 tests or a failing run → no token). The token carries a **runner-computed digest** of the files actually tested; `mintApprovedPush` requires the pushed files to match that digest (verified-code = pushed-code). Digests are length-prefixed (collision-resistant).
4. **Producer ≠ verifier (by capability).** Only the `trace` (verifier) role is given a `Verifier` in the DI container; producers (`scribe`, `proto`) receive none. Verification is the **presence of a persisted `VerifyToken`** (read via `isVerified`), never a free boolean or a bus event — a forged `verify` event is ignored.
5. **Spec-approval and push are structural.** Code-write (`ProtoAgent.run`) requires an `ApprovedSpec`, mintable only from a session whose `approval` token (set only via `store.recordApproval`, from the orchestrator's `ApprovalAuthority`) is **bound to the session's reviewed spec** (spec-substitution rejected). Push requires an `ApprovedPush`, mintable only from a session's `VerifyToken`. The store's generic `update` patch **omits** `approval` and `verifyToken`, so neither gate field can be set through the ordinary mutation path (asserted at the type level).

All five are covered by the contract test (`backend/test/contract/agentic-gates.contract.test.ts`) which drives the **real** orchestrator and tries to break each gate, plus the unit tripwires. `npm test` runs `tsc --noEmit && vitest run`, so the compile-time guarantees are part of the suite (not silently skipped).

## What the gates do NOT guarantee (the honest boundary)

- **In a single process, a first-party module can still reach a capability it is handed.** `createVerifier` is no longer importable (B2), and `resolveVerifier` only builds a runner via the trusted factories — so a caller can no longer hand the verifier a *bespoke* fake runner object. But a first-party module can still select the mock runner (`resolveVerifier({kind:'mock',cfg:{passed:true}})`, mirroring the still-needed keyless dev/demo path) or edit the tree outright. In the mock, "passing" is configured; with a **real** `TestRunner` the only way to get `passed:true` is to actually run passing tests. A demo boot that fakes verification is now **fail-closed in production** and surfaced as `mode:'demo'` on `/health` (B1), so it can never silently masquerade as live. Fully closing the in-realm gap (a malicious/edited first-party module) still requires the separate-process signed verifier below — deliberately deferred.
- **No confidentiality / no defense against a hostile in-tree author.** The brands give **integrity** (no forgery-by-accident, no tamper, no literal), not confidentiality against a collaborator in the same realm.

## The real trust boundary (deferred, named)

> *In a single process the verification gates guarantee **integrity, not confidentiality**: a `VerifyToken` / `TestRunResult` / `ApprovalToken` / `ApprovedPush` cannot be forged by a literal, by `as T`, or by a fabricated object, and the verifier/approval capabilities are not importable — but they do not defend against a malicious or edited first-party module in the same OS process. Closing that requires a real trust boundary (separate verifier process + results signed with an externally-held Ed25519 key), deliberately deferred to the sub-project that introduces **sandboxed execution of untrusted AI-generated code** — the same boundary that work requires regardless.*

When `TestRunner.run()` stops being a digest and actually executes AI-generated code, that code is **untrusted** and must run in a real isolate (microVM / Firecracker / gVisor — not `worker_threads`, `node:vm`, or a container, which are not security boundaries). The verifier moves into that isolate and **signs** its result; the orchestrator then can only *trust* (verify a signature with a public key), never *mint*. The branded-token design is already the seam: `Verifier.verify(sessionId, files) → VerifyToken | null` becomes an async RPC + signature-verify with no change to its callers.

## Provider keys (sub-project #2)

User-supplied LLM API keys are handled with these guarantees:

- **Encrypted at rest** — AES-256-GCM (`backend/src/keys/crypto.ts`), random 12-byte IV per encrypt, a 32-byte master key from `AI_KEY_ENCRYPTION_KEY`. Each ciphertext is bound to its provider via a scoped AAD (`akis:ai-key:<provider>`), so a stored row cannot be replayed under another provider.
- **Never echoed, never logged, never on the bus** — `GET /api/providers` and `KeyStore.status/list` return only `{ configured, last4, updatedAt }`. `PUT` returns `{ last4 }`, never the key. The Fastify logger is disabled so request bodies (which carry the key on PUT) are never logged. Adapters pass auth only via request headers; the shared `http.ts` never logs headers/bodies. Keys never enter `AkisEvent` payloads or error messages (errors reference the provider name only).
- **Plaintext is transient** — it exists in memory only during encrypt (on PUT) and decrypt (right before constructing a provider client).
- **Missing master key** surfaces as a clear `EncryptionNotConfiguredError` (a settings error), not a stack trace; env-only keys do not require the master key.
- **Residual:** a hostile in-tree first-party module in the same process can read decrypted keys in memory (same single-trust-domain limit as the gates). Self-hosted single-user posture accepts this; multi-user/remote would need process isolation + a secrets manager.

## Preview + real-test execution (sub-project #6)

`RealTestRunner` (opt-in) and the live preview run **agent-produced code as child
processes on the host** (local-direct), per the owner's explicit "no microVM,
local, show it nicely" decision. This is **hygiene + blast-radius reduction, NOT a
security boundary.**

- **Mitigations (every OS):** dependency install runs with **lifecycle scripts
  blocked** (`pnpm install --ignore-scripts`); the child env is **scrubbed of AI
  keys + the key-store path** (`scrubEnv` in `exec/Sandbox.ts`; asserted by a test
  that `ANTHROPIC_API_KEY` is absent in the child); each run uses an **ephemeral
  workspace** under `~/.akis/workspaces/<id>-<nonce>/` with path-traversal-safe
  materialization; on timeout the **whole process group is SIGKILLed**.
- **Integrity (unchanged from #1):** the **trusted parent computes the file digest**
  (`createRealTestRunner` → `digestFiles`), never the child; reporter files are read
  **only after the child exits**; the runner is **fail-closed** (timeout / missing
  report / 0 tests → `passed:false`, count zeroed → no `VerifyToken`). The 4 gates,
  the private `TestRunResult` brand, and producer≠verifier wiring are untouched.
- **Residual (stated, accepted for single-user self-host):** every process shares
  the kernel; Node's permission model is not a sandbox; on macOS local mode there is
  effectively no isolation. A passing test in a non-isolated workspace is `verified`
  but **not isolation-grade** until the deferred signed-verifier process lands.
- **Seam kept:** the `Sandbox` interface lets a stronger executor (Docker
  `network=none`/caps-dropped, gVisor, microVM) or a separate signed verifier drop
  in **without touching callers** — exactly the migration path in the section above.
- **Default stays mock:** `createMockTestRunner` remains the default; the real
  runner is opt-in (config + browsers present), so the suite + smoke stay green with
  zero setup and no untrusted code executes by default.
