/**
 * The MCP transport seam — the SINGLE narrow interface every MCP transport implements,
 * modeled on LlmProvider. Everything ABOVE this file (McpToolBridge, the pool's callers,
 * the producer wiring) depends ONLY on these normalized shapes; no `@modelcontextprotocol/sdk`
 * type ever leaks past the concrete transport (StdioDockerTransport).
 *
 * PORTABILITY CONTRACT (the user mandate): stdio+Docker today can become a remote HTTP
 * transport later by writing a NEW class that implements `McpTransport`, with NO change to
 * any caller above this seam (the bridge + the producers transfer unchanged).
 *
 * IMPORTANT — what is and is NOT part of this contract:
 *  - The CALLERS (McpToolBridge, ScribeAgent's wiring) are the portable surface. They
 *    transfer unchanged to a remote HTTP transport.
 *  - The McpSessionPool is an SP1 PROCESS-REUSE OPTIMIZATION for a stdio+Docker child, NOT
 *    part of the portability contract. Its keying/idle/refcount policy may change (or the
 *    pool may disappear entirely) for a remote transport — that is allowed and expected.
 */

/** A tool advertised by an MCP server, normalized off the SDK wire shape. */
export interface McpToolInfo {
  name: string
  description: string
  /** The tool's JSON-Schema input shape, passed straight through to the LLM (opaque here). */
  inputSchema: unknown
}

/** The normalized result of one MCP tool call: a single text payload + an error flag.
 *  We flatten the SDK's content-block array into one string so nothing above the seam
 *  has to know the SDK content shape. */
export interface McpToolResult {
  text: string
  isError: boolean
}

/**
 * The transport seam. A transport owns ONE server connection for its lifetime.
 * Contract:
 *  - `initialize()` performs the MCP handshake (idempotent: safe to call once per lifetime).
 *  - `listTools()` returns the server's advertised tools (after initialize).
 *  - `callTool(name, args)` invokes a tool; it should REJECT on a transport/server error
 *    (the bridge converts a reject into an error STRING — it never lets a throw escape to
 *    the tool loop).
 *  - `close()` tears the connection (and any owned child process) down; idempotent.
 */
export interface McpTransport {
  initialize(): Promise<void>
  listTools(): Promise<McpToolInfo[]>
  callTool(name: string, args: unknown): Promise<McpToolResult>
  close(): Promise<void>
}

/**
 * Raised when an MCP server cannot be reached/started (no Docker, spawn failure, bad token,
 * handshake error). The MESSAGE is FIXED and TOKEN-FREE by construction — it echoes nothing
 * from the underlying error (which could in theory carry argv/env). Callers degrade to an
 * honest absence (no github tools) rather than crashing the build.
 */
export class McpUnavailableError extends Error {
  constructor(message = 'github-mcp: server unavailable') {
    super(message)
    this.name = 'McpUnavailableError'
  }
}
