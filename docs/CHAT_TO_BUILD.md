# Chat-to-Build

Promote an AKIS-authored spec from the "Ask AKIS" chat into a one-click build — no
copy-paste, no new build path.

> Spec of record: [`docs/specs/2026-06-03-chat-to-build.md`](specs/2026-06-03-chat-to-build.md).

## User flow

1. You chat with **AKIS** (`/api/chat`) to shape an app idea. Replies now render as
   markdown — `**bold**`, lists, `code`, headings, `---` all look right.
2. When AKIS judges you're genuinely ready to build, it emits the spec inside a fenced
   ` ```akis-spec ` block (see the contract below).
3. The chat detects that block and renders a **Build-ready spec** card: a read-only
   markdown preview of the spec, plus two actions.
   - **Download .md** — saves the spec as a `.md` file (client-side `Blob`; filename is a
     slug of the spec's first heading, else `akis-spec.md`). No server write.
   - **Approve & Build** — the single approval. It hands the spec to the studio, which
     runs the **existing** build pipeline.
4. On approve, the spec becomes the build idea via the unchanged `api.startSession(spec)`
   → the session is set → `RunPipeline` (Scribe → Proto → Trace → Critic → ship) and
   History work exactly as for a typed idea.

```
user ⇄ AkisChat ──POST /api/chat──▶ Claude (AKIS_PERSONA)
                 ◀── reply (may contain ```akis-spec … ```)
AkisChat: <Markdown> renders the reply; extractBuildSpec(reply) → <SpecCard>
SpecCard: [Download .md]  [Approve & Build] ──onBuild(spec)──▶ ChatStudio.startBuild
ChatStudio.startBuild(spec) = api.startSession(spec) → sessionId set
                            → RunPipeline (4 gates + pipeline) → History
```

There is **no new endpoint** and **no new build path**. The only backend change is the
persona string.

## The `akis-spec` contract

Detection keys on a single, machine-detectable marker — never on prose, which would rot.

When the user is ready to build, AKIS emits the spec inside a fenced block whose info
string is **`akis-spec`**:

````
Here's a spec you can build 👇
```akis-spec
# TODO Uygulaması
… the spec in markdown …
```
````

- The fence tag `akis-spec` is the **single source of truth** the frontend keys on.
- The info string may carry extra tokens (e.g. ` ```akis-spec v=2 `) without breaking
  detection — the contract is versionable.
- AKIS still chats freely; the block only appears when it's genuinely offering a build,
  and AKIS is told **never** to ask the user to copy-paste the spec.
- The block **content is treated as untrusted user input** — exactly like text typed into
  the composer. It becomes the `startSession` idea; it gets **no** new trust surface and
  flows through the **same 4 structural gates**.

`extractBuildSpec(message)` (pure, in `frontend/src/chat/buildSpec.ts`) returns
`{ intro, spec }` for the **first** closed `akis-spec` block (intro = the text before it),
or `null` if the block is absent or its fence is unclosed. A missing/malformed block
therefore degrades gracefully to a plain rendered message — an older AKIS or a partial
stream never breaks the chat.

## Security

- `<Markdown>` (`frontend/src/components/Markdown.tsx`) uses react-markdown's default —
  **no raw HTML** (no `rehype-raw`), and we never touch `dangerouslySetInnerHTML`. LLM
  output cannot inject `<script>`/markup. This is the single rendering point, so
  sanitization + styling stay centralized. (XSS-guard tests assert a `<script>` is shown
  as text, never executed.)
- The approved spec is just the **build idea** → unchanged `startSession` → unchanged
  gates/pipeline. No bypass, no new authority.
- The `.md` download is a client-side `Blob`; no server write, no path handling.

## Files

| File | Responsibility |
|------|----------------|
| `frontend/src/components/Markdown.tsx` | The single, XSS-safe markdown renderer (react-markdown + remark-gfm), themed for the cosmic dark UI. Reusable. |
| `frontend/src/chat/buildSpec.ts` | Pure `extractBuildSpec(message)` — finds the `akis-spec` block; returns `{ intro, spec }` or `null`. |
| `frontend/src/chat/SpecCard.tsx` | Read-only spec preview + Download `.md` + Approve & Build → `onBuild(spec)`. |
| `frontend/src/chat/AkisChat.tsx` | Renders each message via `<Markdown>`; promotes a detected spec to a `<SpecCard>`. New `onBuild?` prop. |
| `frontend/src/chat/ChatStudio.tsx` | Passes `onBuild={startBuild}` to `AkisChat`, reusing the existing `startSession` path; gives the empty-studio chat column real height. |
| `backend/src/api/chat.routes.ts` | `AKIS_PERSONA` instructs AKIS to emit the build-ready spec in an `akis-spec` block (and keep chatting otherwise). |
| `frontend/src/i18n/catalog.ts` | `spec.*` strings in EN + TR. |

## How to extend

- **New rendering surface** (docs page, run log, …): import the shared `<Markdown>` —
  styling and the no-raw-HTML guarantee come for free.
- **Evolve the contract**: bump the info string (e.g. `akis-spec v=2`) or add front-matter
  metadata inside the block. `extractBuildSpec` already tolerates extra info-string tokens;
  parse new fields there. Keep it pure and unit-tested so the persona and UI evolve
  independently.
- **Change the pipeline/gates/history/persistence**: nothing here forks them — Chat-to-Build
  reuses `startSession`, so it inherits every future change with zero divergence.
- **Persona wording**: edit `AKIS_PERSONA` in `backend/src/api/chat.routes.ts`. A contract
  test (`backend/test/integration/chat.routes.test.ts`) asserts the `akis-spec` instruction
  stays present so the FE/BE contract can't silently drift.

## Out of scope (flagged, not built here)

- The parked **critic-resolution** action (separate gate-semantics decision).
- Server-side spec persistence / a spec library (could build on the same contract later).
