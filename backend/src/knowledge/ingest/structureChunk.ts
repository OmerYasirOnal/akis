import { chunkText } from './chunk.js'

/** The structural class of a source, which selects the chunking strategy. */
export type ChunkKind = 'prose' | 'markdown' | 'spec' | 'code' | 'pdf'

const WINDOW = 800

/**
 * Structure-aware chunking (issue #7 AC4). Dispatches on `kind`:
 *  - prose / pdf      → paragraph-grouped windows (blank-line blocks packed up to WINDOW)
 *  - markdown / spec  → ATX-heading sections, each windowed if oversized
 *  - code             → heuristic top-level symbol split (brace/indent scan), each
 *                       symbol body kept intact when it fits, else windowed; falls
 *                       back to chunkText when no top-level symbol is detectable.
 *
 * AST-level parsing is deliberately DEFERRED (no new parser dep): the code path is a
 * line-scan heuristic, documented here as acceptable for the MVP. Every branch reuses
 * `chunkText` as the windowing primitive so behavior stays consistent with the rest of
 * the ingest pipeline. Empty / whitespace-only text → [].
 */
export function chunkByKind(text: string, kind: ChunkKind): string[] {
  const clean = text.replace(/\r\n/g, '\n')
  if (clean.trim().length === 0) return []
  switch (kind) {
    case 'markdown':
    case 'spec':
      return chunkMarkdown(clean)
    case 'code':
      return chunkCode(clean)
    case 'prose':
    case 'pdf':
    default:
      return chunkProse(clean)
  }
}

/** Window an already-isolated section, but only when it exceeds the window. Short
 *  sections stay as a single chunk so structural boundaries are preserved. */
function windowIfOversized(section: string): string[] {
  const s = section.trim()
  if (s.length === 0) return []
  if (s.length <= WINDOW) return [s]
  return chunkText(s, { size: WINDOW, overlap: 100 })
}

/** Prose: pack blank-line-separated paragraphs into windows up to WINDOW; an
 *  oversized single paragraph is hard-windowed. */
function chunkProse(text: string): string[] {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  if (paras.length === 0) return []
  const chunks: string[] = []
  let buf = ''
  const flush = (): void => { if (buf.trim()) chunks.push(buf.trim()); buf = '' }
  for (const para of paras) {
    if (para.length > WINDOW) {
      flush()
      chunks.push(...windowIfOversized(para))
      continue
    }
    if (buf.length === 0) { buf = para; continue }
    if (buf.length + 2 + para.length <= WINDOW) buf += '\n\n' + para
    else { flush(); buf = para }
  }
  flush()
  return chunks
}

/** Markdown / spec: split on ATX headings (`#`..`######`) into sections (heading +
 *  its body), each windowed if oversized. Content before the first heading is its
 *  own section. */
function chunkMarkdown(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let current: string[] = []
  const flush = (): void => {
    const joined = current.join('\n').trim()
    if (joined) sections.push(joined)
    current = []
  }
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) flush()
    current.push(line)
  }
  flush()
  if (sections.length === 0) return windowIfOversized(text)
  return sections.flatMap(windowIfOversized)
}

/** Top-level (column-0) symbol declaration heuristic. No AST: a line that begins a
 *  declaration in the column-0 position starts a new symbol block. */
const TOP_LEVEL_SYMBOL = /^(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|interface\b|type\b|enum\b|const\b|let\b|var\b|def\b|public\b|private\b|protected\b|func\b|fn\b)/

/** Code: group lines into top-level symbol blocks (a new block begins at each
 *  column-0 symbol declaration), keeping each body intact when it fits, windowing
 *  oversized bodies. Falls back to chunkText when no top-level symbol is found. */
function chunkCode(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let sawSymbol = false
  const flush = (): void => {
    const joined = current.join('\n').trim()
    if (joined) blocks.push(joined)
    current = []
  }
  for (const line of lines) {
    // A new top-level symbol begins only at column 0 (no leading whitespace).
    const isTopLevel = line.length > 0 && line === line.trimStart() && TOP_LEVEL_SYMBOL.test(line)
    if (isTopLevel) {
      if (sawSymbol) flush()
      sawSymbol = true
    }
    current.push(line)
  }
  flush()
  if (!sawSymbol) return chunkText(text, { size: WINDOW, overlap: 100 })
  return blocks.flatMap(windowIfOversized)
}
