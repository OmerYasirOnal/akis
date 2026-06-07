import { describe, it, expect } from 'vitest'
import { buildAtlassianMcpTools } from '../../src/agent/tools/atlassianMcpTools.js'
import { buildAdvisoryToolsWithGithub } from '../../src/agent/tools/advisoryTools.js'
import type { McpToolInfo, McpToolResult, McpTransport } from '../../src/agent/mcp/McpTransport.js'

/** A scripted fake McpTransport — NO network. initialize/close track state so we can assert the
 *  transport is closed on every honest-absence path AND held-then-closed when tools exist. */
interface FakeTransport extends McpTransport {
  readonly state: { initialized: boolean; closed: boolean; closes: number }
}
function fakeTransport(opts: { tools?: McpToolInfo[]; initError?: unknown; listError?: unknown; call?: McpToolResult } = {}): FakeTransport {
  const state = { initialized: false, closed: false, closes: 0 }
  return {
    state,
    async initialize() { if (opts.initError) throw opts.initError; state.initialized = true },
    async listTools() { if (opts.listError) throw opts.listError; return opts.tools ?? [] },
    async callTool() { return opts.call ?? { text: 'ok', isError: false } },
    async close() { state.closed = true; state.closes++ },
  }
}
const info = (name: string): McpToolInfo => ({ name, description: `d:${name}`, inputSchema: { type: 'object' } })

describe('buildAtlassianMcpTools (audit #17 — agent-side read-tool plumbing)', () => {
  it('admits ONLY allow-listed READ tools (atlassian_ namespace); writes never surface', async () => {
    const t = fakeTransport({ tools: [info('getConfluencePage'), info('searchJiraIssuesUsingJql'), info('createJiraIssue'), info('updateConfluencePage')] })
    const { tools, release } = await buildAtlassianMcpTools({ transport: t })
    const names = tools.map(x => x.spec.name).sort()
    expect(names).toEqual(['atlassian_getConfluencePage', 'atlassian_searchJiraIssuesUsingJql'])
    expect(t.state.initialized).toBe(true)
    release()
    expect(t.state.closed).toBe(true) // release closes the held transport
  })

  it('release is idempotent (a double-call closes only once)', async () => {
    const t = fakeTransport({ tools: [info('getJiraIssue')] })
    const { release } = await buildAtlassianMcpTools({ transport: t })
    release(); release()
    expect(t.state.closes).toBe(1)
  })

  it('initialize failure → honest absence ({tools:[], noop release}), transport closed, no crash', async () => {
    const t = fakeTransport({ initError: new Error('connection refused') })
    const { tools, release } = await buildAtlassianMcpTools({ transport: t, diag: () => {} })
    expect(tools).toEqual([])
    expect(t.state.closed).toBe(true)
    expect(() => release()).not.toThrow()
  })

  it('empty allow-list intersection → no tools, transport closed immediately (no loop to hold for)', async () => {
    const t = fakeTransport({ tools: [info('createJiraIssue'), info('someUnknownTool')] }) // no allow-listed reads
    const { tools } = await buildAtlassianMcpTools({ transport: t, diag: () => {} })
    expect(tools).toEqual([])
    expect(t.state.closed).toBe(true)
  })

  it('a listTools failure degrades to honest absence (never throws into the build)', async () => {
    const t = fakeTransport({ listError: new Error('handshake lost') })
    const { tools } = await buildAtlassianMcpTools({ transport: t, diag: () => {} })
    expect(tools).toEqual([])
    expect(t.state.closed).toBe(true)
  })
})

describe('buildAdvisoryToolsWithGithub — atlassian source (advisory wiring)', () => {
  it('surfaces atlassian_ read tools onto the registry + a release that closes the transport', async () => {
    const t = fakeTransport({ tools: [info('getConfluencePage'), info('createJiraIssue')] })
    const { registry, release } = await buildAdvisoryToolsWithGithub(new Set<string>(), { sessionId: 's1', atlassianMcp: { transport: t, diag: () => {} } })
    const names = registry.specs().map(s => s.name)
    expect(names).toContain('atlassian_getConfluencePage')
    expect(names).not.toContain('atlassian_createJiraIssue') // write dropped by the allow-list
    release()
    expect(t.state.closed).toBe(true)
  })

  it('no MCP source → byte-identical RAG-only registry (no atlassian tools, no crash)', async () => {
    const { registry, release } = await buildAdvisoryToolsWithGithub(new Set<string>(), { sessionId: 's1' })
    expect(registry.specs().some(s => s.name.startsWith('atlassian_'))).toBe(false)
    expect(() => release()).not.toThrow()
  })

  it('an atlassian source that yields NO tools → RAG-only + the transport is closed (no ref leak)', async () => {
    const t = fakeTransport({ tools: [info('createJiraIssue')] }) // only a write → dropped → no tools
    const { registry, release } = await buildAdvisoryToolsWithGithub(new Set<string>(), { sessionId: 's1', atlassianMcp: { transport: t, diag: () => {} } })
    expect(registry.specs().some(s => s.name.startsWith('atlassian_'))).toBe(false)
    expect(t.state.closed).toBe(true)
    release()
  })
})
