import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATIC_SERVE_MJS } from '../../src/publish/staticServe.js'

/**
 * MED-2 (start verification) for the VENDORED publish static server: a LISTEN failure must exit
 * NON-ZERO with a clear message, not crash silently.
 *
 * WHY: the Publisher launches the server detached and ends the launcher in `; true`, so a genuine
 * start failure is invisible to it EXCEPT through (a) the started-pid liveness check it now runs and
 * (b) the server's own exit code. On a RE-PUBLISH the port can still be held by a prior server, so
 * the new instance hits EADDRINUSE. Without a `server.on('error', …)` handler the 'error' event is
 * UNHANDLED → the process crashes as an uncaught exception that `; true` masks → the OLD server keeps
 * serving STALE files while the deploy looks successful. With the handler the process exits(1) and
 * logs the cause, so static.log shows it and the liveness check sees a dead pid + an unbound new
 * server.
 *
 * We run the real template as a child node process (it never runs in the AKIS process). NO network
 * beyond loopback. NOTE: this is a DIFFERENT file from publishStaticServe.test.ts (owned elsewhere).
 */
describe('publish static-serve (start failure surfacing)', () => {
  let scratch: string | undefined
  let holder: ChildProcess | undefined
  let second: ChildProcess | undefined

  afterEach(() => {
    for (const c of [holder, second]) { if (c && !c.killed) c.kill('SIGKILL') }
    holder = undefined; second = undefined
    if (scratch) { rmSync(scratch, { recursive: true, force: true }); scratch = undefined }
  })

  it('the exported template installs a server error handler (EADDRINUSE is not a silent crash)', () => {
    // A static assertion on the shipped string: the handler + a NON-ZERO exit must be present, so a
    // regression that dropped the error handler (returning to the silent-crash behavior) is caught.
    expect(STATIC_SERVE_MJS).toContain("server.on('error'")
    expect(STATIC_SERVE_MJS).toContain('process.exit(1)')
  })

  it('a second instance on an OCCUPIED port EXITS NON-ZERO (no silent uncaught crash)', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'akis-static-start-'))
    const root = join(scratch, 'app')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'index.html'), '<h1>hi</h1>')
    const serverFile = join(scratch, 'static-serve.mjs')
    writeFileSync(serverFile, STATIC_SERVE_MJS)

    const port = await freePort()
    // First instance grabs the port and stays up.
    holder = spawn(process.execPath, [serverFile, String(port), root], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForListening(`http://127.0.0.1:${port}`)

    // Second instance on the SAME port hits EADDRINUSE — it MUST exit non-zero (the error handler),
    // NOT hang and NOT exit 0. We capture stderr to confirm the cause is reported.
    second = spawn(process.execPath, [serverFile, String(port), root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    second.stderr?.on('data', d => { stderr += String(d) })
    const exitCode = await new Promise<number | null>((resolve) => {
      second!.on('exit', (code) => resolve(code))
      // Safety net so a regression that HANGS (no handler, no crash) fails the test instead of
      // hanging the suite.
      setTimeout(() => resolve(-999), 5_000)
    })
    expect(exitCode).not.toBe(0)      // a failed listen is a failure
    expect(exitCode).not.toBe(-999)   // and it did NOT hang
    expect(stderr).toContain('static-serve failed to start')
    // The first server is unaffected and still serving.
    const res = await fetch(`http://127.0.0.1:${port}/index.html`)
    expect(res.status).toBe(200)
  })
})

function freePort(): Promise<number> {
  return import('node:net').then(({ createServer }) => new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  }))
}

/** Poll until the spawned static server answers (bounded). */
async function waitForListening(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/index.html`); return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('static-serve did not start')
}
