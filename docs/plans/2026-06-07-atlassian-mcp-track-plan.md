# Atlassian MCP Track — Slice Map

> **Track goal:** let an AKIS agent (Scribe) draft Jira issues / Confluence pages from a verified
> build, and **write them to a user's Atlassian site only after an explicit human confirmation** of
> the exact content — the same producer→human→server-executes discipline as the push gate.
>
> Status: living plan. Slices 1–3 are SHIPPED but **dormant** (no transport/route/agent wiring yet).
> This doc maps what exists, the wiring slices ahead, and the carry-over review notes that must be
> closed before the track goes live.

## 0. Invariant (do not weaken)

An agent can only **propose** an external write; it can **never** perform one. A write executes only
after an explicit human confirm, and only of the **exact bytes** the human saw. This is orthogonal to
the 4 structural build gates (spec-approval, producer≠verifier, verified-real, push) — the
external-write gate neither reads nor mints any of them. No slice below may collapse the
propose→confirm→execute split or let the agent hold the approval token.

## 1. Shipped (dormant) — slices 1–3

| Slice | Unit | File | What it gives us |
|---|---|---|---|
| 1 | external-write gate keystone | `backend/src/gates/externalWriteGate.ts` | `ExternalWriteProposal`, `digestExternalWrite`, NOMINAL-branded `ApprovedExternalWrite`, `mintApprovedExternalWrite` (digest-match required), `executeExternalWrite` (token + digest re-check). Pure. |
| 2 | remote MCP transport | `backend/src/agent/mcp/HttpMcpTransport.ts` | Same `McpTransport` seam as `StdioDockerTransport`, over SSE+`Authorization: Bearer`. Token travels only as a header (never argv/log); every connect error → token-free `McpUnavailableError`. |
| 3 | per-user connection store | `backend/src/keys/AtlassianConnectionStore.ts` | Per-user AES-256-GCM access+refresh token pair under AAD `akis:atlassian-conn:<userId>`. `status()` is secret-free; undecryptable rows read as **absent** (fail-closed). JsonFile (0600) + in-memory variants. |

Tests: `backend/test/unit/external-write-gate.test.ts` (9), `http-mcp-transport.test.ts` (7),
`atlassian-connection-store.test.ts` (5). All three units are **unreferenced** outside their own files
and tests (verified: nothing in `backend/src/di` or `backend/src/api` imports them) — the track is
inert until the wiring slices land.

## 2. Wiring slices ahead

These are intentionally atom-sized; each is independently testable and must keep the §0 invariant.

### Slice 4 — OAuth routes (connect / callback / refresh)

Mirror `backend/src/api/githubConnect.routes.ts` (and the `auth/oauth.ts` helpers) for Atlassian's
OAuth 2.1 (3LO) flow against the connection store:

- `GET /auth/atlassian/connect` — authenticated; **fail-closed preflight** (OAuth app configured AND
  `connections.canStore()` true) **before** minting an authorization we can't complete; signed,
  short-TTL state (reuse the `signConnectState`/`verifyConnectState` shape).
- `GET /auth/atlassian/callback` — verify state, exchange code → access+refresh, resolve `cloudId` +
  `siteUrl` (Atlassian accessible-resources), `connections.set(userId, …)`. Redirect with **only**
  `?atlassian=connected|error|denied|unavailable` — the token never appears in any URL/log/body.
- **Refresh** — `status().expiresAt` already drives this; on a near/after-expiry token, refresh via
  the refresh token and re-`set()`. Belongs server-side on the write-execute path, not a public route.

Token discipline identical to the GitHub route: no `users` dep, never mints a session cookie, the
Atlassian token is **never** reused as a login/session credential.

### Slice 5 — proposal flow (propose → confirm → execute, wired to a route)

- A producer records an `ExternalWriteProposal` during a build (recorded, **not** executed).
- A confirm route loads the stored proposal, the UI renders `proposal.summary` + the content, and the
  user confirms. The route calls `mintApprovedExternalWrite(proposal, confirmedDigest)` then
  `executeExternalWrite(token, transport, proposal)`, where `transport` is an `HttpMcpTransport`
  carrying the (refreshed) access token for that user.
- See carry-over note **B** for how `confirmedDigest` must be sourced.

### Slice 6 — agent wiring (Scribe proposes via the MCP bridge)

Expose the Atlassian server's tools to the agent through `McpToolBridge` (slice-2 transport), so
Scribe can *read* Jira/Confluence context and *emit proposals* for writes. The bridge already
namespaces tools and bounds result size; the Atlassian write tools must be gated exactly like §0 — a
write tool surfaced to the agent is a **proposal emitter**, not a direct call. See carry-over note
**A** (the bridge needs a positive Atlassian write allow-list, parallel to `readOnlyAllowlist.ts`).

## 3. Carry-over review notes (close before go-live)

These were flagged during slices 1–3 review and deliberately deferred. Each is a real boundary, not
polish.

### A. Write-tool allow-list (defense-in-depth, parallel to the read-only set)

`ExternalWriteProposal.action`'s doc says it "must be on the provider's write allow-list" — **but no
such list exists yet.** `backend/src/agent/mcp/readOnlyAllowlist.ts` gives a frozen, mutator-neutered
positive set for GitHub reads; the Atlassian write track needs the symmetric thing: a frozen positive
set of permitted Atlassian write-tool names (e.g. `createPage`, `createJiraIssue`), checked at mint
and/or execute, so a server-advertised tool outside the set can never execute even with a valid
token. Land this with slice 6 (the bridge is where it's enforced).

### B. UI-displayed digest into mint (no server-side recompute)

`mintApprovedExternalWrite(proposal, confirmedDigest)` is sound **only if** `confirmedDigest` is the
digest of the bytes the human actually saw. The confirm route must pass the digest the **UI
displayed** (echoed back from the client), not recompute it server-side from the stored proposal —
otherwise a display/store divergence would be approved silently and the mint check becomes a no-op.
Slice 5's confirm endpoint must carry the displayed digest end-to-end.

### C. Owner-scoping (proposal/connection bound to the same user)

The gate has **no `userId`/owner field**: `executeExternalWrite` does not bind a proposal to the user
whose Atlassian connection (and thus token/transport) is used. Before go-live, the execute path must
ensure the confirming user owns both the proposal and the connection supplying the transport — so user
A can't confirm a write that lands on user B's site. Enforce at the route/seam (where `userId` is
known), keeping the gate pure.

### D. Deeper canonicalization (digest stability for nested payloads)

`digestExternalWrite` sorts keys **one level deep** only (`sortKeys` top-level). Today's
target/payload are flat, so the digest is stable; a nested payload would hash by JSON insertion order
and could let two semantically-equal payloads digest differently (or, worse, mask a meaningful
reorder). Before any nested payload shape is introduced, make canonicalization recursive (sort keys at
every depth) and add a digest-stability test for the nested case.

## 4. Non-goals (this track)

- No change to the 4 structural build gates or any security boundary (iframe sandbox, key handling,
  gate enforcement).
- No autonomy framing — the claim is **human-confirmed, content-bound** external writes.
- No new provider beyond Atlassian (the gate's `ExternalWriteProvider` is extensible later).
