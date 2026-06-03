/**
 * VerifyToken type re-export. The MINT lives in `verifier.ts` and is
 * module-private — there is no exported bare `mintVerifyToken`, so a forging
 * `import` is a compile error. A VerifyToken can only be obtained by holding a
 * `Verifier` (built ONLY via `resolveVerifier`; `createVerifier` is module-private
 * — B2) and running a real test pass through it.
 */
export type { VerifyToken } from '@akis/shared'
