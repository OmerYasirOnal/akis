import { describe, it, expect, beforeEach } from 'vitest'
import { NEW_CHAT_EVENT, requestNewChat, consumeNewChatRequest } from './newChatSignal.js'

describe('newChatSignal — the Stüdyo-nav → fresh-chat handshake', () => {
  beforeEach(() => { sessionStorage.clear() })

  it('requestNewChat arms the flag AND dispatches the live event', () => {
    let fired = 0
    const onEvt = (): void => { fired++ }
    window.addEventListener(NEW_CHAT_EVENT, onEvt)
    try {
      requestNewChat()
      expect(fired).toBe(1)
      expect(consumeNewChatRequest()).toBe(true)
    } finally { window.removeEventListener(NEW_CHAT_EVENT, onEvt) }
  })

  it('consumeNewChatRequest is true exactly once per request (read-and-clear)', () => {
    expect(consumeNewChatRequest()).toBe(false) // nothing armed
    requestNewChat()
    expect(consumeNewChatRequest()).toBe(true)
    expect(consumeNewChatRequest()).toBe(false) // consumed
  })

  it('degrades to the event path when storage is blocked (setItem throws)', () => {
    let fired = 0
    const onEvt = (): void => { fired++ }
    window.addEventListener(NEW_CHAT_EVENT, onEvt)
    try {
      const blocked = { setItem: () => { throw new Error('blocked') } }
      requestNewChat(blocked)
      expect(fired).toBe(1)
      expect(consumeNewChatRequest()).toBe(false) // flag never landed — and that's non-fatal
    } finally { window.removeEventListener(NEW_CHAT_EVENT, onEvt) }
  })
})
