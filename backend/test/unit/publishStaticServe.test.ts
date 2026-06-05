import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, sep } from 'node:path'
import { STATIC_SERVE_MJS } from '../../src/publish/staticServe.js'

/**
 * MED-1 path-traversal regression for the VENDORED publish static server (staticServe.ts).
 *
 * The old guard `if (!path.startsWith(normalize(root)))` admitted a SIBLING dir whose absolute
 * path merely STARTED WITH the root string: root `/home/ubuntu/app` admitted
 * `/home/ubuntu/app-secret/...` (live-exploited via `GET /../app-secret/creds.txt`). The fix
 * compares against `normalize(root) + sep` AND normalizes/anchors the request path before join.
 *
 * We run the real template as a child node process (it never runs in the AKIS process) and probe
 * it over HTTP — the faithful test of the served behavior. NO network beyond loopback.
 */
describe('publish static-serve (MED-1 path traversal)', () => {
  let scratch: string
  let root: string
  let serverFile: string
  let child: ChildProcess | undefined
  let base: string

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'akis-static-serve-'))
    // The served root and a SIBLING dir that shares the root's string prefix (`app` vs `app-secret`).
    root = join(scratch, 'app')
    const sibling = join(scratch, 'app-secret')
    mkdirSync(root, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(root, 'index.html'), '<h1>in-root</h1>')
    writeFileSync(join(sibling, 'creds.txt'), 'SUPER_SECRET_SIBLING')
    // A secret one level above root, for the classic `../` escape.
    writeFileSync(join(scratch, 'parent-secret.txt'), 'SUPER_SECRET_PARENT')

    // Write the vendored template verbatim and boot it on an ephemeral port (0 → OS-assigned).
    serverFile = join(scratch, 'static-serve.mjs')
    writeFileSync(serverFile, STATIC_SERVE_MJS)
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [serverFile, String(port), root], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForListening(base)
  })

  afterAll(async () => {
    if (child && !child.killed) { child.kill('SIGKILL') }
    rmSync(scratch, { recursive: true, force: true })
  })

  it('serves an in-root file', async () => {
    const res = await fetch(`${base}/index.html`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('in-root')
  })

  // The security invariant under test is "the sibling/parent secret is NEVER served". The fix
  // anchors the request path under root BEFORE join, so a traversal collapses to an in-root path:
  // a non-existent one is answered 403 (escape rejected) or by the SPA fallback (index.html, 200)
  // — EITHER way the secret bytes never leave the box. We assert the bytes, not just the status.
  it('REFUSES a sibling-prefix path (app-secret shares the root string prefix)', async () => {
    // The raw request that the old startsWith(root) guard would have ADMITTED. fetch normalizes
    // `/../`, so hit the server with a manually-built raw request to keep the `..` on the wire.
    const body = await rawGet(base, '/../app-secret/creds.txt')
    expect(body.text).not.toContain('SUPER_SECRET_SIBLING')
  })

  it('REFUSES a `../` escape to a parent secret', async () => {
    const body = await rawGet(base, '/../parent-secret.txt')
    expect(body.text).not.toContain('SUPER_SECRET_PARENT')
  })

  it('REFUSES an encoded `..%2f` traversal too', async () => {
    const body = await rawGet(base, '/..%2fapp-secret%2fcreds.txt')
    expect(body.text).not.toContain('SUPER_SECRET_SIBLING')
  })
})

/**
 * MED-1 (the part the HTTP tests above CANNOT cover): pin the `rootPrefix` containment fix itself.
 *
 * The HTTP traversal tests above are NECESSARY but NOT SUFFICIENT to pin the fix: the template
 * anchors the request path with `normalize('/' + rel)` BEFORE the join, which collapses every `..`
 * back UNDER root — so over the wire the resolved path can never actually reach the real sibling
 * `<scratch>/app-secret/...`. Both the new `rootPrefix` guard AND the OLD bare `startsWith(root)`
 * guard admit those anchored paths identically; reverting the security fix leaves all three HTTP
 * tests green. The ONLY input on which the two guards diverge is a resolved path that genuinely
 * lands in the sibling — which the request handler's anchoring never produces. So we exercise the
 * shipped `inRoot` predicate directly on such a path: this is the test that BREAKS if `rootPrefix`
 * is reverted to `path.startsWith(normalize(root))`.
 *
 * To avoid testing a hand-copied predicate (which would not catch a regression in the real source),
 * we reconstruct `inRoot` from the EXACT lines of the vendored template string. If someone edits the
 * template to weaken the guard, these extracted lines change and the test below fails.
 */
describe('publish static-serve (MED-1 rootPrefix containment predicate)', () => {
  // The directory we pretend to serve, and a SIBLING whose absolute path shares the root STRING
  // prefix (`/srv/app` vs `/srv/app-secret`) — the exact shape of the previously-exploitable hole.
  const root = normalize(join(sep, 'srv', 'app'))
  const sibling = join(normalize(join(sep, 'srv', 'app-secret')), 'creds.txt')
  const insideRoot = join(root, 'index.html')

  /** Rebuild `inRoot` from the vendored template's OWN source lines so a regression in the shipped
   *  guard (not a test copy) is what the assertions catch. */
  function shippedInRoot(rootDir: string): (p: string) => boolean {
    const grab = (re: RegExp): string => {
      const hit = re.exec(STATIC_SERVE_MJS)
      if (!hit) { throw new Error(`MED-1 test could not find expected line ${re} in STATIC_SERVE_MJS`) }
      return hit[0]
    }
    const lines = [
      grab(/const rootNorm = .*/),
      grab(/const rootPrefix = .*/),
      grab(/const inRoot = .*/),
    ].join('\n')
    // normalize/sep/root are the only free identifiers the three lines reference.
    const factory = new Function('normalize', 'sep', 'root', `${lines}\nreturn inRoot`) as (
      n: typeof normalize, s: typeof sep, r: string,
    ) => (p: string) => boolean
    return factory(normalize, sep, rootDir)
  }

  it('REJECTS a sibling-prefix path that the OLD bare startsWith(root) guard would have ADMITTED', () => {
    const inRoot = shippedInRoot(root)
    // The crux: `/srv/app-secret/...` STARTS WITH `/srv/app` (old guard => admit) but is NOT under
    // `/srv/app/` (new guard => reject). Only the `rootPrefix` fix makes this false.
    expect(inRoot(sibling)).toBe(false)
    // Sanity: genuinely-in-root paths and the root itself are still admitted (no over-tightening).
    expect(inRoot(insideRoot)).toBe(true)
    expect(inRoot(root)).toBe(true)
  })
})

/** A raw HTTP GET that sends the path on the wire UNCHANGED (so `..` is not collapsed by a client
 *  URL parser the way fetch() would). Returns the status + the response body text. */
function rawGet(base: string, path: string): Promise<{ status: number; text: string }> {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    import('node:net').then(({ connect }) => {
      const sock = connect({ host: u.hostname, port: Number(u.port) }, () => {
        sock.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`)
      })
      let raw = ''
      sock.setEncoding('utf8')
      sock.on('data', d => { raw += d })
      sock.on('end', () => {
        const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(raw)
        const status = statusMatch ? Number(statusMatch[1]) : 0
        const text = raw.slice(raw.indexOf('\r\n\r\n') + 4)
        resolve({ status, text })
      })
      sock.on('error', reject)
    }).catch(reject)
  })
}

/** An OS-assigned free loopback port. */
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
