export type Role = 'orchestrator' | 'scribe' | 'proto' | 'trace' | 'critic'

/** Trace is the only verifier. */
export const VERIFIER_ROLE: Role = 'trace'

export type ToolName =
  | 'dispatch_scribe' | 'dispatch_proto' | 'dispatch_trace' | 'dispatch_critic'
  | 'run_tests'
  | 'request_spec_approval' | 'request_push_confirm'
  | 'push_to_github'
  | 'ask' | 'chat'
