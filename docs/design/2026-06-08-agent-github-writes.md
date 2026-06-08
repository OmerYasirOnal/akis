# AKIS — Agent-proposed GitHub writes (gate-safe)

> **Status:** design + requirements. Ground-truthed against a live `tools/list` query to `https://api.githubcopilot.com/mcp/` (44 tools advertised) and against the shipped gate/route/store code in the repo. The propose→confirm→execute boundary and the `externalWrites` store field already exist; this document specifies the agent-propose side that plugs into them.

---

## 1. Goal & the gate-safe principle

### 1.1 Goal

Let AKIS's pipeline agents (AKIS-orchestrator, Scribe, Proto, Trace, Critic) carry their work **out into GitHub** — open the delivery PR, post the real-test review verdict, comment the build result on the originating issue, close the tracking issue, merge once verified — **without ever becoming autonomous over those side effects.** Every GitHub mutation an agent wants is recorded as a *proposal* that a human reads and confirms before the server executes it.

This is AKIS's verifiability-layer thesis landing where it matters: an independent, real-test verdict and a portable "build passport" written **into the repo**, in GitHub's own review/merge mechanisms, where a teammate or branch-protection rule actually sees it.

### 1.2 The gate-safe principle (agent proposes · human confirms · server executes)

```
agent ──proposes──▶ ExternalWriteProposal {provider:'github', action, target, payload, summary}
                    │  recorded as a status:'proposed' record in session.externalWrites
                    │  NOTHING EXECUTES
                    ▼
human  ──reads──▶   confirm card renders the EXACT bound content (digest), clicks Confirm
                    │  mintApprovedExternalWrite binds SHA-256(provider,action,target,payload)
                    ▼
server ──executes──▶ executeExternalWrite re-checks digest + allow-list, calls transport.callTool
```

The model is **never** autonomous over the side effect. Concretely, this is enforced structurally (see §5), not by convention:

- An agent can only **append** a `status:'proposed'` record. It has no reference to the minting function, cannot fabricate the branded approval token, cannot call the executor, and cannot widen the allow-list.
- Execution is reachable **only** through the human-hit confirm route, which requires a human-supplied digest matching the stored content byte-for-byte.

---

## 2. GitHub write-action catalog

These are the **exact live MCP tool names** confirmed against the GitHub Copilot MCP server (issues / PRs / reviews scope). Pin the **literal** names — there is **no consolidated `pull_request_write` tool**; PR create/update/close/merge are separate tools, and pinning a guessed name would make every PR write silently refuse.

> **Naming is load-bearing and inconsistent** — the gate passes args through verbatim with no normalization: **issues use snake_case `issue_number`; PRs/reviews use camelCase `pullNumber`.** Both always carry `owner` + `repo`. A wrong key silently mis-targets.

> **Method / state / merge_method are ordinary `payload` keys.** So "create issue" vs "close issue" are two different proposals with two different digests, both using `action:'issue_write'`. A human who approves "create" can never have it silently become "close".

| MCP tool (exact) | Logical action | `target` (WHERE) | `payload` (WHAT) — key discriminators | Allow-list today | Risk |
|---|---|---|---|---|---|
| `issue_write` | open issue | `owner, repo` | `method:'create'`, `title`, `body`, `labels[]`, `assignees[]`, `milestone`, `type` | **PINNED** | Low |
| `issue_write` | **close / triage** issue | `owner, repo, issue_number` | `method:'update'`, **`state:'closed'`**, `state_reason` (`completed`\|`not_planned`\|`duplicate`), `duplicate_of`, `labels[]`, `assignees[]` | **PINNED** | **DESTRUCTIVE** (reversible: reopen) |
| `add_issue_comment` | comment on issue **or PR** (PR # as `issue_number`) | `owner, repo, issue_number` | `body` | **PINNED** | Low |
| `sub_issue_write` | link/order sub-issues | `owner, repo, issue_number, sub_issue_id`, `after_id`/`before_id` | `method:'add'\|'remove'\|'reprioritize'` | not pinned | Low |
| `create_pull_request` | **open** PR | `owner, repo` | `title`, `head`, `base`, `body`, `draft`, `maintainer_can_modify` | NEEDS ADD | Low–Med |
| `update_pull_request` | edit PR / **close** PR / request reviewers | `owner, repo, pullNumber` | `title`, `body`, **`state:'closed'`**, `base`, `draft`, `reviewers[]` | NEEDS ADD | Med (close) / Low (edit) |
| `merge_pull_request` | **MERGE** PR | `owner, repo, pullNumber` | `merge_method` (`merge`\|`squash`\|`rebase`), `commit_title`, `commit_message` | NEEDS ADD | **IRREVERSIBLE** |
| `update_pull_request_branch` | sync PR branch w/ base | `owner, repo, pullNumber` | `expectedHeadSha` (optimistic lock) | NEEDS ADD | Low–Med |
| `pull_request_review_write` | create/submit/delete review + resolve threads | `owner, repo, pullNumber`; `threadId` (resolve); `commitID` | `method:'create'\|'submit_pending'\|'delete_pending'\|'resolve_thread'\|'unresolve_thread'`, `event` (`APPROVE`\|`REQUEST_CHANGES`\|`COMMENT`), `body` | **PINNED** | Med — `APPROVE` is high-trust |
| `add_comment_to_pending_review` | line comment on caller's pending review | `owner, repo, pullNumber, path`, `line`/`startLine`/`side`/`startSide` | `body`, `subjectType` (`FILE`\|`LINE`) | NEEDS ADD | Low |
| `add_reply_to_pull_request_comment` | reply to a PR comment | `owner, repo, pullNumber, commentId` | `body` | NEEDS ADD | Low |
| `request_copilot_review` | request a Copilot review | `owner, repo, pullNumber` | *(none)* | NEEDS ADD | Low |

**The IRREVERSIBLE / DESTRUCTIVE markers:**

- **`merge_pull_request` — IRREVERSIBLE.** Mutates the default branch, can trigger deploys, the `merge`/`squash`/`rebase` choice rewrites history shape; revert is a *new* PR and never un-rings the deploy/notification bell. This is the single highest-value reason the gate exists for GitHub.
- **Close** (`issue_write` / `update_pull_request` with `state:'closed'`) — **DESTRUCTIVE-ish:** recoverable (reopen) but disruptive and notifies people; closing with the wrong `state_reason:'not_planned'` mis-signals to contributors.
- **`pull_request_review_write` with `event:'APPROVE'`** — high-trust: can satisfy a branch-protection required-review and thereby **unblock a merge** — same downstream effect as a merge. `resolve_thread` similarly can unblock under "require conversation resolution".

**Currently pinned set** (`GITHUB_WRITE_ACTIONS`, `externalWriteGate.ts` L153-157) — exactly three: `issue_write`, `add_issue_comment`, `pull_request_review_write`. Every use-case on these three is **executable now**; everything else is blocked at propose time (`isAllowedExternalWriteAction` → 400 `BadAction`) until its literal name is added to the frozen set **with a confirm flow**. The set's standing TODO: add a name **only** when the provider advertises it AND a human-confirm flow exists — all the NEEDS-ADD names above are live-confirmed advertised.

---

## 3. Use-case matrix

The five roles map onto the pipeline subagents and the orchestrator. Each use-case respects that agent's actual lane and stays gate-safe (propose → human confirm → execute). De-duplicated across all three lenses (role-lens, lifecycle-lens, capability-lens) into the best single set.

| # | Agent | Trigger | Action (tool + method/state/event) | Proposed content (`target` → `payload`) | Value | Risk |
|---|---|---|---|---|---|---|
| **UC-1** | Scribe | Spec approved (Gate 1); build did NOT originate from an issue | `issue_write` `method:'create'` · **PINNED** | `{owner,repo}` → `{title:'[AKIS] <spec>', body:'goal + acceptance criteria + AKIS link', labels:['akis','spec'], type:'Feature'}` | Spec gets a durable, linkable GitHub home from the first gate; checkbox criteria (same source as `deriveChecks`) get ticked later by Trace | Low |
| **UC-2** | Scribe | Build started from issue #N; planning refined scope | `issue_write` `method:'update'` · **PINNED** | `{owner,repo,issue_number}` → `{body:'<original>\n---\n### Refined spec (Scribe)\n…'}` (**append-only**, preserves original) | Stops issue↔build drift; human confirms exactly what's appended | Low |
| **UC-3** | Scribe | Spec carries unresolved assumptions | `add_issue_comment` · **PINNED** | `{owner,repo,issue_number}` → `{body:'Scribe needs to confirm N assumptions: …'}` | Turns silent assumptions into a visible, answerable artifact in the requester's workflow | Low |
| **UC-4** | AKIS | Build verified-real + branch pushed (extends #119 gated-push path) | `create_pull_request` · **NEEDS ADD** | `{owner,repo}` → `{title:'AKIS build: <spec>', head:'akis/<sessionId>', base:'main', body:'gate trail: ApprovedSpec ✓ · VerifyToken ✓ (≥1 real test) · ApprovedPush ✓ · N real tests passing · passport <digest>', draft:false}` | The trust passport made portable — gate trail + real-test count land in GitHub where a reviewer sees it | Low–Med |
| **UC-5** | AKIS | Build linked to issue/PR #N finishes (verified OR honestly failed) | `add_issue_comment` · **PINNED** | `{owner,repo,issue_number}` → `{body:'AKIS finished. Result: verified — 7 real tests passed. Preview: <url>. Passport <hex>.'}` (a demo run says "SIMULATED, not a real pass") | Durable honest audit comment; surfaces demo-verify as such, never overclaims | Low |
| **UC-6** | AKIS | Build that *started from* issue #N reaches `done` / its PR merges | `issue_write` `method:'update', state:'closed'` · **PINNED** | `{owner,repo,issue_number}` → `{state:'closed', state_reason:'completed'}` | Closes the loop with the *correct* reason the moment a verified build lands | **DESTRUCTIVE** (reversible) |
| **UC-7** | AKIS | Human ships; PR checks green + VerifyToken→ApprovedPush chain holds | `merge_pull_request` `merge_method:'squash'` · **NEEDS ADD** | `{owner,repo,pullNumber}` → `{merge_method:'squash', commit_title:'AKIS: <spec> (verified)', commit_message:'Merged after AKIS verification: N real tests. Passport <digest>.'}` | The keystone outward write — verified build lands on `main` with a provenance-bearing commit | **IRREVERSIBLE** |
| **UC-8** | Proto | Build settles (post code-review iterate); delivery PR exists | `update_pull_request` · **NEEDS ADD** | `{owner,repo,pullNumber}` → `{body:'<existing>\n## Implemented (Proto)\nStack… · 14 files · 2 Critic rounds resolved'}` (append) | PR description reflects the real build instead of a stale stub | Low |
| **UC-9** | Proto | User requests an edit; active app is re-building (base-merge edit path) | `update_pull_request` `draft:true` · **NEEDS ADD** | `{owner,repo,pullNumber}` → `{draft:true, body:'⚠️ Re-building from approved edit; returns to ready after re-verify'}` | "Don't merge yet" signal during an in-flight edit; flips back after re-verification | Low–Med |
| **UC-10** | Proto | Approved follow-up edit re-verifies green | `add_issue_comment` (PR # as `issue_number`) · **PINNED** | `{owner,repo,issue_number}` → `{body:'Edit applied & re-verified. Changed … Re-ran 8 real tests. New passport <digest>.'}` | Each edit leaves a verified breadcrumb; PR timeline tells the evolution story | Low |
| **UC-11** | **Trace** | Trace finishes the real run on the PR head | `pull_request_review_write` `method:'create', event:APPROVE\|REQUEST_CHANGES\|COMMENT` · **PINNED** | pass→`{event:'APPROVE', body:'Trace — 9 real tests passed. REAL pass (not simulated). Passport <hex>'}`; fail→`{event:'REQUEST_CHANGES', body:'FAILED: 2/9 … must not merge'}`; demo→`{event:'COMMENT', body:'SIMULATED only; do not treat as verified'}` | **The single most on-mission write** — independent real-test verdict in GitHub's review/merge gate; producer/verifier split (Trace reviews, Proto doesn't approve its own code); demo can only ever COMMENT, never APPROVE | Med — `APPROVE` high-trust |
| **UC-12** | **Trace** | Verification completes; long-form evidence worth attaching | `add_issue_comment` · **PINNED** | `{owner,repo,issue_number}` → `{body:'### Trace evidence ledger\n\| Check \| Result \|\n…\nReal run, Node 22, 9/9. Artifact digest <hex> = ApprovedPush'}` | The auditable per-check detail behind the headline verdict; ties bytes-reviewed to bytes-shipped | Low |
| **UC-13** | **Trace** | Base moved since the branch was cut; verify on a merge-clean tree | `update_pull_request_branch` · **NEEDS ADD** | `{owner,repo,pullNumber}` → `{expectedHeadSha:'<sha>'}` | Closes the "green on branch, broken after merge" gap; `expectedHeadSha` prevents racing a concurrent push | Low–Med |
| **UC-14** | **Critic** | Code-review round produced unresolved must-fix findings | `pull_request_review_write` `method:'create', event:REQUEST_CHANGES` · **PINNED** | `{owner,repo,pullNumber}` → `{event:'REQUEST_CHANGES', body:'Critic round 2 — must-fix:\n1. server.ts:40 SQL string-concat (injection)\n2. App.tsx:88 unhandled fetch error'}` | Adversarial review becomes a first-class GitHub review with `file:line` evidence; the security/correctness net made visible | Low–Med |
| **UC-15** | **Critic** | Critic surfaces a judgment-call risk outside its remit | `update_pull_request` `reviewers[]` · **NEEDS ADD** | `{owner,repo,pullNumber}` → `{reviewers:['OmerYasirOnal'], body:'⚠️ Critic flagged a decision it won't auto-resolve: plaintext API keys per spec — owner call needed'}` | Encodes Critic's humility — escalates rather than rubber-stamps; pulls the right human in *before* merge | Low–Med |
| **UC-16** | **Critic** | Critic classifies the build's risk | `issue_write` `method:'update', labels[]` · **PINNED** | `{owner,repo,issue_number}` → `{labels:['security-review','akis-critic-flagged']}` | Makes Critic's risk assessment filterable in the tracker; there is no separate label tool — labeling folds into `issue_write`+`update`+`labels` | Low |
| **UC-17** | **Critic** | Critic finished but the change is high-risk; want a second opinion | `request_copilot_review` · **NEEDS ADD** | `{owner,repo,pullNumber}` → *(no payload)* | Critic invites a *different* reviewer rather than being the sole gate — defense-in-depth | Low |

**Highest-value three to wire first** (all on the already-pinned allow-list, zero gate change, squarely on-mission): **UC-11** (Trace posts the real-test verdict as a PR review — verifiability landing in GitHub's merge gate), **UC-5** (AKIS comments the honest build verdict on the originating issue/PR), **UC-14** (Critic posts code-anchored findings as a review). These deliver AKIS's core promise — *independent, real verification made legible inside GitHub* — through the gate, human-confirmed, never autonomous.

---

## 4. Architecture

### 4.1 Provider-aware gate (Phase 1 — already shipped)

The gate (`/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/gates/externalWriteGate.ts`) already implements the right invariant for *every* tool:

- `mintApprovedExternalWrite` (L195) enforces, in order: **allow-list → key-collision → digest**.
- `executeExternalWrite` (L215) **re-checks** all three, then `transport.callTool(action, {...target, ...payload})` (L232) — one flat arg object.
- The approval token is a module-private `unique symbol` brand (L182); its **only** producer is `mintApprovedExternalWrite` — it cannot be forged with `as` or written as a literal.
- The allow-list is per-provider and **frozen**: `frozenWriteActionSet` neutralizes the set's mutators, so it can't be widened at runtime. `GITHUB_WRITE_ACTIONS` (L153-157) pins the three live names today.

The propose/confirm/execute wiring is live in `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/api/sessions.routes.ts`:

- **Propose** (L290): provider-aware (defaults `atlassian`), `BadAction` 400 on an off-list `action` (L298).
- **Confirm + execute** (L339): the `confirmingWrites` in-flight Set (L319/345) + `patchExternalWrite` status-guarded `proposed→executing→executed` transition (L325) give **at-most-once** execution.
- **List** (L283): `GET /sessions/:id/external-writes`.

The store field is **already fully plumbed** — `session.externalWrites: ExternalWriteRecord[]` (`shared/src/session.ts` L219, `EXTERNAL_WRITES_MAX=50`), round-tripped through `PgSessionStore` (`['externalWrites','external_writes']` PATCH L74, `toJson` L35, row mapper L218). **The agent-propose mechanism needs ZERO new store field** — it appends an `ExternalWriteRecord` exactly as the route does.

Connect/transport seam (`/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/api/mcpConnect.routes.ts`): `mcpTransportFor` + `REMOTE_MCP_PROVIDERS.github`; store key `<provider>:<userId>`; transport `kind: 'streamable-http'`; SDK `OAuthClientProvider` auto-refresh (`StoreBackedOAuthProvider.ts`, `HttpMcpTransport.ts`, `JsonFileRemoteMcpAuthStore.ts`).

### 4.2 The agent-propose tool

The cleanest wiring reuses the existing choke point. The agent gets **one** tool that *records* a proposal into `externalWrites` — byte-identical to what the propose route writes — and **returns the writeId + digest. It executes nothing.**

**Name:** `propose_github_write` (the `propose_` prefix signals "records, does not act"; namespace-distinct from the `github_` read tools).

**Params advertised to the model:**

```ts
{
  name: 'propose_github_write',
  description: 'Record a PROPOSED GitHub write for the human to review and confirm. '
    + 'This does NOT execute — it queues a confirm card. Use for: open/close issue, '
    + 'comment, open/close/merge PR, submit PR review.',
  schema: {
    type: 'object',
    properties: {
      action:  { type: 'string', enum: [...GITHUB_WRITE_ACTIONS] }, // enum sourced from the SAME frozen set
      summary: { type: 'string', description: 'One human-readable line for the confirm card.' },
      target:  { type: 'object', description: 'WHERE: owner, repo, issue_number|pullNumber, method.' },
      payload: { type: 'object', description: 'WHAT: title/body/state/event/merge_method/labels…' },
    },
    required: ['action', 'summary', 'target', 'payload'],
  },
}
```

**Factory** — new `backend/src/agent/tools/proposeGithubWriteTool.ts`, beside `retrieveKnowledgeTool.ts`:

```ts
export function proposeGithubWriteTool(deps: {
  sessionId: string          // captured at registry-build time — NOT a model arg
  store: SessionStore        // the SAME store the route uses (DI)
}): RegisteredTool
```

**Handler logic (fail-closed; never throws — the loop feeds errors back as strings):**

1. `provider = 'github'` — **hardcoded constant, never a model arg.** The model cannot smuggle `atlassian`.
2. **Allow-list check (authoritative):** `if (!isAllowedExternalWriteAction('github', args.action)) return 'Error: action not on the GitHub external-write allow-list'`. The schema enum is advisory; this server-side check is the gate's own predicate.
3. **Collision pre-check:** `if (collidingKeys(target, payload).length) return 'Error: target/payload keys overlap: …'` (mint re-checks — defense in depth).
4. **Idempotency:** compute `digestExternalWrite({provider:'github', action, target, payload})`; if a `proposed` record with that digest already exists, return the existing `{writeId, digest}` instead of appending. One card per content, not N across loop turns.
5. **Record** via the store's generic version-checked patch (NOT a gate method), oldest-dropped at `EXTERNAL_WRITES_MAX`:
   ```ts
   const rec: ExternalWriteRecord = {
     id: randomUUID(), provider: 'github', action,
     summary: summary.slice(0, 200), target, payload,
     status: 'proposed', proposedAt: new Date().toISOString(),
   }
   ```
   with a small read-modify-write retry on version conflict (chat turns run concurrently).
6. **Return:** `Proposed GitHub ${action} (writeId ${id}). AWAITING HUMAN CONFIRMATION — not executed. Do not assume it happened.`

**Wiring (smallest correct change):**

- `buildAdvisoryTools` (`/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/agent/tools/advisoryTools.ts` L16) — add an optional `store?: SessionStore` dep and a capability:
  ```ts
  if (capabilities.has('propose_github_write') && deps.store) {
    tools.register(proposeGithubWriteTool({ sessionId: deps.sessionId, store: deps.store }))
  }
  ```
  `sessionId` is already in handler scope here (L21/25) — the tool closes over it, so the model can never name another session. This keeps the single declarative choke point the file's invariant demands.
- `buildAdvisoryToolsWithGithub` (L61) already threads `deps` through — pass `store` and gate the capability on the **same** condition that surfaces github read tools (a connection exists). A build with no GitHub connection never sees the propose tool.
- **Scribe / Proto** (`ScribeAgent.ts` L238-283, `ProtoAgent.ts` L178-201): add `'propose_github_write'` to `caps` + pass `store` (both already have `sessionId` and a DI store handle). Their `onTool` narration already emits `tool_call`/`tool_result`, so a propose surfaces live in the UI for free.
- **Critic / Trace** do not run a tool loop today; their verdict proposals (UC-11/12/14/15/16/17) are minted by the **orchestrator** after the relevant phase via a shared `recordGithubProposal(store, sessionId, {action,summary,target,payload})` — extract step 5 so route, tool, and orchestrator share one implementation and one digest function.

### 4.3 FE confirm cards

The existing `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/ExternalWriteCard.tsx` is **user-initiated** (form → propose → confirm). Agent proposals arrive already at `status:'proposed'`, so the FE needs a **confirm-only** surface.

**New `AgentWriteProposals.tsx`:**

- Reads `GET /sessions/:id/external-writes`, filters `status==='proposed'`. Extend the summary type to carry `target`/`payload` so the card shows exact bytes with no re-propose round-trip.
- Per proposal:
  - **Header:** `summary` + `GitHub` badge + an **action chip** derived from `action`+`payload` (`Open issue` / `Close issue` / `Comment` / `Open PR` / `Close PR` / `Merge PR` / `Review: APPROVE`…).
  - **Structured target/payload table** (per-action fields, not raw JSON) so the human *reads*, not parses: issues show `#issue_number`, method, **state** (red "will CLOSE" banner when `state:'closed'`), labels, title/body preview; PRs show `#pullNumber`, `head→base` (create), **state**, **merge_method** (merge), and a colored `APPROVE`/`REQUEST_CHANGES` pill (review).
  - Collapsible "exact bytes" `<pre>{target,payload}` + the `digest.slice(0,16)` line — what the digest binds.
  - **Confirm / Dismiss.** Confirm calls the existing `POST …/:writeId/confirm` with the digest. Dismiss is a FE hide (or future `status:'dismissed'`).
- **Friction for destructive actions:** merge/close render an amber/red banner ("This MERGES PR #18 into `main` — irreversible" / "This will CLOSE issue #42"); merge requires **typing the PR number** to enable Confirm.
- Surface inline in the build view where agent activity streams (the proposal arrives as a `tool_call` event), with honest framing — the card title is **"AKIS proposes — your confirmation required"**, never "AKIS will…".

### 4.4 The propose → confirm → execute flow (end-to-end, gate-safe)

```
spec approved        → UC-1   issue_write create               [NOW]  → issue #N (tracking)
verify GREEN+pushed  → UC-4   create_pull_request              [ADD]  → PR #M  (body: AKIS-verified, "closes #N")
Trace verdict        → UC-11  pull_request_review_write APPROVE/REQUEST_CHANGES/COMMENT [NOW]
Critic findings      → UC-14  pull_request_review_write REQUEST_CHANGES [NOW] → back to Proto → UC-10 comment [NOW]
human ships          → UC-7   merge_pull_request squash        [ADD, IRREVERSIBLE] → lands on main
post-merge           → UC-6   issue_write update state:closed  [NOW]  + UC-5 add_issue_comment [NOW] → #N closed/completed
```

Each arrow is a **separate proposal → human confirm → execute**. Distinct digests mean no step can morph into another (open ≠ merge ≠ close). **The flow degrades honestly:** with today's allow-list the issue + review + comment steps work end-to-end now; the PR-create and merge steps are designed and ready but gate-blocked until their literal names are added.

---

## 5. Safety & invariants

### 5.1 Human-confirm (no autonomy) — structural, not conventional

`executeExternalWrite` is *uncallable* without an `ApprovedExternalWrite` token (the `unique symbol` brand). Its only producer is `mintApprovedExternalWrite`, called only from the human-hit confirm route. **An agent literally cannot reach a merge without a human POST to `…/confirm`.** The agent-propose tool only appends a `status:'proposed'` record on the generic update path — it holds no reference to mint, cannot fabricate the token, cannot call execute, and cannot mutate the frozen allow-list. The agent is strictly on the **propose side** of an unchanged boundary.

### 5.2 Digest binding (no swap)

Mint requires `confirmedDigest === digestExternalWrite(proposal)`, and execute **re-checks** the digest. The `pullNumber`/`merge_method`/`commit_title` a human saw are byte-for-byte the ones that execute — a payload swapped between display and confirm fails to mint (`ExternalWriteDigestMismatchError`). **UI faithfulness requirement:** the confirm card must render the *structured* `target`/`payload` the digest was computed over (not just the 200-char `summary`), so what's shown == what's bound — a human can't read a SHA-256.

### 5.3 Nominal/branded token

The approval is a branded `unique symbol` type — it cannot be produced by `as`-casting or by writing an object literal; only `mintApprovedExternalWrite` yields one. Adding names to the allow-list widens *which* tools a human can confirm; it creates **no** new minting path.

### 5.4 Merge / close irreversibility

Classify by inspecting `payload` (the gate keys on `action` only — it can't tell open-PR from merge-PR by action). A pure `classifyGithubWrite(action, payload) → 'reversible' | 'destructive' | 'irreversible'`:

- `merge_pull_request` → **irreversible**.
- `issue_write`/`update_pull_request` with `state:'closed'` → **destructive**.
- `pull_request_review_write` with `event:'APPROVE'` (or `method:'resolve_thread'`) → **destructive** (can unblock merge via branch protection).
- else → reversible.

This is **advisory UX, not a new security primitive** — the digest already binds the exact `merge_method`/`state`. The classifier drives FE friction (banners + typed-confirmation for irreversible). For `base == default branch`, reserve the strongest friction (echo the literal `pullNumber`). Optionally gate *which repos* an agent may even propose merge/approve on (owner allow-list) to bound blast radius before the human step.

### 5.5 Idempotency & at-most-once

- **Propose side:** the tool's content-digest dedupe (step 4) yields one card even if the model re-emits the same call across loop turns.
- **Confirm side:** the `confirmingWrites` in-flight Set + status-guarded `proposed→executing→executed` transition mean a double-confirm or crash-retry can never merge twice — critical because `merge_pull_request` / `create_pull_request` / `add_issue_comment` are **non-idempotent** on GitHub's side.
- **Moving-remote gap (merge only):** the digest binds the *args*, not the *remote state*. Capture the PR head SHA at propose time and re-verify it (read) at confirm, so a PR that gained commits after the human reviewed isn't merged blind. `update_pull_request_branch` already exposes `expectedHeadSha` — always propose it.

### 5.6 Honesty (structural)

Trace/AKIS proposals carry the real-vs-`demo` flag in their `body`, and a demo verify can only ever propose `event:'COMMENT'`, never `APPROVE` — content-binding + this rule make a laundered "verified" impossible. AKIS/Trace never claim a write happened until the confirm executes (the tool's return string forces this).

---

## 6. Phased implementation plan

### Phase A — Extend the allow-list (gate-only, no agent)

Add `create_pull_request`, `update_pull_request`, `merge_pull_request` (and, when their confirm rendering lands, `update_pull_request_branch`, `request_copilot_review`) to `GITHUB_WRITE_ACTIONS` (`externalWriteGate.ts` L153). User-initiated propose of these via the existing route + FE works immediately.

**Acceptance:**
- `tsc --noEmit` green.
- `external-write-gate.test.ts` (L233) snapshot pins the new sorted name set + keeps the "flat name absent" assertion (e.g. `pull_request_write` must NOT appear).
- `isAllowedExternalWriteAction('github','merge_pull_request') === true`; `isAllowedExternalWriteAction('atlassian','merge_pull_request') === false`.
- Reviewed by `akis-gate-keeper`.

### Phase B — Propose tool + shared recorder

New `proposeGithubWriteTool.ts`; extract `recordGithubProposal(store, sessionId, {...})` shared by route/tool/orchestrator. Wire `propose_github_write` into `buildAdvisoryTools` / `buildAdvisoryToolsWithGithub` with a `store` dep.

**Acceptance:**
- Unit: handler appends a `proposed` record; hardcodes `provider:'github'`; rejects an off-list action with an `Error:` string and **no append**; rejects a colliding `target`/`payload`; dedupes on digest.
- **Reachability assertion:** the tool module cannot import the approval token type / `mintApprovedExternalWrite` / `executeExternalWrite` (no path from propose to execute).
- **Store-parity test:** an agent-appended record round-trips identically through Mock and Pg stores.
- `tsc --noEmit` + targeted vitest green.

### Phase C — Subagent + orchestrator wiring

Add `'propose_github_write'` to Scribe/Proto caps + pass `store`; mint Critic/Trace verdict proposals from the orchestrator via `recordGithubProposal` after the relevant phase.

**Acceptance:**
- Integration: a build with a github connection + a mock provider that emits a `propose_github_write` call ends with exactly one `proposed` record and **zero executions**; `onTool` emits `tool_call`/`tool_result`.
- A build with **no** github connection never registers the tool.
- Chat-only model overrides never leak (no workflow-binding change).

### Phase D — FE confirm cards

`AgentWriteProposals.tsx`: list `status:'proposed'` agent writes, structured per-action rendering, `classifyGithubWrite`-driven friction (merge typed-confirm; close/APPROVE banner), confirm via the existing endpoint.

**Acceptance:**
- FE unit: a merge proposal renders the irreversible banner + disables Confirm until the PR number is typed; confirm posts the **exact** digest; a non-github proposal still renders.
- The structured card content matches the digest-bound `target`/`payload` (no field shown that isn't bound).
- Full `npm test` (BE + FE + store parity) green before "done".

### Phase E — Wire the highest-value three end-to-end (pinned actions only)

UC-11 (Trace review verdict), UC-5 (AKIS build-verdict comment), UC-14 (Critic findings review) — all on the already-pinned allow-list, no Phase-A dependency.

**Acceptance:**
- Live e2e against the connected GitHub MCP (`<provider>:<userId>` store key, `streamable-http`): each of the three is proposed by its agent, rendered in the confirm card, confirmed by a human, and executed — verified by reading the resulting issue comment / PR review back from GitHub.
- A **demo** verify proposes `event:'COMMENT'` (never `APPROVE`) — asserted.
- Owner-gated: a non-owner session gets 404 on propose/confirm (`accessibleSession`).

---

**Key files:** gate + allow-list `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/gates/externalWriteGate.ts` (L153 set · L173 predicate · L195/215 mint/execute) · route `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/api/sessions.routes.ts` (L283 list · L290 propose · L339 confirm · L319/325 at-most-once) · shared `/Users/omeryasironal/Projects/akis-platform-mvp/shared/src/session.ts` (L219 `ExternalWriteRecord`) · store `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/store/PgSessionStore.ts` (L35/74/218 — `externalWrites` already plumbed, no new field) · choke point `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/agent/tools/advisoryTools.ts` (L16/61) · loop `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/agent/tools/toolLoop.ts` (L46 error-as-string) · subagents `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/orchestrator/subagents/ScribeAgent.ts` (L238-283), `ProtoAgent.ts` (L178-201) · connect/transport `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/api/mcpConnect.routes.ts` (`mcpTransportFor`, `REMOTE_MCP_PROVIDERS.github`) · NEW `/Users/omeryasironal/Projects/akis-platform-mvp/backend/src/agent/tools/proposeGithubWriteTool.ts` · gate test `/Users/omeryasironal/Projects/akis-platform-mvp/backend/test/unit/external-write-gate.test.ts` (L233 snapshot) · FE `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/ExternalWriteCard.tsx` + NEW `AgentWriteProposals.tsx`.