# BYO-account connect & sign-out — use-cases + business requirements

> **Feature:** a signed-in AKIS user connects **their own** Atlassian (Jira/Confluence) and GitHub
> accounts with **one click** (a browser-OAuth redirect, no pasted tokens) and can **sign out**
> (disconnect) any of them at any time. AKIS then acts on resources the *user* owns — never a shared
> server identity. The MCP servers are the **official vendor endpoints** (GitHub
> `api.githubcopilot.com/mcp/` + the `ghcr.io/github/github-mcp-server` image; Atlassian Rovo
> `mcp.atlassian.com/v1/mcp/authv2`), so connecting inherently requires the owner's own browser OAuth.
>
> This doc is derived from a code-grounded analysis (the routes/store/UI below) + the PR16 hardening.
> Status: the connect/sign-out surface is SHIPPED + tested; the only live-gated step is the owner
> actually authenticating to a real vendor account (see §5).

## 1. Surfaces (where it lives)

| Concern | Backend | Frontend | Store |
|---|---|---|---|
| Atlassian + GitHub-MCP connect/callback/status/disconnect | `api/mcpConnect.routes.ts` (`GET /mcp/:provider/connect`·`/callback`·`/status`, `DELETE /mcp/:provider`) | `pages/McpConnections.tsx` | `JsonFileRemoteMcpAuthStore` (AES-GCM, AAD `akis:mcp-conn:<provider>:<uid>`) |
| GitHub gated-push connect | `api/githubConnect.routes.ts` (`GET /auth/github/connect`·`/callback`·`/status`, `DELETE /auth/github`) | `pages/GitHubConnection.tsx` | `GitHubConnectionStore` (AES-GCM, AAD `akis:github-conn:`) |
| OAuth state (CSRF + identity) | `auth/oauth.ts` (`signConnectState`/`verifyConnectState`, HMAC-SHA256, TTL ≤600s, timing-safe) | — | — |
| Per-owner transport (just-in-time) | `api/mcpConnect.routes.ts` (`mcpTransportFor`) | — | — |

There are **three independent connections**, each isolated by an encrypted `(user, provider)` row:
**Atlassian** (Rovo MCP), **GitHub-MCP** (`api.githubcopilot.com`), and **GitHub-push** (the gated-push
delivery target `owner/name`). Connecting/disconnecting one never affects another.

## 2. Use-cases

| ID | Title | Actor | Acceptance (testable) |
|---|---|---|---|
| **UC-01** | One-click connect own **Atlassian** via browser OAuth + DCR | signed-in owner | Click *Connect* → full-page 302 to `mcp.atlassian.com` → consent → back to `/settings?mcp=connected`; card flips to *Connected* + *Disconnect*; `GET /mcp/atlassian/status` → `{connected:true, scopes}` but **never a token**; tokens AES-GCM at rest; spent PKCE verifier cleared. |
| **UC-02** | One-click connect own **GitHub (MCP)** | owner | Same OAuth path against `api.githubcopilot.com/mcp/`; status returns only `{connected}(+scopes)`; a state signed for `atlassian` is refused on the `github` callback (`st.repo!=='github'`). Separate from UC-03. |
| **UC-03** | Connect own **GitHub for gated-push** (target `owner/name`) | owner | *Connect* is disabled until a valid `owner/name` is typed; `/auth/github/connect?repo=…` → consent → `?github=connected`; card shows username + repo + scope chips + connectedAt; status never returns the token; the per-user token becomes the **preferred** push credential — the push **gate is untouched**. |
| **UC-04** | **Sign out** a connected Atlassian / GitHub-MCP account | owner | *Disconnect* → `window.confirm` → `DELETE /mcp/:provider` → `store.remove` wipes clientInfo+tokens+verifier → `{ok:true}`; card returns to *Connect*; a **cancelled** confirm makes **no** server call; anonymous DELETE → 401; owner-scoped (never affects another user/provider). |
| **UC-05** | **Sign out** the GitHub-push connection | owner | *Disconnect* → confirm → `DELETE /auth/github` → `{removed:true}`; status `connected:false`; future pushes fall back to the server-wide env credential (if any). |
| **UC-06** | Owner **denies consent** at the provider | owner | Provider returns `?error=access_denied` → `?{mcp|github}=denied` banner; **nothing stored**; no token exchange; the raw provider error is **not** echoed. |
| **UC-07** | Callback **error / forged-or-stale state / expired PKCE** | owner or attacker | A missing/forged/expired/cross-user/cross-provider state is refused with **no** token exchange + **no** storage; an exchange/PKCE failure → `?…=error` with no internal detail/stack/token; `timingSafeEqual` MAC compare (no timing oracle). |
| **UC-08** | Connect while **encryption (or the GitHub OAuth app) is not configured** | owner | Fail-closed **before** any vendor redirect: `?{mcp|github}=unavailable`; the push `status.configured=false` so the FE hides the Connect button; no partial/unencrypted credential is ever written (no live authorization burned). |
| **UC-09** | **Disconnect mid-build**, then confirm an external write | owner | The transport is resolved **just-in-time per confirm** (`mcpTransportFor`); after disconnect a confirm returns a clean **409 NotConnected** (not 500, not a partial write); the proposal stays `proposed` + re-confirmable after reconnect; revocation takes effect immediately. |
| **UC-10** | **Anonymous** user hits any connect/status/disconnect route | visitor | `GET /mcp/:provider/connect`·`/status`, `DELETE /mcp/:provider`, and the GitHub equivalents → **401** (never 404, never creates state). The **callback** is *state*-gated (it must work under SameSite=Strict where the cookie is dropped) — it redirects `?…=denied` on a bad state rather than 401. No route ever mints a session. |
| **UC-11** | GitHub-push connect with a **malformed/missing repo** | owner | `parseOwnerRepo` rejects → **400 BadRepo** before any provider round-trip; the repo is untrusted input, shape-validated server-side, and the validated `owner/name` is what gets bound into the signed state. |
| **UC-12** | **Reconnect** after disconnect | owner | The same one-click flow re-runs; MCP re-registers a DCR client + fresh PKCE/consent; if valid tokens somehow remain, connect short-circuits to `?mcp=connected` (AUTHORIZED) without re-prompting; the next external-write confirm succeeds. |
| **UC-13** | **Multi-provider** — connect Atlassian **and** GitHub independently | owner | Both connect at once, each with its own Connected/Disconnect state; a state signed for one provider can't complete another's callback; disconnecting one leaves the others intact; each provider's tokens live in an isolated encrypted `(user,provider)` row. |

## 3. Business requirements

### Functional
- **F1 — Bring-your-own-account:** a signed-in user connects THEIR own GitHub / Atlassian / GitHub-MCP account so AKIS acts on resources the user owns, never a shared server identity.
- **F2 — Browser-OAuth, zero-paste:** connecting is a full-page redirect into the vendor's OAuth flow (never an XHR, never a pasted PAT). Connect controls are `<a href>` links that leave the SPA.
- **F3 — Per-provider registry:** `atlassian` → `mcp.atlassian.com/v1/mcp/authv2` (streamable-http; offline_access + read/write jira-work + read/write confluence-content + read confluence-space); `github` → `api.githubcopilot.com/mcp/` (server-default scope).
- **F4 — DCR (Atlassian):** no pre-registered OAuth app; the MCP SDK self-registers a public PKCE client and persists the registered clientInfo for reuse.
- **F5 — PKCE authorization-code:** the SDK generates + persists a transient `code_verifier` on connect; the callback exchanges code+verifier for tokens; the route overrides only the OAuth `state` (PKCE stays SDK-driven).
- **F6 — Server-side OAuth bridge:** `StoreBackedOAuthProvider` CAPTURES the authorize URL (the browser is the user's, not a desktop client); two-leg `auth()`: leg 1 → `REDIRECT`+URL, leg 2 → `AUTHORIZED`+tokens.
- **F7 — Honest, secret-free status:** `status` returns `{connected, scopes?}` (MCP) / `{connected, configured, username?, repo?, scopes?, connectedAt?}` (push) and **never a token**; `configured` reflects BOTH the OAuth app AND encryption so the UI never shows a button that would fail at storage time.
- **F8 — Idempotent sign-out:** `DELETE` removes the connection and returns success even if nothing was stored; the FE gates both behind `window.confirm` and reloads status after.
- **F9 — Auto-refresh:** the SDK auto-refreshes on 401 and re-persists rotated tokens; the Atlassian store additionally records `expiresAt` + a refresh pair.
- **F10 — Just-in-time per-owner transport:** `mcpTransportFor` builds a transport ONLY when that provider is connected for that owner (tokens present), else `undefined` (honest absence → graceful 409, never a crash).
- **F11 — Connect tokens are storage-only:** the connection token is NEVER reused to mint a session or mutate a user — the callback emits **no `Set-Cookie`**.

### Non-functional
- **N1 — Tokens encrypted at rest (AES-256-GCM):** every secret (GitHub token; Atlassian access+refresh; MCP clientInfo+tokens+verifier) is encrypted before touching disk, `0600`, under `~/.config/akis` (outside the repo). Plaintext exists only transiently in memory.
- **N2 — Per-store AAD isolation:** distinct AAD scopes (`akis:ai-key:`, `akis:github-conn:`, `akis:atlassian-conn:`, `akis:mcp-conn:<provider>:<uid>`) so a ciphertext can never be replayed across stores/providers/users.
- **N3 — Secrets never in argv/logs/URLs/bodies/headers:** redirects carry only a coarse status (`?mcp=connected|error|denied|unavailable|unknown`); errors are caught + surfaced token-free.
- **N4 — OAuth-state CSRF + identity:** a ≤600s HMAC-SHA256 signed `state` binds `userId` AND target (repo/provider) inside the MAC'd body, constant-time compared. This is the **sole unforgeable identity binding** (the callback is state-first so it works under SameSite=Strict where the cookie is dropped); a cookie, when present, is only a defense-in-depth cross-check. *(PR16 aligned the MCP callback to this proven GitHub-flow pattern.)*
- **N5 — Owner-scope / isolation:** every connect/status/disconnect route is owner-scoped (401 unauth); stores key by `(userId[,provider])`; one user's row is invisible to another.
- **N6 — Fail-closed encryption preflight:** connect never starts an OAuth flow it cannot persist (`canStore()` checked before minting any vendor authorization).
- **N7 — Honest status under key loss:** a row whose secret no longer decrypts (rotated/unset master key, corrupt file) is reported as NOT connected (and `getToken` returns undefined, never throws) — no split-brain where the UI shows a connection the action path can't use.
- **N8 — Official-vendor-only endpoints:** the only OAuth/MCP targets are the official vendor endpoints; no proxy/broker — so connecting inherently requires the owner's own browser OAuth.
- **N9 — No gate weakening:** connecting grants only the CAPABILITY (scopes incl. write); the agent can still only PROPOSE — every external write/push stays human-confirmed (digest + allow-list) and at-most-once (durable in-doubt `executing` guard). The connect feature never autonomously writes.
- **N10 — Untrusted-input validation:** the `repo` param is shape-validated to `owner/name` (400 BadRepo) before being signed/used; granted scopes parse fail-closed to `[]` when absent.
- **N11 — Restart durability:** JSON-file stores reload encrypted rows after a restart; under `NODE_ENV=test` in-memory stores are used (no test writes the real `~/.config/akis`).
- **N12 — Spent-credential hygiene:** the transient PKCE `code_verifier` is cleared immediately after a successful exchange and is never persisted in plaintext.

## 4. PR16 hardening (this feature, 2026-06-07)
- **#2** the MCP `/callback` is now **state-first** (Strict-safe) — it no longer 401s on a missing cookie; `st.userId` is the authoritative identity, the cookie is defense-in-depth (mirrors `/auth/github/callback`). Gate-keeper-reviewed: no auth-bypass, no gate weakening.
- **#1** `DELETE /mcp/:provider` now **404s an unknown provider** (parity with `/status`) instead of a silent `{ok:true}` + a pointless persist.
- **#4** the MCP card renders the granted **scopes** as chips (parity with the GitHub card).
- Tests: callback connects under Strict (no cookie); present-but-mismatched cookie → denied; DELETE-unknown → 404; disconnect idempotent.

## 5. Status — what's live vs owner-gated
- **SHIPPED + tested:** the full connect/callback/status/disconnect surface for all three connections; OAuth/DCR/PKCE; encrypted store; CSRF state; owner-scope; fail-closed preflight; the FE cards (connect link + confirm-guarded sign-out + status + scopes).
- **Owner-gated (needs the owner's real account, NOT a code gap):** actually authenticating to a real Atlassian/GitHub account (org-admin Rovo MCP enablement + the owner's browser OAuth consent), pinning the real tool-names/payloads against a live `listTools()`, and wiring the connected **read** tools into the agent loop (a live transport resolver + a "when should an agent pull Jira/Confluence context" product decision). See `docs/plans/2026-06-07-atlassian-mcp-track-plan.md`.
