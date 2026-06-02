import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import type { SessionStore } from '../store/SessionStore.js'
import type { UploadSource } from '../knowledge/ingest/UploadSource.js'
import type { RepoSource } from '../knowledge/ingest/RepoSource.js'
import { UploadParseError } from '../knowledge/ingest/parse/parseUpload.js'

export interface KnowledgeRoutesDeps {
  store: SessionStore
  /** Upload ingestion source (issue #7 AC2). Trusted SOURCE content (NOT ephemeral). */
  uploadSource: UploadSource
  /** Repo ingestion source (issue #7 AC1) — incremental by head sha. */
  repoSource: RepoSource
  /** The tenancy resolver the RAG port retrieves with — ingestion MUST stamp the same
   *  {userId,sessionId} so the write is retrievable through the port (round-trip). */
  ragUserIdFor: (sessionId: string) => string
  /** Resolve the authenticated user id from a request (undefined when unauthenticated)
   *  — for owner-scoping, exactly like sessions.routes. */
  userIdOf?: (req: FastifyRequest) => string | undefined
  /** Per-upload size ceiling in bytes (413 above it). */
  uploadMaxBytes: number
}

/** Default upload ceiling: 5 MiB. A self-hostable knowledge store should accept a sizable
 *  PDF/markdown doc but never an unbounded body (DoS / memory). Override via env. */
export const DEFAULT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024

/**
 * Knowledge ingestion routes (issue #7) — registered ONLY when the RAG stack is present.
 * Holds NO gate authority (the 4 structural gates A–F are untouched): it only feeds
 * TRUSTED SOURCE content (uploads + repo files) into rag.ingest off the agent path.
 *
 * Owner-scoped exactly like sessions.routes' accessibleSession: a session that carries an
 * `ownerId` is private — a non-owner (or anonymous caller for an owned session) gets a 404
 * that HIDES the session's existence, never a 403. An anonymous session (no ownerId) stays
 * open for backward compatibility.
 *
 * Async by contract (F1-AC7): ingestion is enqueued off the request path, so a successful
 * upload returns 202 Accepted (the chunks embed on the queue worker). A parse failure
 * (unsupported/binary/unparsable) → 415 and NOTHING is ingested. An oversized body → 413
 * (the multipart size limit, enforced before the bytes are buffered).
 */
export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRoutesDeps): void {
  // Register the multipart parser bounded by the size limit. throwFileSizeLimit (default)
  // surfaces a 413-coded RequestFileTooLargeError when toBuffer() exceeds fileSize — so an
  // oversized body is rejected before we ever ingest it. The route contract is a SINGLE
  // `file` part with no form fields, so bound fields/parts too (defense-in-depth: a client
  // can't flood the request with many small non-file fields).
  void app.register(fastifyMultipart, { limits: { fileSize: deps.uploadMaxBytes, files: 1, fields: 0, parts: 1 } })

  const notFound = (reply: FastifyReply, id: string): FastifyReply =>
    reply.code(404).send({ error: `session ${id} not found`, code: 'NotFound' })

  // Owner-scope: returns the userId to stamp ingestion with when the caller may access the
  // session, else null → the caller replies 404 (a non-owner can't even confirm existence).
  const accessibleUserId = async (req: FastifyRequest, id: string): Promise<string | null> => {
    const s = await deps.store.get(id)
    if (!s) return null
    if (s.ownerId && deps.userIdOf?.(req) !== s.ownerId) return null
    // Stamp ingestion with the SAME tenant the RAG port retrieves under, so the write is
    // retrievable through the port (single-user MVP → a constant resolver).
    return deps.ragUserIdFor(id)
  }

  app.post<{ Params: { id: string } }>('/sessions/:id/knowledge/uploads', async (req, reply) => {
    const id = req.params.id
    const userId = await accessibleUserId(req, id)
    if (userId === null) return notFound(reply, id)

    // The body must be multipart with a single `file` part.
    if (!req.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data required', code: 'UnsupportedMediaType' })

    let filename: string
    let mime: string
    let bytes: Buffer
    try {
      const part = await req.file()
      if (!part) return reply.code(415).send({ error: 'no file part in upload', code: 'UnsupportedMediaType' })
      filename = part.filename
      mime = part.mimetype
      // toBuffer() throws RequestFileTooLargeError (413) when the part exceeds fileSize.
      bytes = await part.toBuffer()
    } catch (err) {
      if (err instanceof Error && (err as { statusCode?: number }).statusCode === 413) {
        return reply.code(413).send({ error: 'upload too large', code: 'PayloadTooLarge' })
      }
      throw err
    }

    // Parse + structure-chunk + ingest. An unsupported/binary/unparsable upload throws
    // UploadParseError → 415 and the corpus is never mutated (the Source aborts cleanly).
    try {
      await deps.uploadSource.ingest({ sessionId: id, userId, filename, bytes, mime })
    } catch (err) {
      if (err instanceof UploadParseError) {
        return reply.code(415).send({ error: err.message, code: 'UnsupportedMediaType' })
      }
      throw err
    }
    // Accepted: chunks embed asynchronously on the queue worker (F1-AC7).
    return reply.code(202).send({ status: 'accepted', sourceId: filename })
  })

  // Optional: trigger an incremental repo ingestion pass (issue #7 AC1). Owner-scoped.
  // Idempotent — an unchanged head sha is a whole-pass skip inside RepoSource.
  app.post<{ Params: { id: string } }>('/sessions/:id/knowledge/repo', async (req, reply) => {
    const id = req.params.id
    const userId = await accessibleUserId(req, id)
    if (userId === null) return notFound(reply, id)
    await deps.repoSource.ingest({ sessionId: id, userId })
    return reply.code(202).send({ status: 'accepted' })
  })
}
