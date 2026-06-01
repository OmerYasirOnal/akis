export interface RepoFile { filePath: string; content: string }

/**
 * In-memory stand-in for GitHub. Stores the pushed file set keyed by session.
 * No network. Replaced by a real adapter in a later sub-project (behind the same
 * shape + the ApprovedPush push gate).
 *
 * `pushFiles` REPLACES the session's file set (it is idempotent: pushing the
 * same verified set twice leaves one copy, not two). The push gate already
 * blocks a second push via the status guard; this makes the adapter safe even
 * if called again.
 */
export class MockGitHubAdapter {
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
