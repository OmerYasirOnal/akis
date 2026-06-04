import type { RepoFile } from '../di/MockGitHubAdapter.js'

/**
 * EDIT-MODE merge (Phase B.5): overlay Proto's emitted files ON TOP of the base app.
 *
 * Emitted files win by `filePath` (an edit or a new file); base files Proto did not touch
 * are carried forward unchanged — so a follow-up build EDITS the prior app instead of
 * regenerating it, and already-approved work survives. Pure + order-stable: base order
 * first (with edits in place), then genuinely-new files in emitted order. With no base
 * it returns the emitted files as-is, so a fresh build is byte-identical to today.
 *
 * The merged result — the WHOLE app — is what flows to the validator, the critic, and the
 * store, so review and verification always see the full application, never a fragment.
 */
export function mergeFiles(base: readonly RepoFile[] | undefined, emitted: readonly RepoFile[]): RepoFile[] {
  if (!base || base.length === 0) return [...emitted]
  const byPath = new Map(emitted.map(f => [f.filePath, f]))
  const merged = base.map(f => byPath.get(f.filePath) ?? f)
  const basePaths = new Set(base.map(f => f.filePath))
  for (const f of emitted) if (!basePaths.has(f.filePath)) merged.push(f)
  return merged
}
