/**
 * Minimal ambient types for `pdf-parse` (the package ships no type defs). We import the
 * inner `lib/pdf-parse.js` directly (NOT the package root) on purpose: the root
 * `index.js` runs a debug block that reads a bundled test PDF when `module.parent` is
 * falsy — under ESM that fires on import and crashes. The lib entry is the pure parser.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    /** Number of pages parsed. */
    numpages: number
    /** Extracted text content of the document. */
    text: string
    /** Document info dictionary (title, author, …), or null. */
    info: unknown
    /** XMP metadata, or null. */
    metadata: unknown
    /** pdf.js version used. */
    version: string
  }
  interface PdfParseOptions {
    /** Max pages to parse (0 → all). */
    max?: number
    version?: string
  }
  function pdfParse(data: Buffer | Uint8Array, options?: PdfParseOptions): Promise<PdfParseResult>
  export = pdfParse
}
