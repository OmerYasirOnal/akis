import { createHash } from 'node:crypto'

/** Stable content hash → the chunk id, so re-ingesting identical content within the
 *  same provenance scope dedups (F1-AC3). Length-prefixed to avoid concatenation
 *  collisions between the scoping fields. */
export function contentHash(text: string, scope: { userId: string; source: string; sourceId: string }): string {
  const h = createHash('sha256')
  for (const part of [scope.userId, scope.source, scope.sourceId, text]) {
    h.update(String(part.length))
    h.update('\0')
    h.update(part)
  }
  return h.digest('hex')
}
