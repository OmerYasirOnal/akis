# Spec — Chat‑to‑Build: promote an AKIS‑authored spec into a one‑click build

**Status:** design → ready to implement
**Date:** 2026‑06‑03
**Scope:** frontend feature + a small backend persona contract. No new build path, no new gates.

## 1. Problem

The "Ask AKIS" conversational assistant (`/api/chat`, real Claude behind the
`AKIS_PERSONA`) is good at shaping an idea and even writing a ready build prompt. But:

1. AKIS replies render as **raw text** — `**bold**`, `---`, lists show literally (`AkisChat.tsx` renders `{m.content}` as a plain string).
2. To actually build, the user must **manually copy** the prompt out of the chat, paste it into the composer, and press Build. The persona literally instructs this.
3. The empty‑studio chat column is **not given height**, so the conversation looks cramped.

## 2. Goal

When AKIS produces a build‑ready spec in chat, the UI shows it **rendered nicely**, lets the user **download it as `.md`**, asks for **one approval**, and on approve **runs the whole agent pipeline** (Scribe→Proto→Trace→Critic→ship) with that spec — no copy‑paste. Plus: render markdown in chat, and fix the column height.

## 3. Design principle — a stable contract, not a heuristic

Detecting "is this message a spec?" by sniffing prose is fragile and will rot as the
system grows. Instead we define a **versioned, machine‑detectable contract** between the
backend persona and the frontend:

> When the user is ready to build, AKIS emits the spec inside a fenced block whose info
> string is **`akis-spec`**:
>
> ````
> Here's a spec you can build 👇
> ```akis-spec
> # TODO Uygulaması
> … the spec in markdown …
> ```
> ````

- The fence tag `akis-spec` is the single source of truth the FE keys on. It is
  extensible (e.g. `akis-spec v=2`, or front‑matter metadata) without touching the detector's contract.
- AKIS still chats freely; the block only appears when it's genuinely offering a build.
- The block **content is treated as untrusted user input** — exactly like text typed into
  the composer. It becomes the `startSession` idea; it gets **no** new trust surface and
  flows through the **same 4 structural gates**.

## 4. Components (small, isolated, testable)

| Unit | File | Responsibility | Depends on |
|------|------|----------------|------------|
| `<Markdown>` | `frontend/src/components/Markdown.tsx` | The **single** markdown renderer (react‑markdown + remark‑gfm), themed for the cosmic UI, **raw HTML disabled** (no `dangerouslySetInnerHTML`). Reused by chat bubbles, the spec card, and available to DocsPage later. | react‑markdown, remark‑gfm |
| `extractBuildSpec` | `frontend/src/chat/buildSpec.ts` | **Pure** parser: given an assistant message, return `{ spec, intro }` if it contains an ` ```akis-spec ` fenced block, else `null`. No UI. | — |
| `<SpecCard>` | `frontend/src/chat/SpecCard.tsx` | Render a detected spec via `<Markdown>`; **Download .md** (client `Blob`); **Onayla & Build** button → `onBuild(spec)`. Read‑only preview + one approval. | `<Markdown>` |
| `AkisChat` (edit) | `frontend/src/chat/AkisChat.tsx` | Render each message via `<Markdown>`; if `extractBuildSpec` matches, show the intro text + a `<SpecCard>`; give the scroll area real height. New prop `onBuild`. | above |
| `ChatStudio` (edit) | `frontend/src/chat/ChatStudio.tsx` | Pass `onBuild={(spec) => startBuild(spec)}` to `AkisChat`, reusing the existing `send`/`startSession` path so the pipeline + History work unchanged. Fix the empty‑studio column to give `AkisChat` height. | — |
| `AKIS_PERSONA` (edit) | `backend/src/api/chat.routes.ts` | Instruct AKIS to emit a build‑ready spec inside an ` ```akis-spec ` block (and to keep chatting otherwise). | — |
| i18n | `frontend/src/i18n/catalog.ts` | New EN+TR strings (build‑this, download, approve, spec‑card title). | — |

### Data flow

```
user ⇄ AkisChat ──POST /api/chat──▶ Claude (AKIS_PERSONA)
                 ◀── reply (may contain ```akis-spec … ```)
AkisChat: <Markdown> renders the reply; extractBuildSpec(reply) → SpecCard
SpecCard: [Download .md]   [Onayla & Build] ──onBuild(spec)──▶ ChatStudio.startBuild
ChatStudio.startBuild(spec) = existing api.startSession(spec) → sessionId set
                            → RunPipeline (Scribe→Proto→Trace→Critic→ship) → History
```

No new endpoint. The only backend change is the persona string.

## 5. Security

- `<Markdown>` renders with react‑markdown's default (no raw HTML); LLM output cannot inject script/markup. No `dangerouslySetInnerHTML` anywhere.
- The spec is the **build idea** → `startSession` → unchanged gates/pipeline. No bypass, no new authority.
- `.md` download is a client‑side `Blob`; no server write, no path handling.

## 6. Future‑proofing (so it doesn't hurt as the system grows)

- One rendering point (`<Markdown>`) → styling/sanitization centralized; new surfaces (docs, run log) reuse it.
- The `akis-spec` fence is a **versionable contract**; `extractBuildSpec` is pure + unit‑tested, decoupled from UI, so the persona and the UI can evolve independently.
- Reusing `startSession` means Chat‑to‑Build automatically inherits every future pipeline/gate/history/persistence change — zero divergence.
- `extractBuildSpec` tolerates a missing/!malformed block (returns `null` → plain message), so an older AKIS or a partial stream never breaks the chat.

## 7. Testing

- `extractBuildSpec` (pure): block present / absent / with intro text / multiple blocks (first wins) / unclosed fence (graceful null).
- `<Markdown>`: renders bold/list/code/hr; **does NOT** render raw `<script>`/HTML (XSS guard test).
- `<SpecCard>`: renders the spec; Download triggers a `.md` blob; Approve calls `onBuild` with the spec.
- `AkisChat`: a reply containing an `akis-spec` block shows a SpecCard; Approve → `onBuild`; a plain reply shows no card.
- `chat.routes` (backend contract): `AKIS_PERSONA` contains the `akis-spec` instruction (so the contract can't silently drift).
- Full `pnpm -C frontend test` + `pnpm -C backend test` green; tsc strict clean; i18n EN/TR parity test passes.

## 8. Docs to write

- This spec (committed).
- `docs/CHAT_TO_BUILD.md` — user + maintainer doc: the flow, the `akis-spec` contract, how to extend it.
- README feature bullet + a line in the Studio/usage docs.

## 9. Out of scope (flagged, not built here)

- The parked **critic‑resolution** action (separate gate‑semantics decision).
- Server‑side spec persistence / a spec library (could build on the same contract later).
