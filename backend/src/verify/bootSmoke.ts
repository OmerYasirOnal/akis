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

/** Optional request shape for a probe (the round-trip check needs POST + a JSON body). Absent ⇒
 *  a plain GET, so every existing GET-only fetchImpl + fake stays source-compatible. */
export interface ProbeInit { method?: string; body?: string; headers?: Record<string, string> }

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
  fetchImpl?: (url: string, init?: ProbeInit) => Promise<ProbeResponse>
  timeoutMs?: number
  sessionId: string
  /** Opt-in (AKIS_ROUNDTRIP_VERIFY): also run a BEHAVIORAL round-trip probe on a writable API path
   *  of a node-service app (POST a marker → GET → assert it persisted). Default OFF, so the boot is
   *  byte-identical to the GET-only smoke run unless explicitly enabled. */
  roundTrip?: boolean
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
const defaultFetch = async (url: string, init?: ProbeInit): Promise<ProbeResponse> => {
  try {
    const reqInit: RequestInit = {}
    if (init?.method) reqInit.method = init.method
    if (init?.body !== undefined) reqInit.body = init.body
    if (init?.headers) reqInit.headers = init.headers
    const res = await fetch(url, reqInit)
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
 * Derive a BEHAVIORAL round-trip check per distinct writable `/api/...` path the spec names —
 * gated by the caller to node-service apps (the writable-backend shape) and the AKIS_ROUNDTRIP_VERIFY
 * flag. Pure (string scan), deduped, bounded to 5. No `/api` path named ⇒ no round-trip check (the
 * GET probes still run) — conservative by construction.
 */
/**
 * Derive an AUTH-GUARD check per spec line that EXPLICITLY describes a protected endpoint — i.e. an
 * unauthenticated-context signal (`without logging in / a session / a token`, `unauthenticated`,
 * `requires login`, `401`, `403`, `unauthorized`) AND an explicit path on the SAME line. Gated by the
 * caller to node-service + the flag. NARROW by design: no loose inference, so a non-auth scenario
 * never becomes a 401 probe. Pure (line scan), deduped, bounded to 5.
 */
// MUST stay ⊇-consistent with criteria.ts AUTH_SIGNAL: an auth criterion is SKIPPED there (no
// pathStatus) and probed HERE (expect 401/403). Strong phrases only (no bare 401/403/unauthorized —
// those appear as page copy, e.g. a "403 Forbidden" heading, and must keep ordinary coverage).
const UNAUTH_SIGNAL = /\b(without\s+(?:logging\s+in|signing\s+in|a\s+session|auth(?:entication)?|a\s+token|credentials)|unauthenticated|not\s+(?:logged|signed)\s+in|anonymous(?:ly)?|requires?\s+(?:login|sign[\s-]?in|auth(?:entication)?|a\s+session))\b/i
const LINE_PATH = /(\/[A-Za-z0-9][A-Za-z0-9_\-./]*)/
export function deriveAuthChecks(spec: SpecArtifact | undefined): Check[] {
  if (!spec) return []
  const seen = new Set<string>()
  const checks: Check[] = []
  for (const line of spec.body.split('\n')) {
    if (!UNAUTH_SIGNAL.test(line)) continue
    const m = LINE_PATH.exec(line)
    const path = m?.[1]?.replace(/[.,;:!?)`'"]+$/, '')
    if (!path || path === '/' || seen.has(path) || checks.length >= 5) continue
    seen.add(path)
    checks.push({ kind: 'authRequired', name: `auth-guard ${path}`.slice(0, 60), path })
  }
  return checks
}

const API_PATH = /\/api\/[A-Za-z0-9][A-Za-z0-9_\-./]*/g
export function deriveRoundTripChecks(spec: SpecArtifact | undefined): Check[] {
  if (!spec) return []
  const seen = new Set<string>()
  const checks: Check[] = []
  for (const m of spec.body.matchAll(API_PATH)) {
    const path = m[0].replace(/[.,;:!?)]+$/, '')
    if (seen.has(path) || checks.length >= 5) continue
    seen.add(path)
    checks.push({ kind: 'roundTrip', name: `round-trip ${path}`.slice(0, 60), path })
  }
  return checks
}

/**
 * BEHAVIORAL round-trip probe (catches the "Potemkin backend"): GET a baseline, POST a unique
 * marker (shotgunned across common field names so SOME schema accepts it), GET again — PASS only
 * if the write PERSISTED (the marker appears OR the body grew). CONSERVATIVE to never false-RED a
 * healthy app: if the POST is not 2xx (we couldn't establish a valid write) it records `skipped`,
 * not a fail. A real ≥1-test PASS via this probe means the app actually stored + served back data.
 */
async function probeRoundTrip(check: Extract<Check, { kind: 'roundTrip' }>, baseUrl: string, fetchImpl: (url: string, init?: ProbeInit) => Promise<ProbeResponse>): Promise<E2eScenario> {
  const name = boundName(check.name)
  const url = joinUrl(baseUrl, check.path)
  const marker = `akis-rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const pre = await fetchImpl(url)
  const payload = JSON.stringify(Object.fromEntries(
    ['title', 'text', 'name', 'content', 'value', 'todo', 'task', 'note', 'body', 'description'].map(k => [k, marker]),
  ))
  const post = await fetchImpl(url, { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } })
  // Couldn't establish a valid write (strict schema 400 / method not allowed / server hiccup on our
  // synthetic body) ⇒ SKIP, never a fail — a healthy app must not be punished for our blind payload.
  if (post.status < 200 || post.status >= 300) return { name, passed: false, outcome: 'skipped' }
  const after = await fetchImpl(url)
  if (after.status >= 400 || after.status === 0 || after.status === 304) return { name, passed: false, outcome: `read ${after.status}` }
  const persisted = after.body.includes(marker) || after.body.length > pre.body.length
  return persisted ? { name, passed: true } : { name, passed: false, outcome: 'not persisted' }
}

/**
 * Run a check against the booted app and report a structured pass/fail (NEVER prose). The
 * assertion per kind:
 *   - smoke/render → status < 400 AND a non-empty body (the page actually rendered)
 *   - bodyContains → status < 400 AND the body contains the literal
 *   - pathStatus   → status < 400 (the route exists and answers)
 *   - roundTrip    → POST a marker then GET it back; pass only if it persisted (see probeRoundTrip)
 * 4xx FAILS (PR #94 review): a node-service with no `/` route 404s with a non-empty error
 * body — under a <500 rule that would smoke-"pass" an app whose front door doesn't exist,
 * and "verified" must never over-claim. 3xx is fine (a redirecting app is serving).
 * A failure records a bounded outcome label only (status / 'empty body' / 'missing literal').
 */
async function probe(check: Check, baseUrl: string, fetchImpl: (url: string, init?: ProbeInit) => Promise<ProbeResponse>): Promise<E2eScenario> {
  const name = boundName(check.name)
  // A skipped check makes NO request — it is recorded as a skipped (non-pass, non-fail) scenario.
  if (check.kind === 'skipped') return { name, passed: false, outcome: 'skipped' }
  if (check.kind === 'roundTrip') return probeRoundTrip(check, baseUrl, fetchImpl)
  if (check.kind === 'authRequired') {
    // GET the protected path with NO cookie (probes never carry one). 401/403 ⇒ guarded (pass);
    // a 2xx ⇒ the guard is MISSING (a real gap → fail); anything else ⇒ skipped (can't establish).
    const res = await fetchImpl(joinUrl(baseUrl, check.path))
    if (res.status === 401 || res.status === 403) return { name, passed: true }
    if (res.status >= 200 && res.status < 300) return { name, passed: false, outcome: `unguarded ${res.status}` }
    return { name, passed: false, outcome: 'skipped' }
  }

  const path = check.kind === 'bodyContains' || check.kind === 'render' || check.kind === 'pathStatus' ? check.path : '/'
  const res = await fetchImpl(joinUrl(baseUrl, path))
  // 304 also FAILS (final review): our probes send NO conditional headers, so a spec-compliant
  // server can never answer 304 — one that does is broken, and it carries no body to verify.
  if (res.status >= 400 || res.status === 0 || res.status === 304) return { name, passed: false, outcome: `status ${res.status}` }
  if ((check.kind === 'render') && res.body.length === 0) return { name, passed: false, outcome: 'empty body' }
  if (check.kind === 'bodyContains' && !res.body.includes(check.literal)) return { name, passed: false, outcome: 'missing literal' }
  return { name, passed: true }
}

/** Build a {@link RealRunResult} from booted-app probe outcomes — the SAME shape realRun.ts
 *  emits, so the trusted parent (createBootSmokeRunner) can brand it through the EXISTING path
 *  (buildTestEvidence → digestEvidence → brandResult) with no new minting surface. Probes are
 *  E2E-flavored (they exercise the running app over HTTP), so they populate the e2e half; BDD
 *  stays empty here. `skipped` checks count as skipped, NOT as run tests. */
function resultFromProbes(scenarios: E2eScenario[], durationMs = 0): RealRunResult {
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
    // Real wall-time of the probe run (was hardcoded 0 → the UI showed "0ms" for genuine tests).
    durationMs,
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
    const appType = detectAppType(files)
    // SPA (vite/next) served HTML is a JS SHELL: a spec literal is rendered CLIENT-side by JS that
    // the boot-smoke fetch never executes, so a bodyContains-against-`/` probe would FALSE-RED a
    // perfectly healthy app and the build could NEVER verify. Downgrade those to a render check
    // (boots + serves `/`) — the honest mechanical floor for an SPA without a browser. A literal on
    // an explicit non-`/` API path is left intact (a server response, not the JS shell). (Audit #4.)
    const isSpa = appType === 'vite' || appType === 'next'
    const specChecks = deriveChecks(deps.spec).map(c =>
      isSpa && c.kind === 'bodyContains' && c.path === '/' ? { kind: 'render' as const, name: c.name, path: c.path } : c)
    const checks: Check[] = [
      { kind: 'render', name: 'app boots and serves /', path: '/' },
      ...deriveAssetChecks(files),
      ...specChecks,
      // OPT-IN behavioral round-trip — ONLY for a node-service (writable backend) when enabled.
      // Additive: a pass adds a genuinely-behavioral test; a fail is a real Potemkin; a non-2xx
      // POST self-skips. Default OFF ⇒ the check set is byte-identical to before.
      ...(deps.roundTrip && appType === 'node-service' ? deriveRoundTripChecks(deps.spec) : []),
      // OPT-IN auth-guard checks (same flag + node-service gate): a 401/403-without-cookie probe for
      // any endpoint the spec EXPLICITLY says is protected. Conservative derivation → rarely fires,
      // never false-REDs a healthy app (a 2xx is a genuine missing-guard failure; else self-skips).
      ...(deps.roundTrip && appType === 'node-service' ? deriveAuthChecks(deps.spec) : []),
    ]
    const scenarios: E2eScenario[] = []
    const probesStartedAt = Date.now()
    for (const c of checks) scenarios.push(await probe(c, boot.url, fetchImpl))
    return resultFromProbes(scenarios, Date.now() - probesStartedAt)
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
