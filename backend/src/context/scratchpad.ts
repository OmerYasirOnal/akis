import type { AkisEvent, Scratchpad } from '@akis/shared'

/** Most-recent cap for the unbounded text-ish fields, so the scratchpad stays small. */
const CAP = 20

/**
 * Pure reducer: project the AkisEvent log into the typed Scratchpad. This is the
 * ONLY producer of a Scratchpad — there is no setter and no untyped bag, so the
 * shared context can only change by emitting a typed event (F2-AC16). Folding is
 * deterministic and side-effect free.
 */
export function foldScratchpad(events: readonly AkisEvent[]): Scratchpad {
  const sp: Scratchpad = { gates: {}, notes: [], errors: [] }
  for (const e of events) {
    switch (e.kind) {
      case 'gate':
        if (e.gate === 'spec_approval') sp.gates.specApproval = e.state
        else if (e.gate === 'push_confirm') sp.gates.pushConfirm = e.state
        break
      case 'verify':
        sp.verification = { testsRun: e.testsRun, passed: e.passed }
        break
      case 'preview':
        sp.previewUrl = e.url
        break
      case 'text':
        sp.notes.push(e.text)
        break
      case 'error':
        sp.errors.push(e.message)
        break
      case 'tool_result':
        if (!e.ok) sp.errors.push(describeToolFailure(e.tool, e.result))
        break
      default:
        break
    }
  }
  // Keep only the most recent CAP of each unbounded field.
  if (sp.notes.length > CAP) sp.notes = sp.notes.slice(-CAP)
  if (sp.errors.length > CAP) sp.errors = sp.errors.slice(-CAP)
  return sp
}

function describeToolFailure(tool: string, result: unknown): string {
  const err = result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : ''
  return err ? `${tool}: ${err}` : `${tool}: failed`
}
