import type { SpecArtifact } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import type { BddStats, BddScenario } from '../bdd/messageStats.js'
import type { E2eStats, E2eScenario } from '../e2e/playwrightStats.js'
import { detectAppType } from '../preview/AppDetector.js'
import { deriveChecks, type Check } from './criteria.js'
import type { RealRunResult } from './realRun.js'

const EMPTY_BDD: BddStats = { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }

/** Result of trying to boot the produced app: either a probe-able URL + a teardown
 *  hook, or a bounded failure reason (we never run probes against a boot we couldn't get). */
export type BootResult = { url: string; teardown: () => Promise<void> } | { failed: string }

/** Minimal HTTP probe result — only what a mechanical check asserts on. */
export interface ProbeResponse { status: number; body: string }

/**
 * Injected dependencies for {@link runBootSmoke}. Everything that touches the world (booting
 * the app, fetching URLs) is a dep so the runner is pure-logic + unit-testable with fakes:
 *  - `boot`      : materialize + start the produced app, returning a local URL + teardown.
 *  - `spec`      : optional — its acceptance criteria add mechanical probes (deriveChecks).
 *  - `fetchImpl` : optional — GET a URL → {status, body}; defaults to a real node fetch.
 *  - `timeoutMs` : whole-run budget (default 120_000) — exceed → fail-closed (passed:false).
 *  - `sessionId` : threaded into `boot` so the adapter can isolate this verify boot.
 */
export interface BootSmokeDeps {
  boot: (sessionId: string, files: RepoFile[]) => Promise<BootResult>
  spec?: SpecArtifact
  fetchImpl?: (url: string) => Promise<ProbeResponse>
  timeoutMs?: number
  sessionId: string
}

// 180s (was 120): the budget covers INSTALL + boot + probes, and a cold `npm install` for a
// vite/node-service app alone can take 60–100s (PR #96 review) — 120s raced it and could fail
// a healthy build as a timeout. Static apps don't install and finish in milliseconds anyway.
const DEFAULT_TIMEOUT_MS = 180_000

/** Bound a probe NAME for the structured evidence (mirrors the 60-char scenario-name bound). */
function boundName(s: string): string {
  return s.trim().slice(0, 60)
}

/** Default probe: a real node fetch of a fully-qualified URL → {status, body}. A network error
 *  surfaces as status 0 + empty body, so the asserting check fails CLOSED (never a vacuous pass). */
const defaultFetch = async (url: string): Promise<ProbeResponse> => {
  try {
    const res = await fetch(url)
    return { status: res.status, body: await res.text() }
  } catch {
    return { status: 0, body: '' }
  }
}

/** Join a booted base URL with a check path without doubling the slash. */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`)
}

/** Local-asset references in index.html (src/href to ./x, /x or x — never http(s)/protocol-
 *  relative/data/anchor/mailto). Case-insensitive (PR #100 review): uppercase `SRC=` is valid
 *  HTML, and missing it would let a broken reference escape verification (fail-closed broken). */
const LOCAL_REF = /(?:src|href)\s*=\s*["'](?!https?:|\/\/|data:|#|mailto:)\.?\/?([A-Za-z0-9_\-./]+)["']/gi

/**
 * Derive one probe per LOCAL asset index.html references (Phase E): a multi-file app whose
 * `<script src="./app.js">` points at a file Proto never emitted serves a 200 page that renders
 * BLANK — the smoke probe alone would over-claim "verified". Probing every referenced asset makes
 * a broken reference an honest 404 failure. Pure (string scan), bounded to 20 assets.
 */
export function deriveAssetChecks(files: RepoFile[]): Check[] {
  const index = files.find(f => f.filePath === 'index.html' || f.filePath.endsWith('/index.html'))
  if (!index) return []
  const seen = new Set<string>()
  const checks: Check[] = []
  for (const m of index.content.matchAll(LOCAL_REF)) {
    const path = `/${m[1]!}`
    if (seen.has(path) || checks.length >= 20) continue
    seen.add(path)
    checks.push({ kind: 'pathStatus', name: `asset ${path}`.slice(0, 60), path })
  }
  return checks
}

/**
 * Run a check against the booted app and report a structured pass/fail (NEVER prose). The
 * assertion per kind:
 *   - smoke/render → status < 400 AND a non-empty body (the page actually rendered)
 *   - bodyContains → status < 400 AND the body contains the literal
 *   - pathStatus   → status < 400 (the route exists and answers)
 * 4xx FAILS (PR #94 review): a node-service with no `/` route 404s with a non-empty error
 * body — under a <500 rule that would smoke-"pass" an app whose front door doesn't exist,
 * and "verified" must never over-claim. 3xx is fine (a redirecting app is serving).
 * A failure records a bounded outcome label only (status / 'empty body' / 'missing literal').
 */
async function probe(check: Check, baseUrl: string, fetchImpl: (url: string) => Promise<ProbeResponse>): Promise<E2eScenario> {
  const name = boundName(check.name)
  // A skipped check makes NO request — it is recorded as a skipped (non-pass, non-fail) scenario.
  if (check.kind === 'skipped') return { name, passed: false, outcome: 'skipped' }

  const path = check.kind === 'bodyContains' || check.kind === 'render' || check.kind === 'pathStatus' ? check.path : '/'
  const res = await fetchImpl(joinUrl(baseUrl, path))
  if (res.status >= 400 || res.status === 0) return { name, passed: false, outcome: `status ${res.status}` }
  if ((check.kind === 'render') && res.body.length === 0) return { name, passed: false, outcome: 'empty body' }
  if (check.kind === 'bodyContains' && !res.body.includes(check.literal)) return { name, passed: false, outcome: 'missing literal' }
  return { name, passed: true }
}

/** Build a {@link RealRunResult} from booted-app probe outcomes — the SAME shape realRun.ts
 *  emits, so the trusted parent (createBootSmokeRunner) can brand it through the EXISTING path
 *  (buildTestEvidence → digestEvidence → brandResult) with no new minting surface. Probes are
 *  E2E-flavored (they exercise the running app over HTTP), so they populate the e2e half; BDD
 *  stays empty here. `skipped` checks count as skipped, NOT as run tests. */
function resultFromProbes(scenarios: E2eScenario[]): RealRunResult {
  // A skipped check never counts as run (probe() only ever emits 'skipped' with passed:false).
  const ran = scenarios.filter(s => s.outcome !== 'skipped')
  const expected = ran.filter(s => s.passed).length
  const unexpected = ran.filter(s => !s.passed).length
  const skipped = scenarios.length - ran.length
  const e2e: E2eStats = {
    testsRun: ran.length,
    passed: unexpected === 0 && expected >= 1,
    expected,
    unexpected,
    flaky: 0,
    skipped,
    durationMs: 0,
  }
  // Mirror realRun.ts's gate exactly: ≥1 test, zero failures. The smoke floor guarantees
  // testsRun ≥ 1, so a probe-less spec still yields a genuine 1-test outcome (never 0).
  const passed = e2e.testsRun >= 1 && unexpected === 0
  return { testsRun: e2e.testsRun, passed, bdd: EMPTY_BDD, e2e, bddScenarios: [], e2eScenarios: scenarios }
}

/** A fail-closed result with NO tests run + a bounded top-level reason (surfaced via the
 *  e2eScenarios so the structured failure report carries it). passed:false + testsRun:0 ⇒
 *  it can NEVER mint a VerifyToken (verifier.ts/mint requires testsRun ≥ 1 && passed). */
function failClosed(reason: string): RealRunResult {
  return {
    testsRun: 0,
    passed: false,
    bdd: EMPTY_BDD,
    e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
    bddScenarios: [] as BddScenario[],
    e2eScenarios: [{ name: 'boot smoke', passed: false, outcome: boundName(reason) }],
  }
}

/**
 * Boot-smoke verification: BOOT the produced app, then probe the RUNNING server over HTTP —
 * an always-on smoke probe (GET / → status < 500 + non-empty body) PLUS one probe per derivable
 * acceptance criterion (deriveChecks). Returns the SAME {@link RealRunResult} shape realRun.ts
 * produces, so the trusted parent brands it through the existing buildTestEvidence path.
 *
 * FAIL-CLOSED throughout (so a non-genuine run can NEVER mint a VerifyToken — the SACRED rule):
 *   - unsupported app type  → testsRun:0, passed:false, bounded reason (no boot attempted).
 *   - boot failure          → testsRun:0, passed:false, bounded reason.
 *   - whole run > timeoutMs  → testsRun:0, passed:false (a slow/hung boot can't sneak a pass).
 *   - any probe fails / 5xx  → that scenario is `unexpected`, so passed:false.
 * The always-on smoke probe is the testsRun ≥ 1 FLOOR: even a criterion-less spec runs exactly
 * one genuine probe, so a pass means the app really booted and served `/`.
 *
 * Teardown ALWAYS runs in `finally` once boot SUCCEEDED (even if a probe throws or we time out),
 * so a verify boot never leaks a process/workspace. A FAILED boot returns no teardown to call.
 */
export async function runBootSmoke(files: RepoFile[], deps: BootSmokeDeps): Promise<RealRunResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = deps.fetchImpl ?? defaultFetch

  // Pre-boot gate: an app type we don't run locally yet can't be booted → fail-closed, no boot.
  if (detectAppType(files) === 'unsupported') {
    return failClosed('app type unsupported — cannot boot to verify')
  }

  // Bound the WHOLE run (boot + every probe) by timeoutMs. On exceed we resolve fail-closed and
  // still run teardown (below) — a hung boot must never wedge the verifier nor mint a token.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<RealRunResult>(resolve => {
    timer = setTimeout(() => resolve(failClosed(`boot-smoke timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  // `teardown` is captured the moment boot SUCCEEDS, so even if the deadline wins the race (the
  // probes are still in flight) we can still tear the booted app down. The `finally` AWAITS the
  // work promise to settle first, guaranteeing a successful boot's teardown always runs.
  let teardown: (() => Promise<void>) | undefined
  const work = (async (): Promise<RealRunResult> => {
    const boot = await deps.boot(deps.sessionId, files)
    if ('failed' in boot) return failClosed(`boot failed — ${boot.failed}`)
    teardown = boot.teardown

    // (a) ALWAYS a smoke probe (the testsRun ≥ 1 floor) + (b) one probe per LOCAL asset
    // index.html references (Phase E: a missing ./app.js renders a blank page the smoke
    // probe alone would over-claim) + (c) one probe per derived acceptance criterion.
    const checks: Check[] = [
      { kind: 'render', name: 'app boots and serves /', path: '/' },
      ...deriveAssetChecks(files),
      ...deriveChecks(deps.spec),
    ]
    const scenarios: E2eScenario[] = []
    for (const c of checks) scenarios.push(await probe(c, boot.url, fetchImpl))
    return resultFromProbes(scenarios)
  })()
  // Never leak an unhandled rejection if the deadline wins the race and `work` later throws.
  const settled = work.catch((e: unknown) =>
    // A boot/probe that THREW (not a clean failure) is still fail-closed with a bounded reason.
    failClosed(`boot-smoke errored — ${String(e instanceof Error ? e.message : e).slice(0, 200)}`),
  )

  try {
    return await Promise.race([settled, deadline])
  } finally {
    if (timer) clearTimeout(timer)
    // A successful boot's teardown must ALWAYS run — but a boot that NEVER settles must not
    // wedge the verifier in this finally (PR #94 review: the deadline already resolved the
    // race fail-closed; awaiting `settled` unconditionally would hang forever on a hung boot).
    // Give the work a SHORT grace (250ms — final review: 1s added avoidable wall-clock to every
    // fail-closed timeout response) to settle; if still pending, attach the teardown as a
    // continuation so the straggler is torn down WHENEVER it finally boots, and return now.
    let grace: ReturnType<typeof setTimeout> | undefined
    const settledInTime = await Promise.race([
      settled.then(() => true as const),
      new Promise<false>(resolve => { grace = setTimeout(() => resolve(false), 250) }),
    ])
    if (grace) clearTimeout(grace)
    if (settledInTime) {
      if (teardown) await teardown().catch(() => {})
    } else {
      void settled.then(() => teardown?.().catch(() => {}))
    }
  }
}
