/**
 * SMART TRIGGER for the SP1 read-only GitHub context (Scribe tool availability + Proto's gather).
 *
 * A connected GitHub repo is primarily for PUSH delivery; reading it for code context is a SEPARATE,
 * occasional intent. Spawning the github-MCP Docker child (and, for Proto, a whole extra gather LLM
 * call) on EVERY build for EVERY connected user is wasteful. So the orchestrator only wires the
 * github handle into the producers when the build's text actually SIGNALS the user wants their
 * connected repo used as reference — otherwise SP1 stays dormant (no Docker spawn, byte-identical to
 * an unconnected build).
 *
 * CONSERVATIVE / opt-in-by-intent: a plain app idea ("build a notes app") does NOT trigger; explicit
 * repo references ("use my repo", "match the existing patterns", "based on my codebase", anything
 * mentioning a repo/repository/github) DO. We err toward NOT triggering — a false negative just means
 * the user phrases it explicitly; a false positive burns Docker + an LLM call for nothing.
 */
export function wantsRepoContext(text: string | undefined): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  return /\b(repo|repos|repository|repositories)\b/.test(t)
    || /\bgithub\b/.test(t)
    || /\b(my|our|the existing)\s+(codebase|code\s?base|project)\b/.test(t)
    || (/\bmatch(ing)?\b/.test(t) && /\b(style|patterns?|conventions?|structure|existing code)\b/.test(t))
}
