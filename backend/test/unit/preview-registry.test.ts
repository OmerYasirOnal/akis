import { describe, it, expect, vi } from 'vitest'
import { installSpec, startSpec } from '../../src/preview/Runner.js'
import { PreviewRegistry, buildLaunchEnv, type Launch, type Probe, type PreviewProc } from '../../src/preview/PreviewRegistry.js'
import type { Sandbox, RunResult } from '../../src/exec/Sandbox.js'

const okSandbox: Sandbox = { async run(): Promise<RunResult> { return { code: 0, stdout: '', stderr: '', timedOut: false } } }
const failSandbox: Sandbox = { async run(): Promise<RunResult> { return { code: 1, stdout: '', stderr: 'boom', timedOut: false } } }

function fakeProc(): PreviewProc & { killed: boolean } {
  const p = { pid: 4242, killed: false, kill() { p.killed = true } }
  return p
}

/** A fake proc that can simulate an early exit + a stderr tail (diagnostics). */
function exitingProc(code: number | null, stderr = ''): PreviewProc & { killed: boolean } {
  let cb: ((c: number | null) => void) | undefined
  const p = {
    pid: 4243, killed: false,
    kill() { p.killed = true },
    stderrTail: () => stderr,
    onExit(fn: (c: number | null) => void) { cb = fn; setTimeout(() => cb?.(code), 1) },
  }
  return p
}

describe('Runner specs', () => {
  it('install blocks lifecycle scripts', () => {
    expect(installSpec().args).toContain('--ignore-scripts')
  })
  it('vite start binds the port on loopback with strictPort', () => {
    const s = startSpec('vite', 5190)!
    expect(s.cmd).toBe('pnpm')
    expect(s.args.join(' ')).toContain('vite --port 5190 --strictPort --host 127.0.0.1')
  })
  it('vite start threads the same-origin --base so assets resolve under /preview/:id/', () => {
    const s = startSpec('vite', 5190, 'sess-abc')!
    expect(s.args.join(' ')).toContain('--base /preview/sess-abc/')
  })
  it('next start runs `next dev` on the loopback port', () => {
    const s = startSpec('next', 7100, 'sess-x')!
    expect(s.cmd).toBe('pnpm')
    expect(s.args.join(' ')).toContain('next dev --port 7100 --hostname 127.0.0.1')
    expect(s.env.NEXT_PUBLIC_BASE_PATH).toBe('/preview/sess-x')
  })
  it('node-service passes PORT via env', () => {
    expect(startSpec('node-service', 7000)!.env.PORT).toBe('7000')
  })
  it('static/unsupported have no start spec (deferred)', () => {
    expect(startSpec('static', 1)).toBeNull()
    expect(startSpec('unsupported', 1)).toBeNull()
  })
})

describe('buildLaunchEnv', () => {
  it('scrubs AI keys/key-store from the preview child env, keeps spec env (no re-leak)', () => {
    process.env.ANTHROPIC_API_KEY = 'leak-me'
    process.env.AI_KEY_STORE_PATH = '/secret'
    try {
      const env = buildLaunchEnv({ cmd: 'node', args: [], env: { PORT: '5000' } })
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.AI_KEY_STORE_PATH).toBeUndefined()
      expect(env.PORT).toBe('5000')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.AI_KEY_STORE_PATH
    }
  })
})

describe('PreviewRegistry lifecycle', () => {
  it('starts → ready with a same-origin url; stop kills the proc', async () => {
    const proc = fakeProc()
    const launch: Launch = () => proc
    const probe: Probe = async () => true
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch, probe })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('ready')
    expect(e.url).toBe('/preview/s1/')
    expect(reg.portFor('s1')).toBe(e.port)
    await reg.stop('s1')
    expect(proc.killed).toBe(true)
    expect(reg.get('s1')?.status).toBe('stopped')
  })

  it('fails (and does not launch) when install fails', async () => {
    const launch = vi.fn<Launch>(() => fakeProc())
    const reg = new PreviewRegistry({ sandbox: failSandbox, commandOnPath: async () => true, launch, probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/install failed/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('runningCount() reflects live child procs (0 for static; increments per launched proc; drops on stop)', async () => {
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true })
    expect(reg.runningCount()).toBe(0)
    await reg.start('s1', '/ws/s1', 'vite')
    expect(reg.runningCount()).toBe(1)
    await reg.start('s2', '/ws/s2', 'vite')
    expect(reg.runningCount()).toBe(2)
    // A static app has NO proc — it does not count as a live preview.
    await reg.start('s3', '/ws/s3', 'static')
    expect(reg.runningCount()).toBe(2)
    await reg.stop('s1')
    expect(reg.runningCount()).toBe(1)
  })

  it('fails and kills the proc when readiness never comes', async () => {
    const proc = fakeProc()
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => proc, probe: async () => false, probeAttempts: 2, probeIntervalMs: 1 })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/readiness probe/)
    expect(proc.killed).toBe(true)
  })

  it('marks unsupported app types without installing', async () => {
    const run = vi.fn(okSandbox.run)
    const reg = new PreviewRegistry({ sandbox: { run }, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'unsupported')
    expect(e.status).toBe('unsupported')
    expect(run).not.toHaveBeenCalled()
  })

  it('serves static apps instantly: ready with NO install, NO launch, served from dir', async () => {
    const run = vi.fn(okSandbox.run)
    const launch = vi.fn<Launch>(() => fakeProc())
    const reg = new PreviewRegistry({ sandbox: { run }, launch, probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'static')
    expect(e.status).toBe('ready')
    expect(e.type).toBe('static')
    expect(e.url).toBe('/preview/s1/')
    expect(e.port).toBeUndefined()
    expect(run).not.toHaveBeenCalled()        // no pnpm install
    expect(launch).not.toHaveBeenCalled()      // no process spawned
    expect(reg.portFor('s1')).toBeUndefined()  // proxy must not treat it as a port
    expect(reg.staticDirFor('s1')).toBe('/ws/s1')
  })

  it('emits status transitions via onStatus', async () => {
    const seen: string[] = []
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true, onStatus: e => seen.push(e.status) })
    await reg.start('s1', '/ws/s1', 'vite')
    expect(seen).toContain('starting')
    expect(seen).toContain('ready')
  })
})

describe('PreviewRegistry.stopAll (graceful shutdown)', () => {
  it('kills every tracked proc, releases ports, and marks each stopped (tolerating errors)', async () => {
    const procs = [fakeProc(), fakeProc()]
    let i = 0
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => procs[i++]!, probe: async () => true })
    const a = await reg.start('a', '/ws/a', 'vite')
    const b = await reg.start('b', '/ws/b', 'vite')
    expect(a.status).toBe('ready'); expect(b.status).toBe('ready')

    await reg.stopAll()
    expect(procs[0]!.killed).toBe(true)
    expect(procs[1]!.killed).toBe(true)
    expect(reg.get('a')?.status).toBe('stopped')
    expect(reg.get('b')?.status).toBe('stopped')
    // Ports released → no longer a live upstream for the proxy.
    expect(reg.portFor('a')).toBeUndefined()
    expect(reg.portFor('b')).toBeUndefined()
  })

  it('tolerates a proc whose kill throws (one bad entry cannot block the rest)', async () => {
    const bad = { pid: 1, killed: false, kill() { throw new Error('kill boom') } } as PreviewProc & { killed: boolean }
    const good = fakeProc()
    let i = 0
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => [bad, good][i++]!, probe: async () => true })
    await reg.start('bad', '/ws/bad', 'vite')
    await reg.start('good', '/ws/good', 'vite')
    await expect(reg.stopAll()).resolves.toBeUndefined()
    expect(good.killed).toBe(true)
  })
})

describe('PreviewRegistry diagnostics (D)', () => {
  it('fails FAST with the exit code + stderr tail when the child exits early (not the whole probe budget)', async () => {
    const reg = new PreviewRegistry({
      sandbox: okSandbox,
      commandOnPath: async () => true,
      launch: () => exitingProc(137, 'Error: Cannot find module react\n    at ...'),
      probe: async () => false, // never ready — must surface the early exit, not "timed out"
      probeAttempts: 50, probeIntervalMs: 5,
    })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/exited early \(code 137\)/)
    expect(e.reason).toMatch(/Cannot find module react/)
  })

  it('attaches the install stderr tail to an install-failed reason', async () => {
    const sb: Sandbox = { async run(): Promise<RunResult> { return { code: 1, stdout: '', stderr: 'ERR_PNPM_NO_MATCHING_VERSION foo@99', timedOut: false } } }
    const reg = new PreviewRegistry({ sandbox: sb, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/install failed \(code 1\)/)
    expect(e.reason).toMatch(/ERR_PNPM_NO_MATCHING_VERSION/)
  })
})

// PR #83 review: the install preflight is an INJECTABLE seam (commandOnPath), so the lifecycle
// stays unit-testable without a real pnpm on the host PATH — and both branches are covered.
describe('PreviewRegistry install preflight (injectable commandOnPath)', () => {
  it('fails with an actionable "enable corepack" hint and does NOT install when the command is missing', async () => {
    const run = vi.fn(okSandbox.run)
    const launch = vi.fn<Launch>(() => fakeProc())
    const reg = new PreviewRegistry({ sandbox: { run }, commandOnPath: async () => false, launch, probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/not found — enable corepack/)
    expect(run).not.toHaveBeenCalled()    // preflight short-circuits BEFORE the install
    expect(launch).not.toHaveBeenCalled()
  })
  it('proceeds to install + ready when the command IS present', async () => {
    const run = vi.fn(okSandbox.run)
    const reg = new PreviewRegistry({ sandbox: { run }, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('ready')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('PreviewRegistry — post-ready crash watch (live-caught stale-ready 502s)', () => {
  /** A proc that supports MULTIPLE onExit listeners (like the real launcher) and can be
   *  crashed ON DEMAND after the registry reports ready. */
  function crashableProc(stderr = 'TypeError: boom') {
    const cbs: ((c: number | null) => void)[] = []
    const p = {
      pid: 4244, killed: false,
      kill() { p.killed = true },
      stderrTail: () => stderr,
      onExit(fn: (c: number | null) => void) { cbs.push(fn) },
      crash(code: number) { for (const cb of cbs) cb(code) },
    }
    return p
  }

  it('a crash AFTER ready flips the entry to failed with the exit code + stderr tail (no more silent 502s)', async () => {
    const proc = crashableProc('Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent')
    const statuses: string[] = []
    const reg = new PreviewRegistry({
      sandbox: okSandbox,
      launch: (() => proc) as Launch,
      probe: (async () => true) as Probe,
      commandOnPath: async () => true,
      probeAttempts: 2, probeIntervalMs: 1,
      onStatus: e => statuses.push(e.status),
    })
    const entry = await reg.start('s-crash', '/tmp/akis-test-crash', 'node-service')
    expect(entry.status).toBe('ready')
    proc.crash(1)
    await new Promise(r => setTimeout(r, 10))
    const after = reg.get('s-crash')!
    expect(after.status).toBe('failed')
    expect(after.reason).toMatch(/crashed after start \(code 1\)/)
    expect(after.reason).toMatch(/ERR_HTTP_HEADERS_SENT/)
    expect(statuses).toContain('failed')
    // The dead port is no longer advertised to the proxy.
    expect(reg.portFor('s-crash')).toBeUndefined()
  })

  it('a stop() BEFORE the exit fires is not overwritten (stale-guard)', async () => {
    const proc = crashableProc()
    const reg = new PreviewRegistry({
      sandbox: okSandbox,
      launch: (() => proc) as Launch,
      probe: (async () => true) as Probe,
      commandOnPath: async () => true,
      probeAttempts: 2, probeIntervalMs: 1,
    })
    await reg.start('s-stop', '/tmp/akis-test-stop', 'node-service')
    await reg.stop('s-stop')
    proc.crash(137) // SIGKILL from stop() surfaces as an exit — must NOT flip stopped → failed
    await new Promise(r => setTimeout(r, 10))
    expect(reg.get('s-stop')!.status).toBe('stopped')
  })
})

describe('PreviewRegistry concurrency cap (audit bigger-bet: heavy previews OOM a small box)', () => {
  const heavyReg = (max: number) => new PreviewRegistry({
    sandbox: okSandbox, commandOnPath: async () => true,
    launch: () => fakeProc(), probe: async () => true, maxConcurrent: max,
  })

  it('an EXPLICIT heavy start at the cap evicts the OLDEST heavy preview (user intent wins)', async () => {
    const reg = heavyReg(1)
    const first = await reg.start('s-old', '/tmp/a', 'vite')
    expect(first.status).toBe('ready')
    const second = await reg.start('s-new', '/tmp/b', 'vite')
    expect(second.status).toBe('ready')
    expect(reg.get('s-old')?.status).toBe('stopped')   // oldest evicted to make room
    expect(reg.atCapacity()).toBe(true)                // exactly one heavy slot, now s-new
  })

  it('STATIC previews never count toward the cap (no process, no memory)', async () => {
    const reg = heavyReg(1)
    await reg.start('s-static', '/tmp/s', 'static')
    const heavy = await reg.start('s-heavy', '/tmp/h', 'vite')
    expect(heavy.status).toBe('ready')
    expect(reg.get('s-static')?.status).toBe('ready')  // untouched — statics are free
  })

  it('VERIFY boots are exempt BOTH ways: never blocked, never evicting (the green gate cannot starve)', async () => {
    const reg = heavyReg(1)
    await reg.start('s-user', '/tmp/u', 'vite')
    const verify = await reg.start('s-user#verify:nonce1', '/tmp/v', 'vite')
    expect(verify.status).toBe('ready')                 // not blocked by the cap
    expect(reg.get('s-user')?.status).toBe('ready')     // and it evicted NOTHING
  })
})

// ── audit P0-2 core — RUN-TOKEN / OWNERSHIP GUARDS for start()'s async phases ──
// Every state write in start()'s async phases (the early-exit branch, the probe-timeout branch,
// and the ready branch) used to mutate SHARED state UNCONDITIONALLY — `this.procs.delete(id)`,
// `this.set({status:'failed'})`, `this.set({status:'ready'})`. A SUPERSEDED launch (a newer
// start() for the same id minted a new entry/proc while the old one was still in its async phase)
// could therefore clobber the newer launch's entry or untrack its proc. Each launch now carries a
// monotonic token; every async-phase write verifies the token still owns the session before
// touching shared state, and a superseded launch tears down ONLY its OWN half-made resources.
describe('PreviewRegistry run-token ownership guards (audit P0-2)', () => {
  it('a SUPERSEDED launch reaching ready cannot clobber the NEWER ready entry, nor untrack its proc', async () => {
    // Two launches for the SAME id. Launch A stalls on probe (its port stays NOT-ready); while it
    // stalls, launch B becomes ready and owns the entry. Then A's port is flipped ready — A finally
    // probes ready but must STAND DOWN (the token moved to B), leaving B's entry + proc intact.
    const procA = fakeProc(); const procB = fakeProc()
    let n = 0
    const launch: Launch = () => (n++ === 0 ? procA : procB)
    // Track which port belongs to A: it is the FIRST port the registry allocates+probes. We hold A's
    // port not-ready until `aReady` is flipped; every other port (B's) is ready immediately.
    let aPort: number | undefined
    let aReady = false
    const probe: Probe = async port => {
      if (aPort === undefined) aPort = port // the first probed port is A's
      if (port === aPort) return aReady      // A: stalled until we flip it
      return true                            // B: ready at once
    }
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch, probe, probeAttempts: 500, probeIntervalMs: 1 })
    const aPromise = reg.start('s1', '/ws/a', 'vite')   // A — will stall on probe
    await new Promise(r => setTimeout(r, 5))            // let A allocate its port + probe once
    const bEntry = await reg.start('s1', '/ws/b', 'vite') // B — supersedes A (bumps the token), ready
    expect(bEntry.status).toBe('ready')
    expect(reg.portFor('s1')).toBe(bEntry.port)
    aReady = true // now A finally sees ready — it must STAND DOWN, not clobber B
    await aPromise
    // B's entry survives unchanged; A did not overwrite it to its own port/url, nor untrack its proc.
    expect(reg.get('s1')?.port).toBe(bEntry.port)
    expect(reg.get('s1')?.status).toBe('ready')
    expect(reg.portFor('s1')).toBe(bEntry.port)
    expect(aPort).not.toBe(bEntry.port) // sanity: A and B really had distinct ports
    // A tore down its OWN proc when it stood down (it must not leak a live process).
    expect(procA.killed).toBe(true)
    expect(procB.killed).toBe(false)
  })

  it('a SUPERSEDED launch hitting its probe TIMEOUT stands down — it does not flip the newer entry to failed', async () => {
    const procA = fakeProc(); const procB = fakeProc()
    let n = 0
    const launch: Launch = () => (n++ === 0 ? procA : procB)
    // A (the first allocated port) NEVER probes ready → times out; B (any later port) is ready.
    let aPort: number | undefined
    const probe: Probe = async port => { if (aPort === undefined) aPort = port; return port !== aPort }
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch, probe, probeAttempts: 6, probeIntervalMs: 2 })
    const aPromise = reg.start('s1', '/ws/a', 'vite') // A — will TIME OUT
    await new Promise(r => setTimeout(r, 2))           // let A allocate its port + probe once
    const bEntry = await reg.start('s1', '/ws/b', 'vite') // B supersedes (bumps token), ready
    expect(bEntry.status).toBe('ready')
    await aPromise // A's timeout branch fires — must NOT clobber B
    expect(reg.get('s1')?.status).toBe('ready')          // B's ready entry survives
    expect(reg.get('s1')?.port).toBe(bEntry.port)
    expect(procA.killed).toBe(true)                      // A killed its own dead proc
  })

  it('a SUPERSEDED launch whose child EXITS EARLY stands down — it does not flip the newer entry to failed', async () => {
    const procB = fakeProc()
    let n = 0
    // A exits early (code 1); B is a healthy proc.
    const launch: Launch = () => (n++ === 0 ? exitingProc(1, 'early death') : procB)
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch, probe: async () => n >= 2, probeAttempts: 200, probeIntervalMs: 1 })
    const aPromise = reg.start('s1', '/ws/a', 'vite') // A — child exits early after 1ms
    await new Promise(r => setTimeout(r, 2))
    const bEntry = await reg.start('s1', '/ws/b', 'vite') // B supersedes, ready
    expect(bEntry.status).toBe('ready')
    await aPromise // A's early-exit branch fires — must NOT clobber B's ready entry
    expect(reg.get('s1')?.status).toBe('ready')
    expect(reg.get('s1')?.port).toBe(bEntry.port)
  })
})

// ── review 3399732516 (MED) — IDENTICAL-BYTES restart skip + digest recording (registry half) ──
describe('PreviewRegistry code digest (additive entry field, recorded at start)', () => {
  it('records the supplied digest on the ready entry (so a restart can compare bytes)', async () => {
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite', { digest: 'abc123' })
    expect(e.status).toBe('ready')
    expect(e.digest).toBe('abc123')
    expect(reg.get('s1')?.digest).toBe('abc123')
  })

  it('records the digest on a STATIC ready entry too (statics rebuild on a digest change as well)', async () => {
    const reg = new PreviewRegistry({ sandbox: okSandbox, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'static', { digest: 'static-digest' })
    expect(e.status).toBe('ready')
    expect(e.type).toBe('static')
    expect(e.digest).toBe('static-digest')
  })
})

// ── review 3399732530 (LOW) + the cap half of 3399732533 — NON-EVICTING background starts ──
// start()'s at-capacity eviction loop used to run for BACKGROUND restarts/prewarms too: a
// static→node rebuild restart could evict ANOTHER session's LIVE preview. An additive
// `evict:'never'` opt makes a background start DECLINE at capacity instead of evicting.
describe('PreviewRegistry evict opt (a warm-up never evicts a live preview)', () => {
  const heavyReg = (max: number) => new PreviewRegistry({
    sandbox: okSandbox, commandOnPath: async () => true,
    launch: () => fakeProc(), probe: async () => true, maxConcurrent: max,
  })

  it("evict:'never' DECLINES at capacity — it does NOT evict another session's live preview", async () => {
    const reg = heavyReg(1)
    const live = await reg.start('s-live', '/tmp/a', 'vite') // fills the only heavy slot
    expect(live.status).toBe('ready')
    // A background restart of a DIFFERENT session at capacity must NOT evict s-live.
    const bg = await reg.start('s-bg', '/tmp/b', 'vite', { evict: 'never' })
    expect(bg.status).not.toBe('ready')                 // declined (no slot, no eviction)
    expect(reg.get('s-live')?.status).toBe('ready')     // the live preview is UNTOUCHED
    expect(bg.reason).toMatch(/capacity/i)              // honest: declined for capacity
  })

  it("evict:'allow' (the default, an EXPLICIT user start) STILL evicts the oldest at capacity", async () => {
    const reg = heavyReg(1)
    await reg.start('s-old', '/tmp/a', 'vite')
    const explicit = await reg.start('s-new', '/tmp/b', 'vite', { evict: 'allow' })
    expect(explicit.status).toBe('ready')
    expect(reg.get('s-old')?.status).toBe('stopped')    // user intent still evicts
  })

  it("evict:'never' for the SAME session at capacity still restarts (it reuses its own slot, evicts no one)", async () => {
    const reg = heavyReg(1)
    const first = await reg.start('s1', '/tmp/a', 'vite')
    expect(first.status).toBe('ready')
    // Re-starting the SAME id frees its own slot first (start() stops the prior entry), so a
    // background restart is NOT at capacity for itself — it boots without evicting anyone.
    const restart = await reg.start('s1', '/tmp/b', 'vite', { evict: 'never' })
    expect(restart.status).toBe('ready')
  })
})
