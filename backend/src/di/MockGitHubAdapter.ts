export interface RepoFile { filePath: string; content: string }

/**
 * The push seam consumed by the push gate (`pushToGitHub`) and the orchestrator.
 * BOTH the in-memory `MockGitHubAdapter` (default) and the opt-in
 * `RealGitHubAdapter` (real GitHub REST) implement this, so the real adapter is
 * reachable ONLY through the unchanged `ApprovedPush`-gated push path — there is
 * no new bypass. `createRepo` returns a destination URL; `pushFiles` publishes the
 * verified file set. The gate calls these AFTER minting a valid ApprovedPush.
 */
export interface GitHubAdapter {
  createRepo(sessionId: string): Promise<string>
  pushFiles(sessionId: string, files: RepoFile[]): Promise<void>
  /** In-memory read-back of the last pushed set for a session. The mock keeps a real
   *  store; the RealGitHubAdapter has no local store and returns `[]` (reads belong to
   *  the RAG real reader, a separate AKIS_GITHUB_TOKEN concern). Used by the gate
   *  contract/orchestrator assertions to prove the mock recorded a push. */
  read(sessionId: string): RepoFile[]
}

/**
 * In-memory stand-in for GitHub. Stores the pushed file set keyed by session.
 * No network. The opt-in `RealGitHubAdapter` (real GitHub REST) is the production
 * counterpart behind the SAME `GitHubAdapter` shape + the ApprovedPush push gate;
 * this mock stays the default for tests/demo.
 *
 * `pushFiles` REPLACES the session's file set (it is idempotent: pushing the
 * same verified set twice leaves one copy, not two). The push gate already
 * blocks a second push via the status guard; this makes the adapter safe even
 * if called again.
 */
export class MockGitHubAdapter implements GitHubAdapter {
  private store = new Map<string, RepoFile[]>()

  async createRepo(sessionId: string): Promise<string> {
    if (!this.store.has(sessionId)) this.store.set(sessionId, [])
    return `https://github.com/mock/${sessionId}`
  }

  async pushFiles(sessionId: string, files: RepoFile[]): Promise<void> {
    this.store.set(sessionId, [...files])
  }

  read(sessionId: string): RepoFile[] {
    return [...(this.store.get(sessionId) ?? [])]
  }
}
