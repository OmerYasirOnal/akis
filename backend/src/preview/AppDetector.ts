import type { RepoFile } from '../di/MockGitHubAdapter.js'

export type AppType = 'vite' | 'next' | 'node-service' | 'static' | 'unsupported'

interface PkgJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
}

/**
 * Classify a produced file set into how it should be previewed:
 *  - 'vite'         : a Vite SPA (vite dep or a vite script) → vite dev server
 *  - 'next'         : a Next.js app (next dep or a next script) → next dev server
 *  - 'node-service' : a Node HTTP service (start script or a server entry)
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
    if (scripts.start || scripts.serve || pkg.main || hasServerEntry(byPath)) return 'node-service'

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
