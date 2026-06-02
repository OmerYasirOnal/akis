import type { RagService } from '../RagService.js'
import type { IngestQueue } from './IngestQueue.js'
import { parseUpload } from './parse/parseUpload.js'
import { chunkByKind } from './structureChunk.js'
import { shouldExclude } from './exclude.js'

export interface UploadSourceDeps {
  rag: RagService
  /** The RagService's own queue — used only to count a file excluded BEFORE it reaches
   *  rag.ingest (e.g. a secret-named upload). */
  queue: IngestQueue
}

export interface UploadIngestInput {
  sessionId: string
  userId: string
  filename: string
  bytes: Buffer
  mime?: string
}

/**
 * Upload ingestion source (issue #7 AC2). Parses an uploaded file to text via
 * parseUpload (markdown frontmatter stripped, plain text passthrough, PDF via
 * pdf-parse), structure-chunks it (chunkByKind), and feeds the chunks to
 * RagService.ingest with source:'upload' / sourceId:filename.
 *
 * Uploads are TRUSTED SOURCE content (NOT ephemeral): unlike free-form/LLM/edge text
 * they ARE eligible RAG grounding. They still run through shouldExclude so secrets/binary
 * never embed, and every chunk is stamped with the request's {userId,sessionId} tenancy.
 *
 * Idempotent: re-uploading an identical file dedups via RagService's per-chunk
 * contentHash (no corpus growth); deleteBySource('upload', filename) forgets it. The
 * route owns owner-scoping (404 for non-owners) — this Source holds NO gate capability
 * and trusts the {userId,sessionId} it is handed.
 *
 * A parseUpload failure (unsupported/binary/unparsable PDF) throws UploadParseError and
 * NOTHING is ingested — the caller maps it to 415 synchronously. Parsing happens inline
 * (before any enqueue), so a bad upload never reaches the queue / a dead-letter path; the
 * corpus is never mutated by a bad upload.
 */
export class UploadSource {
  constructor(private deps: UploadSourceDeps) {}

  async ingest(input: UploadIngestInput): Promise<void> {
    const { sessionId, userId, filename } = input
    const parsed = await parseUpload({
      filename,
      bytes: input.bytes,
      ...(input.mime !== undefined ? { mime: input.mime } : {}),
    })

    // Exclusion BEFORE embedding (F1-AC12): run with the filename as the source so a
    // secret-named upload (e.g. `.env`) is path-excluded, and an inline secret in the
    // parsed text is content-excluded. RagService would only see source:'upload'.
    if (shouldExclude(parsed.text, filename).excluded) {
      this.deps.queue.metrics.excluded++
      return
    }

    for (const text of chunkByKind(parsed.text, parsed.kind)) {
      this.deps.rag.ingest({ text, source: 'upload', sourceId: filename, userId, sessionId })
    }
  }
}
