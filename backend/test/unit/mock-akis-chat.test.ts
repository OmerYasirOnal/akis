import { describe, it, expect } from 'vitest'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { AKIS_PERSONA } from '../../src/api/chat.routes.js'

/**
 * The keyless-demo Ask-AKIS chat (live-audit finding): the mock used to hit the `scribe` branch
 * for EVERY persona turn (AKIS_PERSONA mentions Scribe), so chatting with AKIS returned raw
 * Scribe JSON and the demo could never reach a SpecCard. The mock must hold a real conversation:
 * a friendly persona answer (with suggestion chips) for chat, and the `akis-spec-request` handoff
 * fence for a build ask — mirroring the user's language — so the WHOLE demo loop works keyless.
 */
const p = new MockProvider()
const chat = (msg: string) => p.chat({ system: AKIS_PERSONA, messages: [{ role: 'user', content: msg }], maxTokens: 8192 })

describe('MockProvider — AKIS persona chat (keyless demo conversation)', () => {
  it('a greeting/capability question gets a CONVERSATIONAL reply — never raw Scribe JSON', async () => {
    const r = await chat('Merhaba! Sen kimsin, neler yapabilirsin?')
    expect(r.text).not.toContain('"kind":"spec"')
    expect(r.text?.trimStart().startsWith('{')).toBe(false)
    expect(r.text).toMatch(/AKIS/)
  })

  it('mirrors the user language: Turkish in → Turkish reply; English in → English reply', async () => {
    const tr = await chat('Merhaba, neler yapabilirsin?')
    expect(tr.text).toMatch(/Merhaba|ajan|uygulama/i)
    const en = await chat('Hello, what can you do?')
    expect(en.text).toMatch(/agents?|app|build/i)
    expect(en.text).not.toMatch(/[çğıöşü]/)
  })

  it('offers tappable quick-replies via an akis-suggest fence on conversational turns', async () => {
    const r = await chat('Sen kimsin?')
    expect(r.text).toMatch(/```akis-suggest\n(- .+\n)+```/)
  })

  it('a BUILD ask hands off to Scribe with the four-backtick akis-spec-request fence carrying a one-line brief', async () => {
    const r = await chat('Basit bir yapılacaklar listesi uygulaması yapmak istiyorum')
    const m = /````akis-spec-request\n([^\n]+)\n````/.exec(r.text ?? '')
    expect(m, 'expected an akis-spec-request fence').toBeTruthy()
    expect(m![1]).toMatch(/yapılacaklar|todo/i) // the brief carries the idea
    expect(m![1]).not.toContain('\n') // single line
  })

  it('an English build ask hands off too', async () => {
    const r = await chat('Build a simple todo list app with add and delete')
    expect(r.text).toMatch(/````akis-spec-request\n/)
  })

  it('is honest about demo mode in the conversational reply (capability honesty)', async () => {
    const r = await chat('What can you do?')
    expect(r.text).toMatch(/demo/i)
  })

  it('REGRESSION: the Scribe/Proto/critic branches are untouched (their prompts do not carry the persona opener)', async () => {
    const scribe = await p.chat({ system: 'You are Scribe, a spec writer', messages: [{ role: 'user', content: 'todo app' }], maxTokens: 100 })
    expect(scribe.text).toContain('"kind":"spec"')
    // The DOCS system starts "You are AKIS Scribe…" — it must NOT hit the persona branch
    // (the detector keys on the persona's full distinctive opener, not just "AKIS").
    const docs = await p.chat({ system: 'You are AKIS Scribe writing the README for an app', messages: [{ role: 'user', content: 'readme' }], maxTokens: 100 })
    expect(docs.text).not.toMatch(/akis-suggest|akis-spec-request/)
  })

  it('chatStream deltas concatenate to exactly the chat() text (spec detection parity)', async () => {
    let acc = ''
    const res = await p.chatStream({ system: AKIS_PERSONA, messages: [{ role: 'user', content: 'Bir not defteri uygulaması yap' }], maxTokens: 8192 }, d => { acc += d })
    expect(acc).toBe(res.text)
  })
})
