import { createHash } from 'node:crypto'

/** Pluggable text→vector seam. A real API-backed provider (reusing PR #2's catalog
 *  + KeyStore) drops in behind this later; the embedded default needs no network. */
export interface EmbeddingProvider {
  readonly dim: number
  embed(texts: string[]): Promise<number[][]>
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Two independent 32-bit hashes of a token (bucket index + sign), derived from sha1. */
function hashes(token: string): { idx: number; sign: number } {
  const h = createHash('sha1').update(token).digest()
  const idx = h.readUInt32BE(0)
  const sign = (h.readUInt32BE(4) & 1) === 0 ? 1 : -1
  return { idx, sign }
}

/**
 * Deterministic, offline embedding via signed feature hashing (bag-of-words →
 * fixed-dim, L2-normalized). No network, no key — RAG works out of the box and
 * the golden-eval gate is reproducible. Same text → identical vector. A real
 * semantic embedding model is a later drop-in behind EmbeddingProvider.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dim = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.embedOne(t))
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0)
    for (const tok of tokenize(text)) {
      const { idx, sign } = hashes(tok)
      v[idx % this.dim]! += sign
    }
    // L2-normalize so cosine == dot product; a zero vector stays zero.
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm)
    if (norm === 0) return v
    for (let i = 0; i < v.length; i++) v[i]! /= norm
    return v
  }
}
