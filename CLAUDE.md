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
