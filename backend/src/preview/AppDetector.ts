import type { RepoFile } from '../di/MockGitHubAdapter.js'

export type AppType = 'vite' | 'next' | 'node-service' | 'cli' | 'static' | 'unsupported'

interface PkgJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
  /** The CLI marker: a `bin` field means this package installs an executable, not a server. */
  bin?: string | Record<string, string>
}

/** Server frameworks whose mere PRESENCE is server evidence (they open a listening socket).
 *  KNOWN GAP: this is a best-effort allowlist of the common Node HTTP frameworks — an exotic or
 *  in-house server framework not listed here still relies on the SERVER_LISTEN source scan below,
 *  and a framework that boots WITHOUT any `.listen(`/`.serve(` in the emitted source (rare) could be
 *  misclassified as 'cli'. Conservative by design: we'd rather run a real test suite than boot a
 *  non-server. Widen this list (or SERVER_LISTEN) if a genuine server shape is seen misclassified. */
const SERVER_FRAMEWORK = /^(express|fastify|koa|@hapi\/hapi|hapi|restify|connect|polka|hono|h3|@nestjs\/core|@nestjs\/platform-express)$/

/** A real server-listen signal in source: a `.listen(`/`.serve(` call or a `createServer(`
 *  (http/net/https). A CLI never opens a listening socket, so this is the honest boot-vs-run
 *  discriminator (`.serve(` covers Deno/Bun/hono-style servers that don't call `.listen(`). */
const SERVER_LISTEN = /\.listen\s*\(|\.serve\s*\(|createServer\s*\(/

/** Is a file a TEST file? (excluded from the listen scan so a test's fixture can't fake a server.) */
function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|e2e|features)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
}

/** Does any NON-TEST .js/.ts source actually open a listening server socket? Cheap string scan. */
function hasServerListen(files: RepoFile[]): boolean {
  return files.some(f =>
    /\.[cm]?[jt]sx?$/.test(f.filePath) && !isTestFile(f.filePath) && SERVER_LISTEN.test(f.content))
}

/**
 * Classify a produced file set into how it should be previewed:
 *  - 'vite'         : a Vite SPA (vite dep or a vite script) → vite dev server
 *  - 'next'         : a Next.js app (next dep or a next script) → next dev server
 *  - 'node-service' : a Node HTTP service — an entrypoint WITH real server evidence (a server
 *                     framework dep or actual `.listen(`/`createServer(` code)
 *  - 'cli'          : a command-line tool (a `bin` field or a `test` script but NO server-listen
 *                     evidence) → verified by RUNNING ITS TESTS, never booted as a server
 *  - 'static'       : just an index.html (+ assets) → static file server
 *  - 'unsupported'  : needs something we don't run locally yet (e.g. a database)
 * Pure: reads only the file set, no I/O.
 *
 * Ordering matters: a runnable framework/server WINS over a DB-infra hint. A Vite/Next/
 * Node app that merely *lists* a DB dependency (pg/prisma/…) still previews — we only fall
 * back to 'unsupported' when the file set is PURELY DB infra (no vite/next/server entry/
 * index.html to actually run). Previously the DB regex ran first and white-screened any app
 * that named a DB dep, even ones that boot fine without it.
 */
export function detectAppType(files: RepoFile[]): AppType {
  const byPath = new Map(files.map(f => [f.filePath.replace(/^\.?\//, ''), f]))
  const pkgFile = byPath.get('package.json')

  if (pkgFile) {
    let pkg: PkgJson = {}
    try { pkg = JSON.parse(pkgFile.content) as PkgJson } catch { /* malformed → fall through */ }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const scripts = pkg.scripts ?? {}

    // Runnable framework/server detection wins over the DB-infra hint below.
    if ('next' in deps || Object.values(scripts).some(s => /\bnext\b/.test(s))) return 'next'
    if ('vite' in deps || Object.values(scripts).some(s => /\bvite\b/.test(s))) return 'vite'

    // A node ENTRYPOINT signal (start/serve script, a `main`, a server-entry file, or a `bin`).
    // But "has an entrypoint" is NOT "boots a persistent HTTP server": a CLI has a main/start/bin
    // too. Only classify 'node-service' when there is ACTUAL server evidence — a declared server
    // framework or real listen code. When there is none, a project with a `bin` field or a `test`
    // script is a CLI: it must be VERIFIED BY RUNNING ITS TESTS, never booted as a server (booting
    // a CLI exits immediately and false-fails the build with testsRun:0).
    const hasEntry = !!(scripts.start || scripts.serve || pkg.main || pkg.bin || hasServerEntry(byPath))
    if (hasEntry) {
      const serverEvidence = Object.keys(deps).some(d => SERVER_FRAMEWORK.test(d)) || hasServerListen(files)
      if (serverEvidence) return 'node-service'
      if (pkg.bin !== undefined || scripts.test !== undefined) return 'cli'
      return 'node-service' // preserve prior behavior for an ambiguous entry (no bin, no tests)
    }

    // No runnable surface in package.json — if it's PURELY DB infra (and there is no
    // index.html to fall back to), it needs something we don't run locally yet.
    const text = JSON.stringify({ deps, scripts })
    if (!byPath.has('index.html') && /\b(pg|postgres|mysql|mongodb|mongoose|prisma|redis|sqlite3|better-sqlite3)\b/i.test(text)) {
      return 'unsupported'
    }
  }

  if (byPath.has('index.html')) return 'static'
  return 'unsupported'
}

function hasServerEntry(byPath: Map<string, RepoFile>): boolean {
  return ['server.js', 'server.ts', 'index.js', 'index.ts', 'src/server.ts', 'src/index.ts'].some(p => byPath.has(p))
}
