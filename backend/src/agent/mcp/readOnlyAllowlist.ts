/**
 * GATE-SAFETY core (SP1 is READ-ONLY): a FROZEN positive allow-list of the GitHub-MCP
 * tool names an agent is permitted to call. This is the defense-in-depth check at the
 * bridge — INDEPENDENT of the server's own `GITHUB_READ_ONLY=1` flag — so a tool not on
 * this set can NEVER surface to an agent even if the server (mis)advertises it.
 *
 * The names below are rebuilt from the read tools the PINNED github-mcp-server image
 * (see StdioDockerTransport.IMAGE) actually advertises under the
 * `repos,issues,pull_requests` toolsets. DO NOT add a name the pinned tag does not
 * advertise — the bridge intersects listTools() ∩ this set, so a stale name is simply
 * inert, but keeping the set honest is what the snapshot test guards.
 *
 * DEFENSE-IN-DEPTH NUANCE (issue/PR reads): `issue_read` and `pull_request_read` are
 * CONSOLIDATED method-dispatchers — a single tool whose behavior is selected by a `method`
 * arg. Their read-only-ness for SP1 therefore ALSO relies on the server being started with
 * `GITHUB_READ_ONLY=1` (StdioDockerTransport sets it). We do NOT claim the allow-list alone
 * is fully-independent defense for THOSE TWO. Every OTHER name on this set is a structurally
 * read-only, single-purpose tool (a GET/search) — for those the allow-list IS independent
 * defense-in-depth.
 *
 * No write/mutation name (push_files, create_or_update_file, create_pull_request,
 * merge_pull_request, create_branch, fork_repository, update_issue, …) appears here, so
 * it can never register — this is structural, not conditional.
 */
export const GITHUB_READONLY_TOOLS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    // ── Repository / code reads (structurally read-only, single-purpose) ──
    'get_file_contents',
    'search_code',
    'search_repositories',
    'list_commits',
    'get_commit',
    'list_branches',
    'list_tags',
    // ── Pull-request / issue list + search reads (structurally read-only) ──
    'list_pull_requests',
    'list_issues',
    'search_issues',
    // ── Consolidated read dispatchers (read-only ALSO relies on GITHUB_READ_ONLY=1) ──
    'issue_read',
    'pull_request_read',
  ]),
) as ReadonlySet<string>

/** True iff `name` is on the positive read-only allow-list. The single predicate the
 *  bridge uses to admit a server-advertised tool. */
export function isReadOnlyTool(name: string): boolean {
  return GITHUB_READONLY_TOOLS.has(name)
}
