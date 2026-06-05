import type { StringKey } from '../i18n/catalog.js'

/**
 * Map a backend SessionStatus (the raw enum from GET /sessions/mine) to a localized human
 * LABEL key + a meaningful tone, so History surfaces never print the raw uppercased enum
 * (P1-7). Both History doors (the page + the header menu) read this ONE resolver, so they
 * carry the same minimal signal. Unknown/absent statuses fall back to a neutral "in progress"
 * label + tone rather than crashing or showing a raw token.
 *
 * Tone groups: awaiting_* = amber ("needs you"), building/composing = teal (in progress),
 * done = emerald ("shipped"), failed/cancelled/verify_failed/push_failed = rose.
 */
export interface StatusSignal { labelKey: StringKey; tone: string }

const AMBER = 'border-amber-400/30 bg-amber-400/10 text-amber-300'
const TEAL = 'border-[#07D1AF]/30 bg-[#07D1AF]/10 text-[#07D1AF]'
const EMERALD = 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
const ROSE = 'border-rose-400/30 bg-rose-400/10 text-rose-300'
const NEUTRAL = 'border-white/10 bg-white/5 text-slate-300'

const SIGNALS: Record<string, StatusSignal> = {
  composing: { labelKey: 'history.status.composing', tone: TEAL },
  awaiting_spec_approval: { labelKey: 'history.status.awaitingSpec', tone: AMBER },
  building: { labelKey: 'history.status.building', tone: TEAL },
  awaiting_critic_resolution: { labelKey: 'history.status.awaitingCritic', tone: AMBER },
  awaiting_push_confirm: { labelKey: 'history.status.awaitingPush', tone: AMBER },
  verify_failed: { labelKey: 'history.status.verifyFailed', tone: ROSE },
  done: { labelKey: 'history.status.done', tone: EMERALD },
  push_failed: { labelKey: 'history.status.pushFailed', tone: ROSE },
  failed: { labelKey: 'history.status.failed', tone: ROSE },
  cancelled: { labelKey: 'history.status.cancelled', tone: ROSE },
  // The SSE-derived live view also uses 'running'/'started' (not backend enum values) — map
  // them so a row built from either source still reads cleanly.
  running: { labelKey: 'history.status.building', tone: TEAL },
  started: { labelKey: 'history.status.building', tone: TEAL },
}

const FALLBACK: StatusSignal = { labelKey: 'history.status.inProgress', tone: NEUTRAL }

/** Resolve the localized label key + tone for a backend (or live) status string. */
export function statusSignal(status: string | undefined): StatusSignal {
  return (status && SIGNALS[status]) || FALLBACK
}
