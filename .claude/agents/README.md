# AKIS specialized agents

Project-scoped subagent definitions tuned for THIS codebase — its architecture, its sacred
constraints (the four server-minted structural gates, owner-scoping, fail-closed verify, the SSE
perf coalescer, TR+EN i18n, strict-TS), and its idioms. Invoke them with the Agent/Task tool
(`subagent_type: "<name>"`) or inside a Workflow (`agentType: "<name>"`). The `description` on each
drives automatic selection.

## The roster

| Agent | Use it for | Mode | Model |
|-------|-----------|------|-------|
| **akis-gate-keeper** | Prove a diff can't bypass/weaken/client-mint a gate. Run before merging anything touching orchestrator/gates/agents/store/keys/chat/MCP. THE moat guardian. | read-only | opus |
| **akis-reviewer** | Adversarial multi-lens pre-merge review (gate-safety, correctness, multi-run lifecycle, SSE/perf, i18n, strict-TS, regression, tests). Every finding code-evidenced. | read-only | opus |
| **akis-studio** | Build/modify the web studio (frontend/) — conversation spine, RunBlock, live SSE view, gates/recovery UI, i18n. | builds | opus |
| **akis-engine** | Build/modify the backend — orchestrator pipeline, agents, gates, SSE bus, session store, keys, API routes. | builds | opus |
| **akis-verifier** | The verification + trust-legibility domain — Trace real-test pipeline, fail-closed VerifyToken, boot-smoke, demo-vs-real honesty, trust ledger/passport, deriveChecks false-fail bugs. | builds | opus |
| **akis-publisher** | The "publish to your own server" (OCI/SSH) deploy + GitHub delivery — transport, profiles, preflight, SSRF/path-traversal/host-key safety. | builds | opus |
| **akis-scout** | Fast read-only "where does X live / how is Y wired" navigation, pre-loaded with the AKIS map. | read-only | sonnet |

Models follow the project's quality bar (Opus for the deep reviewers + builders; Sonnet for the
fast read-only scout). The Agent/Workflow caller can override per-call.

## How they compose (the patterns this project actually uses)

- **Build → review → gate, before every merge.** A builder (`akis-studio`/`akis-engine`/…) makes the
  change; then run `akis-reviewer` AND `akis-gate-keeper` over the diff; apply confirmed findings; only
  then merge. This mirrors the design→implement→adversarial-review→live-verify workflows in this repo.
- **Scout first when unsure.** `akis-scout` to locate the owning file(s), then hand off to the right
  builder — avoids editing the wrong layer.
- **Gate-keeper is non-negotiable on gate-adjacent diffs.** It's read-only and cheap relative to shipping
  a bypass; the gates are the product.

## Complementary built-in agents (no need to redefine these)

- **Explore** — broad fan-out search across many files when you only need the conclusion. (`akis-scout`
  is the AKIS-tuned, map-aware version for in-repo navigation; use Explore for wide unfamiliar sweeps.)
- **Plan** — design an implementation strategy / step-by-step plan before a large change.
- **general-purpose** — open-ended multi-step research that doesn't fit a specialized agent.

## Maintenance

These encode the architecture as of the unified-studio + publish + SP1 work. When a sacred constraint
or a file path changes, update the relevant agent body so it never points future work at stale code
(the project memory's rule: verify a cited file/flag still exists before relying on it).
