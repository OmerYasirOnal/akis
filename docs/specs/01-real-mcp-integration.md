# SPEC 01 — Real MCP integration: agents that genuinely use MCP (Atlassian + GitHub) over browser-OAuth

Status: DRAFT (feat/real-mcp worktree) · Owner-decision points flagged 🔶 · Live-only verification flagged 🔴
Grounds: the reference research (akisflow = akis-platform main), the Atlassian Rovo Remote MCP docs, the GitHub Remote MCP GA, and the @modelcontextprotocol/sdk 1.29 auth surface.

## 0. Vision (the owner's mandate)

> "Our agents must REALLY use MCP. The user shouldn't even need a separate login — when they connect with their Jira account it authorizes directly in their account. Do something similar for GitHub. Find the best method."

The best method is now clear and is the SAME shape for both providers:

- Use each vendor's **hosted REMOTE MCP server** over **Streamable HTTP**, authenticated by a **browser-based OAuth 2.1 + PKCE** flow that the **MCP SDK drives for us**. The user clicks "Connect Jira/Confluence" (or "Connect GitHub"), authorizes **once in their own vendor account** in the browser, and AKIS stores the resulting tokens (auto-refreshed). No PAT to paste; for Atlassian, **no OAuth app to register** (Dynamic Client Registration).
- The agent loop then calls **real MCP tools** on those servers: reads for grounding (already done for GitHub stdio today) and, for writes, **proposes** — a human confirms — then the server executes (the external-write gate, slice 1, already built).

This makes MCP first-class: the same `McpTransport` seam, the same tool-bridge, the same agent loop — just real remote servers with real user identity.

## 1. The endpoints + transport (verified)

| Provider | Remote MCP URL | Transport | Auth |
|---|---|---|---|
| Atlassian (Jira/Confluence/Compass) | `https://mcp.atlassian.com/v1/mcp/authv2` (legacy `…/v1/sse` dies 2026-06-30) | Streamable HTTP | OAuth 2.1 + **DCR** (no app), browser consent; admin must enable Rovo MCP + allowed domains |
| GitHub | `https://api.githubcopilot.com/mcp/` (GA 2025-09) | Streamable HTTP | OAuth 2.1 + PKCE (one-click) **or** PAT (Bearer) |

SDK 1.29 ships `client/streamableHttp.js` (StreamableHTTPClientTransport), `client/sse.js`, and `client/auth.js` (OAuthClientProvider with DCR + PKCE). So everything is available without an SDK upgrade. (Our current `HttpMcpTransport` uses SSE+static-bearer — keep it as the PAT/legacy path; ADD a StreamableHTTP+OAuth path. See §4.)

## 2. The auth architecture — driving the SDK OAuth provider in a SERVER (the crux)

The SDK's `OAuthClientProvider` (client/auth.ts) was designed for a desktop client that owns the browser. AKIS is a multi-user SERVER: the browser belongs to the user and the redirect/callback happen out-of-band. We bridge this with a **per-user, store-backed provider** + two routes.

`OAuthClientProvider` surface we implement (per user):
- `redirectUrl` → `${PUBLIC_BASE_URL}/mcp/<provider>/callback`
- `clientMetadata` → `{ client_name: 'AKIS', redirect_uris, scope, … }`
- `clientInformation()` / `saveClientInformation(info)` → **DCR**: the SDK registers a client with the server on first use; we persist the returned client_id (+ secret) per user/provider so later sessions reuse it.
- `tokens()` / `saveTokens(t)` → load/store the access+refresh tokens (our connection store).
- `saveCodeVerifier(v)` / `codeVerifier()` → PKCE verifier, stored transiently per pending-connect (keyed by state).
- `redirectToAuthorization(url)` → **does NOT redirect server-side**; it CAPTURES the URL so the connect route can 302 the user's browser to it.

Flow (per provider, mirrors `githubConnect.routes.ts` shape):

1. `GET /mcp/<provider>/connect` (requireAuth) → build the per-user provider → call the SDK `auth()` helper (or `transport.start()` which throws `UnauthorizedError`) → the provider captures the authorization URL → 302 the browser there. PKCE verifier + DCR client info persisted, state binds userId.
2. User authorizes in their Atlassian/GitHub account (browser) → vendor redirects to `GET /mcp/<provider>/callback?code=…&state=…`.
3. Callback verifies state (HMAC, userId-bound) → SDK `finishAuth(code)` → exchanges code (PKCE) → `saveTokens` persists access+refresh + (Atlassian) cloudId via accessible-resources. Redirect home.
4. Later, when an agent needs the server: build `StreamableHTTPClientTransport(url, { authProvider })` with the SAME per-user provider → the SDK attaches the bearer, **auto-refreshes** on 401 using the stored refresh token, and re-`saveTokens` the rotated pair. No hand-rolled refresh helper needed (the SDK does it through the provider).

🔶 Owner decision: do we let the SDK do **DCR** (Atlassian — zero app registration, simplest) and **PKCE public-client** (GitHub — may still need a one-time GitHub OAuth app or GitHub's hosted client). Default: DCR where supported, else a single registered app.

🔴 Live-only: the exact DCR + consent round-trip can only be fully validated against the real `mcp.atlassian.com` / `api.githubcopilot.com` with a real account + (Atlassian) an admin who has enabled Rovo MCP.

## 3. Storage (extend the slice-3 store)

`AtlassianConnectionStore` (slice 3) already holds an encrypted `{accessToken, refreshToken}` + cloudId/siteUrl/scopes/expiresAt per user. Extend the model to ALSO hold the **DCR client information** (client_id [+ secret], registered with the server) so `clientInformation()` can return it. Generalize to a `RemoteMcpConnectionStore` keyed by `(userId, provider)` so GitHub reuses the same encrypted store (distinct AAD per provider: `akis:mcp-conn:<provider>:<userId>`). The PKCE verifier is transient (keyed by the connect `state`, short TTL, in-memory or a tiny table) — never long-lived.

Secrets discipline (unchanged invariant): tokens + client secret encrypted at rest (AES-256-GCM), never argv/log; status() exposes only non-secret metadata; fail-closed on undecryptable.

## 4. Transport wiring

- KEEP `HttpMcpTransport` (SSE+bearer) — it remains the **PAT path** (GitHub PAT, or Atlassian API-token where an admin enabled it) and the legacy `/v1/sse` until 2026-06-30.
- ADD a StreamableHTTP variant (or extend `HttpMcpTransport` with a `kind: 'sse' | 'streamable-http'` + an optional `authProvider` instead of a static token). When `authProvider` is given, the SDK owns auth+refresh; when a static `token` is given, we inject the Bearer (today's behavior).
- A per-user factory `mcpTransportFor(userId, provider)`: resolve the connection → if OAuth, build the provider-backed StreamableHTTP transport; if PAT, the bearer transport; else honest-absence (no tools).

## 5. The tool surface — reads (now) + gated writes (new)

> **STATUS (PR7, 2026-06-07):** the read SURFACE is built — `McpToolBridge` is now provider-agnostic
> (`buildMcpReadTools` + `buildAtlassianMcpReadTools`, namespace `atlassian_`) and a FROZEN
> `ATLASSIAN_READONLY_TOOLS` allow-list mirrors `GITHUB_READONLY_TOOLS`. **OWNER/LIVE-GATED next steps:**
> (a) the allow-list names are the Atlassian-documented Rovo names PENDING validation against a live
> `listTools()` — the bridge's dropped-tool diagnostic logs the server's real advertised names so the
> owner reconciles the set on first connect (fail-closed until then: a stale name is inert, never
> mis-called); (b) WIRING these read tools into the agent loop (the per-owner resolver, like the
> github-stdio path) is the remaining live-gated step. Writes still flow ONLY through the
> human-confirmed external-write gate — never a direct read-bridge call.

- **Reads** flow through the now provider-agnostic `McpToolBridge` + a per-provider FROZEN read allow-list (`GITHUB_READONLY_TOOLS` / `ATLASSIAN_READONLY_TOOLS`): Jira search/read, Confluence list-spaces/get-page, GitHub repo/issue/PR reads. Admitted into the agent loop for grounding. (Atlassian "data access respects the user's permissions" — the server enforces; we still allow-list names.)
- **Writes** NEVER auto-execute. A write tool surfaced by the server is bridged to a **propose** handler: it records an `ExternalWriteProposal {provider, action(=real MCP tool name), summary, target, payload}` (slice-1 gate) and returns "proposed — pending human confirmation" to the agent. The agent continues; the build never blocks on a remote write.
- A separate per-provider WRITE allow-list (`create_issue`, `create_page`, GitHub `create_or_update_file`/`create_pull_request` IF we route writes via MCP — see §7) gates which tool names may be proposed at all.

Tool names + payloads come from `transport.listTools()` at runtime — 🔴 do NOT hardcode the old repo's custom-gateway names; discover the real ones live. Reference payload shapes (to expect): Confluence page `{spaceKey, parentId?, title, content(storage/XHTML or markdown per inputSchema)}`; Jira issue `{projectKey, summary, description?, issueType, …}`.

## 6. The confirm → execute path (new routes + FE)

- `GET /external-writes` (owner-scoped) → the pending proposals (summary/target/payload/digest).
- `POST /external-writes/:id/confirm` (body: the displayed digest) → `mintApprovedExternalWrite(proposal, digest)` (slice 1) → `mcpTransportFor(ownerId, provider)` → `executeExternalWrite(token, transport, proposal)` → SURFACE the result (page/issue URL) or the error (never swallow — verifiability product).
- FE: a confirm card showing exactly what will be written + a "Publish to Confluence / Create Jira issue" affordance; an explicit "not connected → connect first" state. Settings tiles: Connect Jira/Confluence, Connect GitHub (status/disconnect).

## 7. GitHub: MCP vs the existing REST push (🔶 decision)

Two GitHub write surfaces now exist:
- (a) The existing **gated push** (`pushGate` + `RealGitHubAdapter` REST: branch → commit → PR) — verified-code, digest-bound, the build's canonical ship path. KEEP THIS as the primary "ship the app" path.
- (b) The new **remote GitHub MCP** (OAuth) — better for ad-hoc reads + (optionally) doc/file writes the agent proposes.

Recommended: ship the built app via (a) [it's digest-bound to the VerifyToken — provenance]; use (b) for reads (grounding) and for the OAuth UX so a user connects GitHub with one click (no PAT). Do NOT route the verified-app push through MCP (it would lose the digest-binding provenance). A Scribe-authored doc that is PART of the app ships via (a) too (see SPEC: it's in the file set). A doc the user wants in a Confluence space goes via (b)+the gate.

🔶 Owner decision: is the custom Docker `github-mcp-server` (stdio, PAT) still wanted at all? With the remote GitHub MCP (OAuth), the Docker path is redundant on a box that has network egress. Recommendation: keep the remote OAuth MCP as default; the Docker stdio becomes an air-gapped/self-host fallback. (Answers the owner's "do we even need to write a Docker GitHub MCP" — no, prefer the hosted remote one.)

## 8. Make GitHub push actually work (the "push wasn't open" fix — P0, config-only today)

Push code is COMPLETE; it is default-OFF. Today, with no token, `selectGitHubAdapter` returns the mock (returns ok + a fake `github.com/mock/<id>` URL → looks like success, ships nothing).
- Fastest (single-owner): set `AKIS_GITHUB_PUSH_TOKEN` (fine-grained PAT: Contents + PRs write) + `AKIS_GITHUB_PUSH_REPO=owner/name`, `NODE_ENV`≠test → real PR. 🔴 needs a PAT + live verify (a real PR appears).
- Proper (per-user): the remote GitHub MCP OAuth connect (§2) OR the existing per-user GitHub OAuth connect (`githubConnect.routes.ts`, code already there) → push to the user's own repo. Needs a GitHub OAuth app + `GITHUB_OAUTH_CLIENT_ID/SECRET` + `AI_KEY_ENCRYPTION_KEY` + callback URLs for `/oauth/github/callback` (login) AND `/auth/github/callback` (connect).

## 9. Sacred invariants (must hold)

- The 4 build gates (spec-approval, producer≠verifier, verified-real, push) are untouched; this feature is orthogonal.
- No model-autonomous outward write — every Jira/Confluence/MCP write is human-confirmed via the external-write gate (the prompt-injection firewall: untrusted generated/remote content may PROPOSE, never WRITE).
- Tokens/secrets encrypted at rest, never argv/log; token-free MCP errors; fail-closed on no-connection.
- External/remote MCP content is EPHEMERAL — never RAG-ingested (a tool-event read cannot be persisted into the knowledge base; matches today's github-read rule).
- Signup stays closed; the MCP connect routes require an authenticated owner (requireAuth), never create accounts.

## 10. Build slices (each: code → unit tests → gate-keeper → commit on feat/real-mcp)

1. ✅ slice 1 — external-write gate keystone (DONE, on main).
2. ✅ slice 2 — HttpMcpTransport SSE+bearer (DONE; becomes the PAT/legacy path).
3. ✅ slice 3 — encrypted connection store (DONE; generalize to RemoteMcpConnectionStore in slice 5).
4. slice 4 — StreamableHTTP transport + the server-side OAuthClientProvider adapter (DCR+PKCE), unit-tested with a fake SDK auth.
5. slice 5 — generalize the store to (userId, provider) + DCR client-info; the `mcp/<provider>/connect` + `/callback` routes (mirror githubConnect); DI factory `mcpTransportFor`.
6. slice 6 — read allow-lists (Jira/Confluence/GitHub) + the write-propose bridge + the `/external-writes` list + `/confirm` route.
7. slice 7 — FE: Settings connect tiles + the confirm card + the "publish docs to Confluence / open Jira issue" affordances.
8. slice 8 — agent wiring: surface the per-user MCP read tools into Scribe/Proto grounding + the propose tools; observability on the live stream.
9. slice 9 — GitHub push real (config + the per-user path) + docs.
10. slice 10 — 🔴 live e2e against real Atlassian + GitHub (connect → read → propose → confirm → a real Jira issue + Confluence page + a real GitHub PR); then merge feat/real-mcp → main + redeploy.

Unit-testable offline (do first, no creds): the provider adapter (fake SDK), the routes (inject HttpFetch + fake state), the store, the propose→digest→mint→execute path (fake transport), the read allow-lists, the Scribe-docs pipeline. 🔴 Live-only: real tool names/inputSchemas, cloudId routing, DCR consent, a real issue/page/PR.
