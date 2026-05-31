import type { Role, ToolName, SessionState } from '@akis/shared'
import { VERIFIER_ROLE } from '@akis/shared'

export type PermissionVerdict = { ok: true } | { ok: false; reason: string }

export interface PermissionCtx {
  hasApprovedPushToken?: boolean   // set true only when an ApprovedPush is in hand (Gate 4)
}

export function canUseTool(role: Role, tool: ToolName, session: SessionState, ctx: PermissionCtx = {}): PermissionVerdict {
  switch (tool) {
    case 'run_tests':
      return role === VERIFIER_ROLE
        ? { ok: true }
        : { ok: false, reason: `run_tests is restricted to the verifier role (${VERIFIER_ROLE}); '${role}' is a producer` }
    case 'dispatch_proto':
      return session.approvedSpec
        ? { ok: true }
        : { ok: false, reason: 'dispatch_proto (code-write) requires an approved spec (Gate 1)' }
    case 'push_to_github':
      return ctx.hasApprovedPushToken
        ? { ok: true }
        : { ok: false, reason: 'push_to_github requires an ApprovedPush token (Gate 4)' }
    default:
      return { ok: true }
  }
}
