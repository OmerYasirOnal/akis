import type { RagService } from '../RagService.js'
import type { IngestQueue } from './IngestQueue.js'
import { type RepoReader, fileSha } from './RepoReader.js'
import { chunkByKind, type ChunkKind } from './structureChunk.js'
import { shouldExclude } from './exclude.js'

export interface RepoSourceDeps {
  rag: RagService
  /** The queue is the same one inside the RagService — used here only to count a
   *  file excluded BEFORE it ever reaches rag.ingest (path-based, e.g. `.env`). */
  queue: IngestQueue
  reader: RepoReader
}

export interface RepoIngestInput {
  sessionId: string
  userId: string
}

/** Per-(user,session) incremental state: the last-seen commit identity + the per-file
 *  hashes we have already ingested, so a re-pass skips unchanged files. */
interface RepoState {
  sha: string
  fileShas: Map<string, string>
}

/**
 * Repo ingestion source (issue #7 AC1). Reads a session's repo through the RepoReader
 * seam, classifies each file by kind, structure-chunks it (chunkByKind), and feeds the
 * chunks to RagService.ingest with source:'repo' / sourceId:filePath — so chunks carry
 * the file as provenance and right-to-forget can target a single file via
 * deleteBySource('repo', filePath).
 *
 * Repo files are TRUSTED SOURCE content (not ephemeral): they are eligible RAG
 * grounding, unlike free-form/LLM/edge text. Every chunk still runs through
 * shouldExclude so secrets/.env never embed, and every chunk is stamped with the
 * {userId,sessionId} tenancy of the request.
 *
 * Incremental, two levels, both keyed by tenancy ({userId}:{sessionId}):
 *  1. commit-skip — if the reader's headSha is unchanged since the last pass, the whole
 *     pass is skipped (nothing is even enqueued).
 *  2. per-file-skip — when the head moved, only files whose own content hash changed are
 *     re-ingested; unchanged files are skipped. (RagService.ingest also dedups identical
 *     chunks by contentHash, so this is belt-and-suspenders, but it avoids the wasted
 *     enqueue/embeds entirely.)
 *
 * State is in-memory (process-local, MVP) — a persistent store drops in behind the same
 * shape later. Holds NO gate capability.
 */
export class RepoSource {
  private state = new Map<string, RepoState>()

  constructor(private deps: RepoSourceDeps) {}

  async ingest(input: RepoIngestInput): Promise<void> {
    const { sessionId, userId } = input
    const repoKey = `${userId}\0${sessionId}`
    const head = this.deps.reader.headSha(sessionId)
    const prev = this.state.get(repoKey)
    if (prev && prev.sha === head) return // commit-skip: nothing changed since last pass

    const files = this.deps.reader.listFiles(sessionId)
    const nextShas = new Map<string, string>()
    for (const file of files) {
      const sha = fileSha(file)
      nextShas.set(file.filePath, sha)
      if (prev?.fileShas.get(file.filePath) === sha) continue // per-file skip: unchanged

      // Path/content exclusion BEFORE embedding (F1-AC12). Run with the real filePath as
      // the source so path-based secrets (e.g. `.env`, `*.pem`) are caught — RagService
      // would only see source:'repo' and miss them.
      if (shouldExclude(file.content, file.filePath).excluded) {
        this.deps.queue.metrics.excluded++
        continue
      }
      const kind = classifyKind(file.filePath)
      for (const text of chunkByKind(file.content, kind)) {
        this.deps.rag.ingest({ text, source: 'repo', sourceId: file.filePath, userId, sessionId })
      }
    }
    // Prune files removed (or renamed) since the last pass: their chunks must not linger as
    // stale RAG grounding. A rename is a remove (old path) + add (new path), so dropping the
    // absent old paths covers it. deleteBySource targets the file's provenance
    // (source:'repo', sourceId:filePath) for this tenancy.
    if (prev) {
      for (const oldPath of prev.fileShas.keys()) {
        if (!nextShas.has(oldPath)) this.deps.rag.deleteBySourceFor('repo', oldPath, { userId, sessionId })
      }
    }
    this.state.set(repoKey, { sha: head, fileShas: nextShas })
  }
}

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb',
  'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'scala', 'sh', 'sql',
])
const PROSE_EXT = new Set(['txt', 'rst', 'adoc'])

/** Map a file path to the structural chunk kind (issue #7 AC4). Markdown/spec gets
 *  heading-aware sectioning; code gets the symbol-split heuristic; everything else is
 *  prose. */
export function classifyKind(filePath: string): ChunkKind {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (CODE_EXT.has(ext)) return 'code'
  if (PROSE_EXT.has(ext)) return 'prose'
  return 'prose'
}
