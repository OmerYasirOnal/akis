import type { SpecArtifact } from '@akis/shared'
import { parseScenarios } from '../bdd/featureGen.js'

/**
 * A MECHANICAL check derived from one acceptance criterion — the boot-smoke runner
 * (bootSmoke.ts) turns each into an HTTP probe against the BOOTED preview. These are
 * deliberately tiny + deterministic (a status assertion, a substring match), NEVER an
 * LLM judgement, so the only way a probe "passes" is the real running app answering
 * as asserted. A criterion we cannot reduce to such a check becomes a `skipped` entry
 * (with a bounded reason) rather than a silent drop or a vacuous pass.
 *
 * NOTE on the seam: deriving checks is PURELY UPSTREAM of the fail-closed mint. It only
 * decides WHICH probes to run; whether the run passes (and so whether a VerifyToken can
 * mint) is still owned by the runner's ≥1-test-pass accounting + verifier.ts/mint. A
 * mis-derived or empty check set can never relax the gate — at worst it runs only the
 * always-on smoke probe (see bootSmoke.ts), never zero probes.
 */
export type Check =
  /** GET `path` and assert status < 500 AND a non-empty body (the page actually renders). */
  | { kind: 'render'; name: string; path: string }
  /** GET `path` and assert the response body CONTAINS the literal string. */
  | { kind: 'bodyContains'; name: string; path: string; literal: string }
  /** GET the explicit `path` and assert status < 500 (the route exists / doesn't 5xx). */
  | { kind: 'pathStatus'; name: string; path: string }
  /** No mechanical check derivable — recorded as a bounded `skipped` scenario, never a pass. */
  | { kind: 'skipped'; name: string; reason: string }

/** Bound a derived check NAME so the structured evidence stays compact (mirrors the 60-char
 *  scenario-name bound the BDD parser uses) and never carries a long free-form criterion. */
function boundName(s: string): string {
  return s.trim().slice(0, 60)
}

/** Mentions of the home page rendering/loading/showing → a render probe against `/`. */
const RENDER = /\b(renders?|loads?|displays?|shows?|opens?|appears?)\b/i
/** A double- or single-quoted literal the rendered body should contain. */
const QUOTED = /["“”']([^"“”']{1,80})["“”']/
/** An explicit URL path (e.g. `/about`, `/api/todos`). The first segment char must be
 *  alphanumeric so a bare `/`, a `//`-comment marker, or stray slash-runs never parse as a
 *  "path" (PR #94 review). Trailing punctuation is trimmed below. */
const PATH = /(?:^|\s)(\/[A-Za-z0-9][A-Za-z0-9_\-./]*)/

/**
 * Derive the mechanical boot-smoke checks for a spec's acceptance criteria. PURE
 * (spec → Check[]); no I/O. One Check per parsed criterion, mapped by this PRIORITY:
 *   1. quotes a literal string  → assert the body contains that literal
 *   2. names an explicit /path  → GET that path, assert status < 500
 *   3. mentions render/load/show → GET `/`, assert status < 500 + non-empty body
 *   4. anything else            → a `skipped` check ('no mechanical check derivable')
 *
 * A literal/path is the most specific signal, so it wins over the generic "renders" verb
 * (a criterion is usually about ONE observable fact). An empty / criterion-less spec yields
 * an empty list — the runner ALWAYS adds its own smoke probe on top, so testsRun ≥ 1 holds
 * regardless (the floor lives in bootSmoke.ts, not here).
 */
export function deriveChecks(spec: SpecArtifact | undefined): Check[] {
  if (!spec) return []
  return parseScenarios(spec.body).map(sc => {
    // The full criterion text = its joined steps (the Given/When/Then), which carries the
    // literal/path/verb signal more reliably than the truncated scenario name alone.
    const text = sc.steps.join(' ')
    const name = boundName(sc.name || text)

    const quoted = QUOTED.exec(text)
    if (quoted?.[1]) return { kind: 'bodyContains', name, path: '/', literal: quoted[1] }

    const path = explicitPath(text)
    if (path) return { kind: 'pathStatus', name, path }

    if (RENDER.test(text)) return { kind: 'render', name, path: '/' }

    return { kind: 'skipped', name, reason: 'no mechanical check derivable' }
  })
}

/** Extract the first explicit URL path, trimming trailing sentence punctuation (e.g. `/about.`
 *  → `/about`). `/` alone is NOT an "explicit path" — that is the home-page render case. */
function explicitPath(text: string): string | undefined {
  const m = PATH.exec(text)
  const raw = m?.[1]?.replace(/[.,;:!?)]+$/, '')
  if (!raw || raw === '/') return undefined
  return raw
}
