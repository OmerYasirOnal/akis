export interface RepoFile { filePath: string; content: string }

/**
 * In-memory stand-in for GitHub. Stores pushed files keyed by session so Trace
 * (dryRun) can read Proto's output. No network. Replaced by a real adapter in a
 * later sub-project (behind the same shape + the ApprovedPush push gate).
 */
export class MockGitHubAdapter {
  private store = new Map<string, RepoFile[]>()

  /** Idempotent: initializes the repo only if it does not exist (re-runs/iterate-safe). */
  async createRepo(sessionId: string): Promise<string> {
    if (!this.store.has(sessionId)) this.store.set(sessionId, [])
    return `https://github.com/mock/${sessionId}`
  }

  async pushFiles(sessionId: string, files: RepoFile[]): Promise<void> {
    const cur = this.store.get(sessionId) ?? []
    this.store.set(sessionId, [...cur, ...files])
  }

  read(sessionId: string): RepoFile[] {
    return [...(this.store.get(sessionId) ?? [])]
  }
}
