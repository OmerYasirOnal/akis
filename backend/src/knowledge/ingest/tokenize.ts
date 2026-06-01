/** Shared tokenizer for BOTH the embedder and BM25, so the lexical and vector
 *  views never drift apart. Lowercase, split on non-alphanumeric, drop empties. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}
