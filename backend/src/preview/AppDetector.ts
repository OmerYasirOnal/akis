import type { RepoFile } from '../di/MockGitHubAdapter.js'

export type AppType = 'vite' | 'node-service' | 'static' | 'unsupported'

interface PkgJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
}

/**
 * Classify a produced file set into how it should be previewed:
 *  - 'vite'         : a Vite SPA (vite dep or a vite script) → vite dev server
 *  - 'node-service' : a Node HTTP service (start script or a server entry)
 *  - 'static'       : just an index.html (+ assets) → static file server
 *  - 'unsupported'  : needs something we don't run locally yet (e.g. a database)
 * Pure: reads only the file set, no I/O.
 */
export function detectAppType(files: RepoFile[]): AppType {
  const byPath = new Map(files.map(f => [f.filePath.replace(/^\.?\//, ''), f]))
  const pkgFile = byPath.get('package.json')

  if (pkgFile) {
    let pkg: PkgJson = {}
    try { pkg = JSON.parse(pkgFile.content) as PkgJson } catch { /* malformed → fall through */ }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const scripts = pkg.scripts ?? {}
    const text = JSON.stringify({ deps, scripts })

    // Needs infra we don't run locally → unsupported (checked first).
    if (/\b(pg|postgres|mysql|mongodb|mongoose|prisma|redis|sqlite3|better-sqlite3)\b/i.test(text)) {
      return 'unsupported'
    }
    if ('vite' in deps || Object.values(scripts).some(s => /\bvite\b/.test(s))) return 'vite'
    if (scripts.start || scripts.serve || pkg.main || hasServerEntry(byPath)) return 'node-service'
  }

  if (byPath.has('index.html')) return 'static'
  return 'unsupported'
}

function hasServerEntry(byPath: Map<string, RepoFile>): boolean {
  return ['server.js', 'server.ts', 'index.js', 'index.ts', 'src/server.ts', 'src/index.ts'].some(p => byPath.has(p))
}
