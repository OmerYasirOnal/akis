import type { SpecArtifact } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import { detectAppType } from '../preview/AppDetector.js'

/**
 * Deterministic "Potemkin backend" guard (caught LIVE on the Phase G voting-app run):
 * the spec demanded user accounts + a real backend, Proto emitted a STATIC app that
 * merely SIMULATES accounts in localStorage — and nothing failed it, because no
 * deterministic check ties the spec's backend requirement to the emission's shape.
 *
 * This is that check: PURE (spec + files → finding or undefined), reused by the
 * orchestrator as a TIGHTEN-ONLY input to the iterate decision — it can only make
 * approval stricter, never bypass anything. The finding text is actionable feedback
 * Proto can fix on the next iteration (it restates rule 3/3b's required shape).
 *
 * Detection is deliberately conservative: only EXPLICIT account/server demands in the
 * spec count (sign up / log in / user accounts / authentication / real backend /
 * server-side / multi-user) — a spec that merely mentions "users" stays static-eligible,
 * so the guard cannot over-block legitimately client-only apps.
 */
const BACKEND_DEMAND = /\b(sign ?-?up|log ?-?in|user accounts?|authentication|real backend|server-?side|multi-?user|per-?user data)\b/i

/** Drop "Out of scope" / "Non-goals" sections before matching: a spec saying
 *  "Out of scope: Authentication" explicitly does NOT demand a backend — matching
 *  inside it false-positived every mock-spec build (caught by the full suite). A
 *  section ends at the next heading or the end of the body. */
function inScopeText(spec: SpecArtifact): string {
  const all = `${spec.title}\n${spec.body}`
  return all.replace(/^#{1,6}\s*(out of scope|non-?goals)\b[\s\S]*?(?=^#{1,6}\s|(?![\s\S]))/gim, '')
}

export function backendRequirementGap(spec: SpecArtifact, files: readonly RepoFile[]): string | undefined {
  if (!BACKEND_DEMAND.test(inScopeText(spec))) return undefined
  if (detectAppType([...files]) !== 'static') return undefined
  return [
    'BACKEND REQUIRED BUT MISSING: the approved spec explicitly requires user accounts /',
    'a real backend, but the emitted app is STATIC (no package.json, no server entry) —',
    'simulating accounts in localStorage does NOT satisfy the spec. Re-emit as a',
    'node-service per rule 3/3b: server.js (Node standard library; node:sqlite for',
    'accounts per rule 3b) + package.json {"main":"server.js"}, listening on',
    'process.env.PORT, serving the client at `/` and the JSON API under `/api/...`.',
  ].join(' ')
}
