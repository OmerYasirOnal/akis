import matter from 'gray-matter'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import type { ChunkKind } from '../structureChunk.js'

/** Thrown when an upload is unsupported (unknown type) or unusable (binary / unparsable
 *  PDF). The route maps this to 415; a Source aborts ingest without touching the corpus.
 *  Carries NO gate authority — it is purely an input-validation signal. */
export class UploadParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadParseError'
  }
}

export interface UploadInput {
  filename: string
  /** Optional declared MIME (from the multipart part); used to recognise PDFs when the
   *  filename has no/wrong extension. */
  mime?: string
  bytes: Buffer
}

export interface ParsedUpload {
  /** Extracted, frontmatter-stripped text ready for structure-chunking. */
  text: string
  /** The structural class, so the Source can pick the right chunking strategy. */
  kind: ChunkKind
  filename: string
}

/** Fraction of non-printable chars above which decoded text is treated as binary. */
const BINARY_RATIO = 0.3

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx'])
const TEXT_EXT = new Set(['txt', 'text', 'rst', 'adoc', 'log'])
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb',
  'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'scala', 'sh', 'sql',
])

type DetectedType = 'markdown' | 'text' | 'code' | 'pdf'

/**
 * Detect the upload kind from filename/mime and parse the bytes to plain text (issue #7
 * AC2). The allowlist is {markdown, plain text, PDF} (code extensions are accepted as a
 * text-like superset) — everything else → UploadParseError (the route maps to 415).
 *
 *  - markdown → gray-matter strips YAML frontmatter, keeps the body
 *  - text / code → UTF-8 passthrough (binary content is rejected, never embedded)
 *  - pdf → pdf-parse extracted text (a parse failure → UploadParseError, surfaced
 *          synchronously as 415; parsing is inline, so it never crashes the route)
 *
 * Uploads are TRUSTED SOURCE content; this only extracts text — exclusion of
 * secrets/binary at embed time is the Source's job via shouldExclude.
 */
export async function parseUpload(input: UploadInput): Promise<ParsedUpload> {
  const type = detectType(input.filename, input.mime)
  if (type === 'pdf') {
    const text = await parsePdf(input.bytes)
    return { text, kind: 'pdf', filename: input.filename }
  }

  const raw = input.bytes.toString('utf8')
  if (isBinary(raw)) {
    throw new UploadParseError(`binary content rejected: ${input.filename}`)
  }
  if (type === 'markdown') {
    // gray-matter strips YAML frontmatter; the body is what we ingest (frontmatter is
    // metadata, not retrievable prose, and can carry config we don't want embedded).
    const { content } = matter(raw)
    return { text: content.trim(), kind: 'markdown', filename: input.filename }
  }
  if (type === 'code') {
    return { text: raw, kind: 'code', filename: input.filename }
  }
  // type === 'text'
  return { text: raw, kind: 'prose', filename: input.filename }
}

function detectType(filename: string, mime?: string): DetectedType {
  const m = (mime ?? '').toLowerCase()
  if (m === 'application/pdf' || m === 'application/x-pdf') return 'pdf'
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext === 'pdf') return 'pdf'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (CODE_EXT.has(ext)) return 'code'
  if (TEXT_EXT.has(ext)) return 'text'
  if (m === 'text/markdown') return 'markdown'
  if (m.startsWith('text/')) return 'text'
  throw new UploadParseError(`unsupported upload type: ${filename}${mime ? ` (${mime})` : ''}`)
}

async function parsePdf(bytes: Buffer): Promise<string> {
  try {
    const result = await pdfParse(bytes)
    const text = result.text.trim()
    if (text.length === 0) throw new Error('no extractable text')
    return text
  } catch (err) {
    // A malformed/encrypted/empty PDF must never crash the route — surface a typed
    // error the caller returns as 415. Parsing is inline (before any enqueue), so a bad
    // upload never reaches the queue / a dead-letter path.
    throw new UploadParseError(`pdf parse failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Binary = a high fraction of non-printable (control, non-tab/newline) characters. */
function isBinary(text: string): boolean {
  if (text.length === 0) return false
  let nonPrintable = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const printable = c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)
    if (!printable) nonPrintable++
  }
  return nonPrintable / text.length > BINARY_RATIO
}
