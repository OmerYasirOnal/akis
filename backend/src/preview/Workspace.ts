import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { RepoFile } from '../di/MockGitHubAdapter.js'

/** Root for ephemeral preview workspaces (override for tests). */
export function workspacesRoot(): string {
  return process.env.AKIS_WORKSPACES_DIR ?? join(homedir(), '.akis', 'workspaces')
}

/** Reject path traversal / absolute paths so a malicious filePath can't escape the
 *  workspace dir (e.g. '../../etc', '/etc/passwd'). */
function safeJoin(root: string, filePath: string): string {
  const cleaned = filePath.replace(/^[/\\]+/, '')
  const full = resolve(root, cleaned)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`unsafe file path escapes workspace: ${filePath}`)
  }
  return full
}

/**
 * Materialize a produced RepoFile[] into an ephemeral on-disk workspace under
 * ~/.akis/workspaces/<sessionId>-<nonce>/ so it can be installed/run/previewed,
 * then torn down. Path-traversal-safe. Returns the absolute workspace dir.
 */
export async function materialize(sessionId: string, files: RepoFile[], root = workspacesRoot()): Promise<string> {
  const nonce = randomBytes(6).toString('hex')
  const dir = join(root, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${nonce}`)
  await mkdir(dir, { recursive: true })
  for (const f of files) {
    const dest = safeJoin(dir, f.filePath)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, f.content, 'utf8')
  }
  return dir
}

/** Remove a workspace dir (idempotent). */
export async function teardown(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Reclaim the workspaces root on startup: remove any pre-existing entries left behind by
 * a hard kill (SIGKILL skips graceful teardown), so orphaned dirs don't accumulate across
 * restarts. Idempotent and STRICTLY guarded to the workspaces root — it only `rm`s the
 * immediate children of `root` (never `root` itself, never anything outside it). A missing
 * root is a no-op. Per-entry errors are tolerated so one stuck dir can't block boot.
 *
 * Ownership sentinel: only entries whose name matches the materialize() pattern
 * (`<id>-<12-hex-nonce>`) are removed. So a mis-pointed AKIS_WORKSPACES_DIR (a Docker
 * volume-mount typo, or someone setting it to $HOME / a populated dir) can NEVER wipe
 * unrelated files at boot — even though they're inside the configured root. (PR #83 review)
 */
const OWNED = /-[0-9a-f]{12}$/ // the trailing nonce materialize() stamps on every workspace dir
export async function reclaimWorkspaces(root = workspacesRoot()): Promise<void> {
  const base = resolve(root)
  let entries: string[]
  try { entries = await readdir(base) } catch { return } // no root yet → nothing to reclaim
  await Promise.allSettled(entries.map(name => {
    const child = resolve(base, name)
    // Defense-in-depth: never escape the root (a symlink-named entry could resolve out).
    if (child === base || !child.startsWith(base + sep)) return Promise.resolve()
    if (!OWNED.test(name)) return Promise.resolve() // not an AKIS-created workspace → leave it untouched
    return rm(child, { recursive: true, force: true })
  }))
}
