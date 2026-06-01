import { useState } from 'react'

export function NewSessionForm({ onStart, busy }: { onStart: (idea: string) => void; busy?: boolean }) {
  const [idea, setIdea] = useState('')
  return (
    <form
      className="flex gap-2"
      onSubmit={e => { e.preventDefault(); const v = idea.trim(); if (v) onStart(v) }}
    >
      <input
        aria-label="idea"
        className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none"
        placeholder="Describe the app you want to build…"
        value={idea}
        onChange={e => setIdea(e.target.value)}
      />
      <button
        type="submit"
        disabled={busy || idea.trim() === ''}
        className="rounded-lg bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-2 font-semibold text-slate-900 disabled:opacity-40"
      >Build</button>
    </form>
  )
}
