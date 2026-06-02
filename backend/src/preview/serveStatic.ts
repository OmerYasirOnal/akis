import { readFile } from 'node:fs/promises'
import { join, normalize, resolve, extname, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
}
const contentType = (p: string): string => TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream'

export interface StaticResponse { code: number; type?: string; body: Buffer | string }

/**
 * Resolve a request sub-path to a file under a STATIC preview's materialized dir and
 * read it. Pure transport for agent-produced static apps:
 *  - `/` (or any extensionless path) → `index.html` (SPA fallback)
 *  - path-traversal escaping `dir` → 403 (never reads outside the workspace)
 *  - missing asset → 404
 * Returns a {code, type, body} so the route layer stays thin and this is unit-testable.
 */
export async function serveStatic(dir: string, subPath: string): Promise<StaticResponse> {
  const root = resolve(dir)
  const cleaned = normalize(decodeURIComponent(subPath)).replace(/\\/g, '/')
  // No extension (or root) → serve the SPA entry so client routes resolve.
  const rel = cleaned === '/' || cleaned === '' || !extname(cleaned) ? 'index.html' : cleaned.replace(/^\/+/, '')
  const filePath = resolve(join(root, rel))
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return { code: 403, type: 'text/plain; charset=utf-8', body: 'forbidden' }
  }
  try {
    const body = await readFile(filePath)
    return { code: 200, type: contentType(filePath), body }
  } catch {
    // Extensionless deep-links already resolved to index.html above; a missing
    // concrete asset is a real 404 (never serve HTML in place of a missing .png/.js).
    return { code: 404, type: 'text/plain; charset=utf-8', body: 'not found' }
  }
}
