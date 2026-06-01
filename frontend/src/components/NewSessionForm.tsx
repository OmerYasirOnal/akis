import { useState } from 'react'

export interface WorkflowOption { id: string; name: string }

/** The build prompt + an optional saved-workflow selector. Submitting calls
 *  onStart(idea, workflowId?) — the run binds to that workflow's models/budget/RAG. */
export function NewSessionForm({ onStart, busy, workflows = [] }: { onStart: (idea: string, workflowId?: string) => void; busy?: boolean; workflows?: WorkflowOption[] }) {
  const [idea, setIdea] = useState('')
  const [workflowId, setWorkflowId] = useState('')
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={e => { e.preventDefault(); const v = idea.trim(); if (v) onStart(v, workflowId || undefined) }}
    >
      <input
        aria-label="idea"
        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none"
        placeholder="Describe the app you want to build…"
        value={idea}
        onChange={e => setIdea(e.target.value)}
      />
      {workflows.length > 0 && (
        <select aria-label="workflow" value={workflowId} onChange={e => setWorkflowId(e.target.value)}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-2 text-sm text-slate-100">
          <option value="">default workflow</option>
          {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      )}
      <button
        type="submit"
        disabled={busy || idea.trim() === ''}
        className="rounded-lg bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-2 font-semibold text-slate-900 disabled:opacity-40"
      >Build</button>
    </form>
  )
}
