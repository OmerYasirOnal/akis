import type { ToolName } from '@akis/shared'
import type { ToolSpec } from '../agent/LlmProvider.js'

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  dispatch_scribe:       { name: 'dispatch_scribe', description: 'Turn the idea into a spec', schema: {} },
  dispatch_proto:        { name: 'dispatch_proto', description: 'Write code from the approved spec', schema: {} },
  dispatch_trace:        { name: 'dispatch_trace', description: 'Generate + run tests (verifier)', schema: {} },
  dispatch_critic:       { name: 'dispatch_critic', description: 'Adversarial review of spec or code', schema: {} },
  run_tests:             { name: 'run_tests', description: 'Execute the test suite (verifier only)', schema: {} },
  request_spec_approval: { name: 'request_spec_approval', description: 'Park for human spec approval', schema: {} },
  request_push_confirm:  { name: 'request_push_confirm', description: 'Park for human push confirmation', schema: {} },
  push_to_github:        { name: 'push_to_github', description: 'Push verified code (needs ApprovedPush)', schema: {} },
  ask:                   { name: 'ask', description: 'Ask the user a question', schema: {} },
  chat:                  { name: 'chat', description: 'Answer without building', schema: {} },
}

export function toolsForRole(names: ToolName[]): ToolSpec[] {
  return names.map(n => TOOL_SPECS[n])
}
