# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

AKIS (Adaptive Knowledge Integrity System) — an AI-powered, multi-agent
software-development platform (Scribe / Proto / Critic / Trace orchestrated by
AKIS, behind 4 structural human-approval gates). For the app itself, start from:

- `ARCHITECTURE.md` — system architecture and the gate model
- `MEMORY.md` / `HANDOFF.md` — current state, decisions, and context
- `README.md` — overview and developer setup
- `backend/`, `frontend/`, `shared/` — the workspaces (pnpm, TypeScript)

App commands: `pnpm -r build`, `pnpm test`, `pnpm -r typecheck`.

## Report / document tooling (bitirme raporu)

We also maintain the graduation report (**bitirme raporu**) as a Word document
(`.docx`) with generated charts. The tools below are the ones we rely on for
that work and are **installed automatically every session** by the SessionStart
hook (`.claude/hooks/session-start.sh`) because the Claude Code on the web
container is ephemeral and rebuilt from the repo each time.

Installed tooling:

| Tool | Purpose |
| --- | --- |
| `python-docx` | Read/edit the `.docx` report (captions, tables, lists, styles) |
| `matplotlib` + `numpy` | Generate the report's charts/figures (PNG) |
| `openpyxl` | Read/write the linked Excel (`.xlsx`) data tables |
| `pandas` | Tabular data handling for the charts |
| `Pillow` | Image handling/embedding |
| `lxml` | Low-level OOXML (docx XML) manipulation |
| `poppler-utils` | `pdftotext` / `pdftoppm` — extract & render the PDF export |
| `pandoc` | Convert between `.docx` / Markdown / etc. |

- Python deps live in `.claude/report-requirements.txt` — add new ones there and
  the hook will pick them up next session.
- To install manually (e.g. locally): run
  `CLAUDE_CODE_REMOTE=true ./.claude/hooks/session-start.sh`, or
  `pip install -r .claude/report-requirements.txt` plus
  `apt-get install -y poppler-utils pandoc`.

When editing the report, keep citation numbers `[n]` consistent and in order
with the REFERENCES list, and keep every Table/Figure caption sequential and
reflected in the List of Tables / List of Figures.

## Working method (owner-approved discipline — applies to EVERY session)

Battle-tested across the 2026-06-10/11 demo-ready rounds (A1/A2/A2.1/P1/P2/P3 —
all shipped via this loop). Follow it for every substantive change:

1. **One work package = one isolated git worktree + branch.** Agent-tool
   worktrees open at STALE origin/main — the first step of every agent brief is
   `git log --oneline -1` and `git reset --hard <current local main SHA>`.
2. **Adversarial review BEFORE merge, always two passes in parallel:**
   `akis-gate-keeper` (prove no gate can be bypassed/weakened/client-minted) +
   `akis-reviewer` (correctness/regressions, every finding with a code excerpt).
   Fix MED+ findings before merging; cheap LOWs too.
3. **Tests fail-first; suites must be FULLY green before merge:**
   `pnpm -r typecheck` + backend & frontend vitest + i18n TR/EN parity. Never
   loosen an existing assertion to get green.
4. **Live verification:** run the worktree's own stack on SEPARATE ports
   (backend `PORT=3001/3002` sourcing the main `backend/.env`; frontend
   5175/5176 with an UNCOMMITTED vite-proxy tweak). NEVER touch the owner's
   :3000/:5173. The Playwright automation browser is single-owner — one mission
   at a time. Screenshot evidence goes under `docs/research/`.
5. **The owner merges PRs.** Before ANY push, check the PR/branch state
   (`gh pr view`) — never push to a merged PR's branch. Watch CI to fully green
   and fix reds (`gh pr checks` / `gh run list` polled in background).
6. **Sacred invariants:** the 4 structural gates (spec approval, verify, push
   confirm, external-write) and `externalWriteGate.ts` are never weakened; chat
   routes hold no orchestrator handle; tokens never reach the FE/agent context;
   shared/session changes are additive; store writes never touch gate columns.
7. **While the owner manually tests,** keep a background log watcher on the dev
   server output + `~/.akis/dev-events.json` error events; report alerts with a
   root cause, not raw logs.
8. **After each package:** update `docs/plans/2026-06-10-demo-ready-plan.md`
   (or its successor) + the session memory, so any new session can resume from
   the docs alone. Current queue lives in that plan doc.
