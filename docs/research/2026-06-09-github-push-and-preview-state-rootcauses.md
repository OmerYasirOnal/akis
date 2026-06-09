# Priority-0 root causes: GitHub push + preview correct-state (2026-06-09)

Two read-only investigations (akis-engine + akis-studio) into the owner's two priority problems. These come BEFORE the cohesion polish / live-agent-messages work. File:line below.

---

## A. "Agent çıktıları GitHub'a pushlanamıyor"

There are **two separate, confused GitHub paths** with **two separate connection stores** — this confusion is the likely core.

- **Path A = the REAL code push (Gate-4 `confirmPush`).** Pushes the whole verified `code.files` as blob→tree→commit→branch `akis-<sessionId>`→PR via the GitHub REST Git Data API. Executor is REAL: `backend/src/di/RealGitHubAdapter.ts:102-142`. Connect (write, scope `repo`, AES-encrypted, owner-scoped): `backend/src/api/githubConnect.routes.ts:40`, `backend/src/auth/oauth.ts:105`, `backend/src/keys/GitHubConnectionStore.ts:84`. Per-user wiring: `Orchestrator.ts:538` → `services.ts:233-236,434-452`. Gate: `backend/src/gates/pushGate.ts:38`.
- **Path B = `propose_github_write` (agent proposes) → confirm card → execute.** Issues/PRs ONLY — **no file/commit action** (`backend/src/gates/externalWriteGate.ts:172-181`). Cannot push build output.

### Most likely root causes (ranked)
1. **Silent Mock fallback (most likely).** When the session has no `ownerId`, OR the user never did `/auth/github/connect`, OR `NODE_ENV=test`/env not threaded → `confirmPush` falls back to **MockGitHubAdapter**, which "succeeds" and returns a FAKE `https://github.com/mock/<sessionId>` URL — nothing on real GitHub. `Orchestrator.ts:538`, `services.ts:225,234`, `selectGitHubAdapter.ts:31`, `MockGitHubAdapter.ts:37`. → **Disambiguator: is the resulting URL `github.com/mock/...`?**
2. **Path B two-store divergence.** Propose uses the delivery `connections` store + Docker MCP; confirm/execute reads a SEPARATE `mcpAuthStore` (remote OAuth) → **409 "not connected to github"** unless the user ALSO did `/mcp/github/connect`. `sessions.routes.ts:384`, `mcpConnect.routes.ts:199`. Also: propose only registers if Docker present AND the idea has repo-context phrasing (`advisoryTools.ts:88`, `Orchestrator.ts:203,319`).
3. **No repo creation / empty-repo handling.** `RealGitHubAdapter.createRepo` is a no-op (`:88-90`); `pushFiles` 404s on a missing/empty repo. Free-text `owner/name` box, no repo picker (`GitHubConnection.tsx:94`).

### Fix directions
- Make the mock-vs-real fallback **honest**: when an owner IS connected but the adapter is mock, do NOT report a real-looking URL — refuse/flag (`Orchestrator.ts:538`, `MockGitHubAdapter.ts:37`).
- Add repo creation / empty-repo seeding in `RealGitHubAdapter` (`:88-107`).
- Repo-selection UI (list the token's repos) instead of free-text (`GitHubConnection.tsx:94`).
- Unify the two GitHub connections OR let Path B confirm fall back to the delivery connection (`sessions.routes.ts:384`).

---

## B. "Preview doğru state'de doğru gösterilmiyor"

Backend states (`backend/src/preview/PreviewRegistry.ts:14`): starting/ready/failed/stopped/unsupported (no `empty`; "never run" = absence). URL is a pure function of sessionId → `/preview/<id>/`. SSE `preview_status` is **retained** in the bus buffer and **replayed by `/log`** (`bus.ts:82`, `sessions.routes.ts:526`), folded in `frontend/src/live/viewModel.ts:105-130`.

### Concrete bugs (ranked)
- **B (strongest): stale replayed `ready` on reopen/restart.** A retained `ready`+url frame is replayed, so the fold reconstructs `preview.ready=true` — but the registry entry is gone (server restart / `stopAll` / cap-eviction), so the url 502s. The FE renders the `ready` branch → **dead/blank iframe, and no Run/Retry shown**. `viewModel.ts:105-130`, `bus.ts:82`, `PreviewPanel.tsx` ready branch. `seedRun` pre-seeds auto-open refs but does NOT clear a stale replayed `ready`.
- **A: iframe shows the OLD app after a change-request.** The iframe `key` is `reloadNonce` only, NOT `url` (`PreviewPanel.tsx:236`, re-arm `:62`). When the url changes (change-request base-merges into a NEW session id → new url, or session switch) React keeps the same iframe and only swaps `src` → old document can persist/flash.
- **C: stuck `starting` forever** if the terminal `ready`/`failed` frame is dropped — `starting` is recomputed from the last frame (`viewModel.ts:124`); the boot watchdog (`PreviewPanel.tsx:33`, 125s) only adds a note + Retry, never flips state.
- D: empty-state flash during active-run handoff (`ChatStudio.tsx:278,285,323`). E: same-session re-run doesn't auto-reopen + (with A) shows stale iframe (`ChatStudio.tsx:367-377`). F: `canRun` false in the async reopen gap → empty state with no Run button (`ChatStudio.tsx:388`).

### Fix directions
- On reopen, **don't trust a replayed `ready`** — verify the `/preview/<id>/` is actually live (or clear ready/show Run when the registry has no entry). Bug B is the top fix.
- Key the iframe on `url` (or bump `reloadNonce` on url change) so a rebuild shows the NEW app (Bug A).
- After the boot watchdog, flip stuck `starting` → failed/Retry (Bug C).

### Disambiguators (owner)
- Fresh build vs reopen/after-restart? reopen ⇒ B. Wrong (older) app after "şunu değiştir"? ⇒ A. Spinner forever? ⇒ C.

---
_Sacred constraints for any fix: gates render in chat, iframe sandbox (`allow-scripts allow-forms allow-popups`, no `allow-same-origin`) + `/preview/` allowlist, SSE fold (additive only — no new authority), `AkisChat key={threadKey}` not remounted, no FE gate minting._
