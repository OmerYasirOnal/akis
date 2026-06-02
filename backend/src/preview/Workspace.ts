import { mkdir, writeFile, rm } from 'node:fs/promises'
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
