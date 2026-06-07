import { describe, it, expect } from 'vitest'
import { buildGithubMcpToolsFromTransport, buildAtlassianMcpReadTools } from '../../src/agent/mcp/McpToolBridge.js'
import type { McpToolInfo, McpToolResult, McpTransport } from '../../src/agent/mcp/McpTransport.js'
import { GITHUB_READONLY_TOOLS, ATLASSIAN_READONLY_TOOLS } from '../../src/agent/mcp/readOnlyAllowlist.js'

/**
 * GATE-SAFETY is the spine of this module, so the whole test uses a FAKE McpTransport —
 * NO Docker, NO network, NO `@modelcontextprotocol/sdk`. The fake is the seam the real
 * StdioDockerTransport will sit behind in prod; here it lets us script exactly what the
 * server "advertises" and how a call resolves/rejects, then assert what survives the bridge.
 */

/** How the fake should answer one `callTool` (per tool name), so a test can pin
 *  result-passthrough, server-side error flags, and transport rejects independently. */
type CallBehavior =
  | { kind: 'ok'; result: McpToolResult }
  | { kind: 'reject'; error: unknown }

interface FakeOpts {
  /** What `listTools()` advertises. */
  tools: McpToolInfo[]
  /** If set, `listTools()` REJECTS with this (simulates a handshake/list failure). */
  listToolsError?: unknown
  /** Per-tool-name call behavior; absent ⇒ a benign ok echo. */
  calls?: Record<string, CallBehavior>
}

interface FakeTransport extends McpTransport {
  /** Every (name,args) pair the bridge actually forwarded to the transport, in order.
   *  Lets us prove the bridge calls the UNNAMESPACED server name and passes args through. */
  readonly callLog: ReadonlyArray<{ name: string; args: unknown }>
}

/** Build a scripted FAKE transport. initialize/close are inert no-ops here — the bridge
 *  consumes an ALREADY-initialized transport, so they are out of this module's contract. */
function fakeTransport(opts: FakeOpts): FakeTransport {
  const callLog: { name: string; args: unknown }[] = []
  return {
    callLog,
    async initialize() {
      /* the bridge never calls this; present only to satisfy the seam */
    },
    async listTools() {
      if ('listToolsError' in opts && opts.listToolsError !== undefined) throw opts.listToolsError
      return opts.tools
    },
    async callTool(name, args) {
      callLog.push({ name, args })
      const behavior = opts.calls?.[name]
      if (behavior?.kind === 'reject') throw behavior.error
      if (behavior?.kind === 'ok') return behavior.result
      return { text: `echo:${name}`, isError: false }
    },
    async close() {
      /* inert */
    },
  }
}

/** A tool info with a description/schema so we can assert they survive onto the spec. */
function info(name: string, description = `desc:${name}`, inputSchema: unknown = { type: 'object' }): McpToolInfo {
  return { name, description, inputSchema }
}

/** Capturing diagnostic sink — records every emitted line so we can assert names-only,
 *  count, and that it stays SILENT when nothing is dropped. */
function captureDiag(): { lines: string[]; diag: (msg: string) => void } {
  const lines: string[] = []
  return { lines, diag: msg => lines.push(msg) }
}

describe('McpToolBridge.buildGithubMcpToolsFromTransport', () => {
  it('surfaces ONLY allow-listed tools, each namespaced under github_ with desc+schema carried through', async () => {
    const schema = { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] }
    const transport = fakeTransport({
      tools: [info('get_file_contents', 'read a file', schema), info('list_commits'), info('search_code')],
    })

    const tools = await buildGithubMcpToolsFromTransport(transport)

    expect(tools.map(t => t.spec.name).sort()).toEqual(
      ['github_get_file_contents', 'github_list_commits', 'github_search_code'].sort(),
    )
    const gf = tools.find(t => t.spec.name === 'github_get_file_contents')
    expect(gf).toBeDefined()
    // description + the OPAQUE inputSchema are passed straight onto the spec (not rewritten).
    expect(gf?.spec.description).toBe('read a file')
    expect(gf?.spec.schema).toBe(schema)
  })

  it('GATE-SAFETY: a server advertising WRITE/mutation tools surfaces NONE of them', async () => {
    // The exact write names the prompt forbids ever reaching an agent. Even if the server
    // (mis)advertises them — independent of its own --read-only flag — the positive allow-list
    // intersection makes them STRUCTURALLY absent.
    const writeNames = [
      'push_files',
      'create_or_update_file',
      'create_pull_request',
      'merge_pull_request',
      'create_branch',
      'fork_repository',
      'update_issue',
      'create_issue',
      'create_repository',
    ]
    const transport = fakeTransport({
      tools: [info('get_file_contents'), ...writeNames.map(n => info(n))],
    })

    const tools = await buildGithubMcpToolsFromTransport(transport)

    const surfaced = tools.map(t => t.spec.name)
    expect(surfaced).toEqual(['github_get_file_contents'])
    // Belt-and-braces: not one write name appears, under any namespacing.
    for (const w of writeNames) {
      expect(surfaced).not.toContain(`github_${w}`)
      expect(surfaced).not.toContain(w)
    }
  })

  it('admits every name on the frozen allow-list and nothing else', async () => {
    // Feed the WHOLE allow-list plus a couple of impostors; the surfaced set must equal the
    // allow-list (namespaced), proving the intersection is exactly the frozen set.
    const allow = [...GITHUB_READONLY_TOOLS]
    const transport = fakeTransport({
      tools: [...allow.map(n => info(n)), info('delete_repository'), info('set_default_branch')],
    })

    const tools = await buildGithubMcpToolsFromTransport(transport)

    expect(tools.map(t => t.spec.name).sort()).toEqual(allow.map(n => `github_${n}`).sort())
  })

  it('forwards a call under the UNNAMESPACED server name, passes args through, and returns the result text', async () => {
    const transport = fakeTransport({
      tools: [info('search_code')],
      calls: { search_code: { kind: 'ok', result: { text: 'found 3 hits', isError: false } } },
    })
    const tools = await buildGithubMcpToolsFromTransport(transport)
    const search = tools.find(t => t.spec.name === 'github_search_code')
    expect(search).toBeDefined()

    const out = await search!.handler({ q: 'TODO' })

    expect(out).toBe('found 3 hits')
    // The bridge must strip the github_ namespace before hitting the wire, and pass args verbatim.
    expect(transport.callLog).toEqual([{ name: 'search_code', args: { q: 'TODO' } }])
  })

  it('turns a server-side error result (isError:true) into an honest Error STRING, never a throw', async () => {
    const transport = fakeTransport({
      tools: [info('get_file_contents')],
      calls: { get_file_contents: { kind: 'ok', result: { text: 'not found: 404', isError: true } } },
    })
    const tools = await buildGithubMcpToolsFromTransport(transport)
    const tool = tools[0]
    expect(tool).toBeDefined()

    const out = await tool!.handler({ path: 'x' })

    // Honest absence-of-success: a string the model can read, naming the tool + carrying the text.
    expect(out).toMatch(/^Error/)
    expect(out).toContain('get_file_contents')
    expect(out).toContain('not found: 404')
  })

  it('GRACEFUL DEGRADE: a callTool REJECT becomes an Error string (no throw into the tool loop)', async () => {
    const transport = fakeTransport({
      tools: [info('list_commits')],
      calls: { list_commits: { kind: 'reject', error: new Error('stdio pipe closed') } },
    })
    const tools = await buildGithubMcpToolsFromTransport(transport)
    const tool = tools[0]
    expect(tool).toBeDefined()

    // The promise RESOLVES (never rejects) so the tool loop is never thrown into.
    const out = await tool!.handler({})

    expect(out).toMatch(/^Error calling github-mcp tool 'list_commits'/)
    expect(out).toContain('stdio pipe closed')
  })

  it('finding #11: BOUNDS a huge tool result so a large file read cannot flood the LLM context', async () => {
    // A whole-file read (get_file_contents) can return a giant payload; the bridge must cap it so
    // it never blows the model context / spikes token quota (the RAG path is bounded; this matches).
    const huge = 'x'.repeat(50_000)
    const transport = fakeTransport({
      tools: [info('get_file_contents')],
      calls: { get_file_contents: { kind: 'ok', result: { text: huge, isError: false } } },
    })
    const tools = await buildGithubMcpToolsFromTransport(transport)
    const out = await tools[0]!.handler({ path: 'big.lock' })

    // Capped well below the raw payload, with an explicit, model-readable truncation marker.
    expect(out.length).toBeLessThan(huge.length)
    expect(out.length).toBeLessThanOrEqual(16_000 + 100) // budget + the short marker line
    expect(out).toMatch(/truncated: tool output exceeded 16000 chars/)
  })

  it('finding #11: a SMALL tool result is returned verbatim (no truncation marker, no clipping)', async () => {
    const small = 'README contents: a tidy little app.'
    const transport = fakeTransport({
      tools: [info('get_file_contents')],
      calls: { get_file_contents: { kind: 'ok', result: { text: small, isError: false } } },
    })
    const tools = await buildGithubMcpToolsFromTransport(transport)
    const out = await tools[0]!.handler({ path: 'README.md' })
    expect(out).toBe(small)
    expect(out).not.toMatch(/truncated/)
  })

  it('GRACEFUL DEGRADE: a non-Error reject is stringified safely (still no throw)', async () => {
    const transport = fakeTransport({
      tools: [info('list_issues')],
      calls: { list_issues: { kind: 'reject', error: 'raw-string-failure' } },
    })
    const tools = await buildGithubMcpToolsFromTransport(transport)
    const tool = tools[0]
    expect(tool).toBeDefined()

    const out = await tool!.handler({})

    expect(out).toMatch(/^Error calling github-mcp tool 'list_issues'/)
    expect(out).toContain('raw-string-failure')
  })

  it('GRACEFUL DEGRADE: listTools() failure ⇒ [] (honest absence, never a crash)', async () => {
    const transport = fakeTransport({ tools: [], listToolsError: new Error('docker daemon not running') })
    await expect(buildGithubMcpToolsFromTransport(transport)).resolves.toEqual([])
  })

  it('empty advertised set ⇒ [] (agent simply gets no github tools)', async () => {
    const transport = fakeTransport({ tools: [] })
    await expect(buildGithubMcpToolsFromTransport(transport)).resolves.toEqual([])
  })

  it('a server that advertises ONLY non-allow-listed tools ⇒ [] (empty intersection)', async () => {
    const transport = fakeTransport({ tools: [info('push_files'), info('merge_pull_request')] })
    await expect(buildGithubMcpToolsFromTransport(transport)).resolves.toEqual([])
  })

  it('OBSERVABILITY: emits ONE name-only diagnostic listing the dropped tools + the allow-list size', async () => {
    const { lines, diag } = captureDiag()
    const transport = fakeTransport({
      tools: [info('get_file_contents'), info('push_files'), info('merge_pull_request')],
    })

    await buildGithubMcpToolsFromTransport(transport, diag)

    expect(lines).toHaveLength(1)
    const msg = lines[0]
    expect(msg).toBeDefined()
    expect(msg).toContain('dropped 2')
    expect(msg).toContain('push_files')
    expect(msg).toContain('merge_pull_request')
    expect(msg).toContain(String(GITHUB_READONLY_TOOLS.size))
    // The allow-listed name that SURVIVED must NOT appear in the "dropped" line.
    expect(msg).not.toContain('get_file_contents')
  })

  it('OBSERVABILITY: stays SILENT when every advertised tool is on the allow-list', async () => {
    const { lines, diag } = captureDiag()
    const transport = fakeTransport({ tools: [info('get_file_contents'), info('list_commits')] })

    await buildGithubMcpToolsFromTransport(transport, diag)

    expect(lines).toEqual([])
  })

  it('SECRETS: the diagnostic carries names/counts ONLY — never anything resembling a token/arg', async () => {
    // A token would never be a tool NAME, but this pins the contract: the diag echoes the
    // dropped names and the count, and nothing it was not given. We give a name-shaped string
    // and assert the line is composed purely of the names + the fixed boilerplate.
    const { lines, diag } = captureDiag()
    const transport = fakeTransport({ tools: [info('get_file_contents'), info('definitely_a_write_tool')] })

    await buildGithubMcpToolsFromTransport(transport, diag)

    expect(lines).toHaveLength(1)
    const msg = lines[0] ?? ''
    // Only the dropped name (not the surviving read name) and the boilerplate appear.
    expect(msg).toContain('definitely_a_write_tool')
    expect(msg).not.toContain('get_file_contents')
  })

  it('PORTABILITY: the bridge consumes an already-initialized transport (it never calls initialize)', async () => {
    let initCalled = false
    const base = fakeTransport({ tools: [info('search_code')] })
    const transport: McpTransport = {
      ...base,
      async initialize() {
        initCalled = true
      },
    }
    await buildGithubMcpToolsFromTransport(transport)
    expect(initCalled).toBe(false)
  })
})

describe('McpToolBridge.buildAtlassianMcpReadTools (audit #17/#32/#45 — read grounding)', () => {
  it('admits ONLY Atlassian read tools (atlassian_ namespace); write/mutation tools NEVER register', async () => {
    const writeNames = ['createConfluencePage', 'updateConfluencePage', 'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addCommentToJiraIssue']
    const transport = fakeTransport({ tools: [info('getConfluencePage'), info('searchJiraIssuesUsingJql'), ...writeNames.map(n => info(n))] })
    const tools = await buildAtlassianMcpReadTools(transport)
    const surfaced = tools.map(t => t.spec.name).sort()
    expect(surfaced).toEqual(['atlassian_getConfluencePage', 'atlassian_searchJiraIssuesUsingJql'])
    for (const w of writeNames) {
      expect(surfaced).not.toContain(`atlassian_${w}`)
      expect(surfaced).not.toContain(w) // never under any namespacing
    }
  })

  it('forwards the UNNAMESPACED server name + passes args through; bounds the result', async () => {
    const transport = fakeTransport({
      tools: [info('getConfluencePage')],
      calls: { getConfluencePage: { kind: 'ok', result: { text: 'page body', isError: false } } },
    })
    const [tool] = await buildAtlassianMcpReadTools(transport)
    const out = await tool!.handler({ pageId: '123' })
    expect(out).toBe('page body')
    expect(transport.callLog).toEqual([{ name: 'getConfluencePage', args: { pageId: '123' } }]) // unnamespaced
  })

  it('LIVE-DISCOVERY harness: the dropped-tool diagnostic logs the server\'s advertised names (token-free)', async () => {
    const msgs: string[] = []
    const transport = fakeTransport({ tools: [info('getJiraIssue'), info('createJiraIssue'), info('someBrandNewTool')] })
    await buildAtlassianMcpReadTools(transport, m => msgs.push(m))
    const joined = msgs.join('\n')
    expect(joined).toMatch(/atlassian-mcp: dropped 2/)
    // the real advertised (but unallowed) names appear → the owner can reconcile the allow-list
    expect(joined).toContain('createJiraIssue')
    expect(joined).toContain('someBrandNewTool')
    expect(joined).toContain(`allow-list has ${ATLASSIAN_READONLY_TOOLS.size} read tools`)
  })
})
