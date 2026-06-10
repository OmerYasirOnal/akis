/**
 * The "Stüdyo → new chat" navigation signal (owner 2026-06-10): clicking the top-nav Studio
 * item must ALWAYS land on a fresh conversation — never silently resurface the last opened
 * build. Two delivery paths, because the studio may or may not be mounted at click time:
 *  - ALREADY ON `/`: a window event, handled live by the mounted ChatStudio (which resets via
 *    its own newChat — the cancel-in-flight + clearThread path, so no behavior forks).
 *  - FROM ANOTHER PAGE: a sessionStorage flag, consumed by ChatStudio on mount (the event
 *    fires before the navigation mounts the studio, so it alone would be lost).
 * The flag rides sessionStorage (per-tab, survives the route change, never leaks across tabs).
 * View-state only — no gate/SSE/API surface.
 */
export const NEW_CHAT_EVENT = 'akis:studio-new-chat'
const FLAG = 'akis_studio_new_chat'

/** Resolve sessionStorage defensively — undefined in SSR and privacy modes where access throws. */
function defaultStore(): Storage | undefined {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined } catch { return undefined }
}

/** Fired by the Stüdyo nav click: arm the mount flag, then poke any already-mounted studio. */
export function requestNewChat(store: Pick<Storage, 'setItem'> | undefined = defaultStore()): void {
  try { store?.setItem(FLAG, '1') } catch { /* storage blocked — the event path still works */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NEW_CHAT_EVENT))
}

/** True exactly once per request — reads AND clears the flag (mount + event handlers both consume). */
export function consumeNewChatRequest(store: Pick<Storage, 'getItem' | 'removeItem'> | undefined = defaultStore()): boolean {
  try {
    if (store?.getItem(FLAG) !== '1') return false
    store.removeItem(FLAG)
    return true
  } catch { return false }
}
