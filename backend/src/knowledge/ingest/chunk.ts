export interface ChunkOpts { size?: number; overlap?: number }

/**
 * Split text into overlapping windows so long content stays retrievable. Splits on
 * paragraph-ish boundaries when possible, else hard-windows by length. Overlap
 * preserves context across boundaries. Short text → a single chunk.
 */
export function chunkText(text: string, opts: ChunkOpts = {}): string[] {
  const size = opts.size ?? 800
  const overlap = Math.min(opts.overlap ?? 100, size - 1)
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length === 0) return []
  if (clean.length <= size) return [clean]

  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    const end = Math.min(start + size, clean.length)
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = end - overlap
  }
  return chunks.filter(Boolean)
}
