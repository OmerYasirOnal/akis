/**
 * Test helpers that build gate tokens ONLY through the legitimate public seams
 * (factory + capability), never through a forging import. This mirrors exactly
 * what production does, so tests cannot accidentally rely on a bypass that the
 * un-exported minters now forbid.
 */
import type { VerifyToken, ApprovalToken, SpecArtifact } from '@akis/shared'
import { createMockTestRunner, type TestRunConfig } from '../../src/verify/TestRunner.js'
import { resolveVerifier } from '../../src/verify/verifier.js'
import { createApprovalAuthority } from '../../src/gates/specGate.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

/** Run the real verifier over `files` with a configured mock runner — through the ONLY
 *  public Verifier seam (resolveVerifier); `createVerifier` is no longer importable (B2). */
export async function verifyWith(sessionId: string, files: RepoFile[], cfg: TestRunConfig): Promise<VerifyToken | null> {
  return resolveVerifier({ kind: 'mock', cfg }).verify(sessionId, files)
}

/** Mint an approval token the legitimate way (the orchestrator's authority). */
export function approveSpec(spec: SpecArtifact): ApprovalToken {
  return createApprovalAuthority().approve(spec)
}

export { createMockTestRunner }
