/**
 * The VENDORED static file server we ship into the remote `targetDir` and run as
 * `node static-serve.mjs <port> <rootDir>`. We do NOT depend on a network `npx serve` (v1
 * determinism) and do NOT assume nginx. It binds 0.0.0.0 so the app is reachable from outside
 * the box — a DELIBERATELY more-exposed posture than preview's loopback bind (publish is meant to
 * be externally reachable; preview sits behind the AKIS proxy). Pure node:http + node:fs, no deps.
 *
 * Exported as a STRING so the Publisher can `putFiles` it verbatim — it never runs in the AKIS
 * process. Kept tiny (~30 lines of logic) and dependency-free so it installs nowhere.
 */
export const STATIC_SERVE_MJS = `import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname, sep } from 'node:path'

const port = Number(process.argv[2] || process.env.PORT || 8080)
const root = process.argv[3] || process.cwd()
// The normalized root + a trailing separator. The containment check below uses this PREFIX so a
// SIBLING dir whose absolute path merely STARTS WITH the root string can never be served: root
// '/home/ubuntu/app' must NOT admit '/home/ubuntu/app-secret/...' (a real, previously-exploitable
// hole — GET /../app-secret/creds.txt). Resolve to the root itself OR a path strictly under root+sep.
const rootNorm = normalize(root)
const rootPrefix = rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}

// A request path is in-root iff it IS the root or sits strictly under root + path.sep — closing
// the sibling-prefix hole that a bare startsWith(root) left open.
const inRoot = p => p === rootNorm || p.startsWith(rootPrefix)

const server = createServer(async (req, res) => {
  try {
    // Resolve under root; reject any traversal that escapes it. normalize() the REQUEST path FIRST
    // so a leading '..' is collapsed/anchored BEFORE the join (a '/../x' request normalizes to '/x'),
    // then re-check containment against root + sep so even a crafted absolute can't escape.
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    // Anchor at '/' and collapse '..' BEFORE joining so the request can never climb above root.
    rel = normalize('/' + rel)
    if (rel.endsWith('/')) rel += 'index.html'
    const path = normalize(join(root, rel))
    if (!inRoot(path)) { res.writeHead(403); res.end('forbidden'); return }
    const s = await stat(path).catch(() => null)
    const file = s && s.isDirectory() ? join(path, 'index.html') : path
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    // SPA fallback: serve index.html for an unknown path so client-side routing works.
    try {
      const body = await readFile(join(root, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    } catch { res.writeHead(404); res.end('not found') }
  }
})
// A LISTEN failure (e.g. EADDRINUSE because a prior static-serve still holds the port on a
// re-publish) MUST exit NON-ZERO with a clear message — without this the 'error' event is unhandled,
// which crashes the process as an uncaught exception that the launcher's '; true' silently masks,
// leaving the OLD server serving STALE files while the deploy looks successful. A logged exit(1)
// makes the failure visible in static.log and lets the Publisher's started-pid check catch it.
server.on('error', e => { console.error('static-serve failed to start: ' + (e && e.message ? e.message : e)); process.exit(1) })
server.listen(port, '0.0.0.0', () => console.log('static-serve on ' + port))
`
