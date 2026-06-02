import type { ToolSpec } from '../LlmProvider.js'

/** A named, LLM-callable tool: the JSON-schema spec advertised to the model plus
 *  the handler that runs when the model calls it. The handler returns a STRING that
 *  is fed back to the model as the tool result. */
export interface RegisteredTool {
  spec: ToolSpec
  handler: (args: unknown) => Promise<string>
}

/**
 * A small, provider-agnostic registry of LLM-callable tools. It holds the specs
 * advertised to the model and dispatches a model tool call to its handler.
 *
 * It carries NO gate authority by construction: only side-effect-free / read-only
 * tools (e.g. retrieve_knowledge) belong here — the 4 structural gates
 * (spec-approval, verify, push) are NEVER exposed as registry tools, so a tool-loop
 * cannot reach a gate through it.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  /** Register a tool. Throws on a duplicate name so a tool can never silently shadow another. */
  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.spec.name)) throw new Error(`tool '${tool.spec.name}' already registered`)
    this.tools.set(tool.spec.name, tool)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** The specs to advertise to the provider (empty → the model sees no tools). */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map(t => t.spec)
  }

  /** Dispatch a model tool call. Throws on an unknown tool (callers feed that back to the model). */
  async call(name: string, args: unknown): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`unknown tool '${name}'`)
    return tool.handler(args)
  }
}
