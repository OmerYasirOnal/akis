import type { SpecArtifact } from '@akis/shared'
import type { RagService } from '../RagService.js'
import { chunkByKind } from './structureChunk.js'
import { shouldExclude } from './exclude.js'

export interface SpecSourceDeps {
  rag: RagService
}

export interface SpecIngestInput {
  sessionId: string
  userId: string
  spec: SpecArtifact
}

/**
 * Agent-output ingestion source (issue #168): the APPROVED spec (Scribe's structured output)
 * as trusted RAG grounding. Fills the gap where a build's own spec was never ingested — the
 * conversation source only mapped narration `text`, and RepoSource only ever ingested pushed
 * REPO files, not the spec itself.
 *
 * TRUSTED, not ephemeral: the spec is ingested at the human spec-approval boundary
 * (Orchestrator.mintSpecApproval), so it is human-approved content, eligible grounding —
 * unlike free-form advisory/LLM narration (which the IngestionSink deliberately never ingests).
 * Every chunk still runs through shouldExclude so a spec that somehow embeds a secret never
 * reaches the corpus, and each chunk is stamped with the {userId,sessionId} tenancy.
 *
 * source:'agent-spec' / sourceId:sessionId — so right-to-forget can target it via
 * deleteBySource('agent-spec', sessionId) and it is distinct from 'repo'/'upload'/'conversation'.
 *
 * NOTE on scope: the generated CODE is deliberately NOT ingested here — it is already ingested
 * by RepoSource on confirmPush (source:'repo'), so an 'agent-code' source would duplicate those
 * chunks in the corpus (RagService dedups by contentHash, which includes the source, so the same
 * file under two sources is NOT deduped). The spec is the one agent artifact never otherwise
 * ingested. Holds NO gate capability.
 */
export class SpecSource {
  constructor(private deps: SpecSourceDeps) {}

  ingest(input: SpecIngestInput): void {
    const { sessionId, userId, spec } = input
    // Carry the title as a heading so a chunk without it still reads as "the spec for X".
    const body = spec.title.trim() ? `# ${spec.title.trim()}\n\n${spec.body}` : spec.body
    if (!body.trim()) return
    // Secret exclusion BEFORE chunking (F1-AC12) — a spec should never carry a secret, but be
    // consistent with RepoSource. Use a synthetic 'spec.md' source so path-based rules are sane.
    if (shouldExclude(body, 'spec.md').excluded) return
    for (const text of chunkByKind(body, 'spec')) {
      if (text.trim()) this.deps.rag.ingest({ text, source: 'agent-spec', sourceId: sessionId, userId, sessionId })
    }
  }
}
