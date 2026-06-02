import { createHash } from 'node:crypto'
import type { MockGitHubAdapter, RepoFile } from '../../di/MockGitHubAdapter.js'

/**
 * Read seam for repo ingestion (issue #7 AC1). Mirrors the EmbeddingProvider /
 * VectorStore ports: an offline mock is the default, a real GitHub reader drops in
 * behind the same shape later (opt-in behind AKIS_GITHUB_TOKEN) without touching the
 * RepoSource consumer.
 *
 * `headSha` is the commit-identity used for the cheap incremental commit-skip: when it
 * is unchanged the whole pass is skipped. `listFiles` returns the current file set so a
 * changed pass can re-ingest only the files whose per-file hash moved.
 *
 * Holds NO gate capability — it only reads source content.
 */
export interface RepoReader {
  listFiles(sessionId: string): RepoFile[]
  headSha(sessionId: string): string
}

/**
 * Default offline RepoReader: adapts a MockGitHubAdapter (the same in-memory file set
 * `pushFiles` wrote — the producer and the reader share one adapter, so a freshly
 * pushed repo is immediately readable). There is no real commit, so the "sha" is a
 * deterministic content hash over the sorted {filePath,content} set: identical for an
 * unchanged set, different the moment any file's path or content moves. This gives
 * RepoSource a stable commit identity to skip on without any network.
 */
export class MockRepoReader implements RepoReader {
  constructor(private github: MockGitHubAdapter) {}

  listFiles(sessionId: string): RepoFile[] {
    return this.github.read(sessionId)
  }

  headSha(sessionId: string): string {
    const files = [...this.listFiles(sessionId)].sort((a, b) => a.filePath.localeCompare(b.filePath))
    const h = createHash('sha256')
    for (const f of files) {
      // Length-prefix each part so distinct sets can't collide via concatenation.
      for (const part of [f.filePath, f.content]) {
        h.update(String(part.length))
        h.update('\0')
        h.update(part)
      }
    }
    return h.digest('hex')
  }
}

/** Stable per-file content hash for the incremental per-file skip. */
export function fileSha(file: RepoFile): string {
  const h = createHash('sha256')
  for (const part of [file.filePath, file.content]) {
    h.update(String(part.length))
    h.update('\0')
    h.update(part)
  }
  return h.digest('hex')
}
