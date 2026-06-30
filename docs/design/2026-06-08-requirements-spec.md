# AKIS — Requirements Specification (2026-06-08 session)

This session shipped three connected capabilities and one hardening batch on top of them: (1) **OAuth sign-in** so a user can authenticate to AKIS with an existing GitHub or Google account; (2) **connected integrations** — per-user browser-OAuth connections to GitHub's remote MCP server and to Atlassian Cloud (Jira) — that let agents read real context and propose outward writes; and (3) a **gate-safe agent-proposed-GitHub-writes** capability in which a build agent may *propose* a GitHub write that only a human can confirm and only the server can execute. The session closed with a reliability + correctness hardening batch from an 8-agent adversarial bug-hunt that locked the at-most-once external-write ledger and the trust-legibility surfaces.

This document gives the **Functional Requirements**, **Non-Functional Requirements**, and **Use Cases** for each of the nine features, preserving the per-feature `FR/NFR/UC` identifiers, followed by a consolidated cross-cutting invariants section and a traceability appendix.

## Feature index

| # | Feature | What it delivers | PR / commit |
|---|---------|------------------|-------------|
| 1 | OAuth sign-in (GitHub + Google) | Stateless, HMAC-`state`-protected OAuth 2.0 authorization-code login that links by provider-verified email, gated behind the no-open-signup posture; buttons appear only for configured providers | `73dcfaf` (PR-B/C #18); dev-origin proxy `2b49b61` (PR19) |
| 2 | Account menu + provider/avatar | Avatar dropdown (name, email, "Signed in via …" badge, Settings, explicit Sign out) with real provider photo and graceful fallback, replacing accidental click-to-logout | `73dcfaf` |
| 3 | Provider badge reflects the CURRENT login (`lastLoginProvider`) | Badge reports the provider used *this* login (recorded on every OAuth path; `toPublic` prefers it over the bound identity), honest across cross-identity same-email logins | `67e9bc2` |
| 4 | Atlassian Jira-only MCP connect + Confluence scope-gating | DCR + PKCE browser-OAuth connect to Atlassian (Jira-only scope); Confluence publish surfaced only when the *live granted* scope contains `write:confluence-content` | `67e9bc2` |
| 5 | GitHub remote MCP connect (static-client, DCR bypass) | Per-user browser-OAuth connect to GitHub's remote MCP server using AKIS's existing GitHub OAuth App as a static client so the SDK skips DCR | `562fd04`; state-first callback `8e69f6e` (PR16) |
| 6 | Provider-aware external-write gate + GitHub write-action allow-list | Branded-token gate (allow-list · content digest · disjoint-keys · mint→execute) with one frozen write-action set per provider; irreversible `merge_pull_request` gets the strongest friction | `9b2b17f` |
| 7 | Agent-proposed GitHub writes (propose tool + recorder + wiring + prompt guidance) | `propose_github_write` tool + shared recorder + Scribe/Proto wiring + prompt hints so agents only ever *propose* writes, holding no gate authority | `1a63f09` (tool/recorder/wiring) + `5cdf4da` (prompt guidance) |
| 8 | Agent-write confirm-cards UI | Live-polling confirm cards rendering the exact digest-bound `target`/`payload`, risk-keyed friction (typed-merge echo, destructive banners), confirm posts the server's stored digest verbatim | `f2bc632` |
| 9 | Reliability + correctness hardening (adversarial bug-hunt batch) | Single shared status-aware, version-resilient appender (closes the at-most-once double-execute hole + Atlassian-propose 500) + ProtoAgent/confirm-card honesty fixes, each with a regression test | `8fb3d79` (PR #152) |

---

## OAuth sign-in (GitHub + Google)

### Purpose
Lets a user sign in to AKIS with an existing GitHub or Google account instead of an email/password, via a stateless, HMAC-`state`-protected OAuth 2.0 authorization-code flow that links by provider-verified email. Buttons appear only for providers whose credentials are actually configured on the running instance, so the UI never advertises a path the server can't honour — and creation is gated behind the same no-open-signup posture (the no-sandbox-RCE guard) as password signup, plus an optional owner-email allowlist, so OAuth can authenticate the owner without ever silently minting a new account or leaking account existence.

### Functional Requirements

- **FR-oauth-signin-1**: The system SHALL expose `GET /oauth/providers` returning `{ providers: string[] }` containing exactly the provider ids whose client id AND client secret env vars are both set (`configuredProviders` → `oauthCreds`); a provider missing either credential SHALL be omitted.
- **FR-oauth-signin-2**: The frontend `OAuthButtons` SHALL fetch `/oauth/providers` on mount and render a full-page-redirect link only for `github` and/or `google` when present; when the list is empty (or the fetch rejects → `setProviders([])`) it SHALL render nothing (`return null`), so no "or" divider or button appears.
- **FR-oauth-signin-3**: The system SHALL handle `GET /oauth/:provider/authorize` by redirecting the browser to the provider's authorize URL built from `client_id`, `redirect_uri = {base}/oauth/{provider}/callback`, the provider login `scope`, a signed `state`, and `response_type=code`; for GitHub it SHALL additionally set `allow_signup=true`.
- **FR-oauth-signin-4**: The authorize redirect SHALL use the GitHub scope `read:user user:email` and the Google scope `openid email profile` (the narrower login scopes, distinct from the connect flow's `repo`).
- **FR-oauth-signin-5**: The `state` parameter SHALL be a stateless, server-storage-free token of the form `base64url({p,n,exp}).HMAC-SHA256(body, secret)`, binding the provider id (`p`), a random 8-byte nonce (`n`), and a 600-second expiry (`exp`).
- **FR-oauth-signin-6**: On `GET /oauth/:provider/callback`, the system SHALL verify `state` by recomputing the HMAC with a constant-time compare (`timingSafeEqual` after equal-length check), rejecting if the token is malformed (not exactly two `.`-parts), the signature mismatches, `exp` is missing/non-numeric/in the past, or the embedded provider does not equal the route provider — redirecting to `/login?error=oauth_state` on any such failure.
- **FR-oauth-signin-7**: The callback SHALL exchange the authorization `code` for an access token via a POST to the provider token URL (`exchangeCode`), throwing (→ caught) if the token endpoint returns non-OK or the response has no `access_token`; neither the token nor scopes SHALL be logged.
- **FR-oauth-signin-8**: For GitHub, the system SHALL fetch `https://api.github.com/user` for the numeric id, and when the profile email is null/empty SHALL fetch `/user/emails` and select the primary+verified email (falling back to any verified email); it SHALL throw if no id or no email is obtained.
- **FR-oauth-signin-9**: For Google, the system SHALL fetch `https://www.googleapis.com/oauth2/v3/userinfo` and SHALL reject (throw "google email not verified" → `oauth_failed`) unless `email_verified` is boolean `true` or string `'true'`, preventing an attacker-asserted unverified email from linking to a victim account; it SHALL throw if `sub` or `email` is absent.
- **FR-oauth-signin-10**: The system SHALL normalize the profile to `externalId` (`github:{id}` / `google:{sub}`), `email`, a display `name` (provider name → GitHub login / Google fallback → email local-part), and an optional `avatarUrl` (GitHub `avatar_url` / Google `picture`); `avatarUrl` SHALL be attached only when the provider returned one, never as an explicit `undefined` (`exactOptionalPropertyTypes`).
- **FR-oauth-signin-11**: When `AKIS_OWNER_EMAIL` is set, the system SHALL allow authentication only if the provider-verified profile email (trimmed, lowercased) equals it; otherwise it SHALL redirect to `/login?error=oauth_denied` with a generic refusal that does not reveal account existence.
- **FR-oauth-signin-12**: The system SHALL resolve the identity via `upsertOAuth`, which SHALL (1) return the user already bound to `externalId`, else (2) link this identity to an existing account matched by verified email, else (3) create a new user only when `allowCreate !== false`.
- **FR-oauth-signin-13**: The system SHALL pass `allowCreate: !signupDisabled` so that when signup is disabled, account creation is refused (`upsertOAuth` returns `null`); on `null` the callback SHALL redirect to `/login?error=oauth_denied`, ensuring OAuth can log in / link an existing account but never mint a new one and bypass the no-open-signup gate.
- **FR-oauth-signin-14**: `signupDisabled` SHALL be resolved identically for OAuth and password signup via `resolveSignupDisabled(env)` = `AKIS_DISABLE_SIGNUP` truthy OR (`NODE_ENV==='production'` AND not `AKIS_ALLOW_SIGNUP`), so a fresh self-host is closed by default in production.
- **FR-oauth-signin-15**: On a successful upsert the system SHALL record `lastLoginProvider` = the provider used this login (without rebinding a permanent `externalId` already bound to a different identity), set the session cookie via `setSessionCookie(... user.tokenVersion ?? 0)` so OAuth sessions revoke identically to password sessions, and redirect the browser to `{base}/`.
- **FR-oauth-signin-16**: For a returning/linked OAuth user the system SHALL refresh the stored `avatarUrl` when the current login carries one (and adopt it on fresh link only when the account has none), never overwriting an existing avatar with an absent/`undefined` value.
- **FR-oauth-signin-17**: The system SHALL reject an unknown `:provider` (not `github`/`google`) on both authorize and callback with `/login?error=oauth_unknown`, and SHALL redirect with `oauth_unavailable` when the route provider has no configured credentials.
- **FR-oauth-signin-18**: When the provider returns `?error=` on the callback (user denied/cancelled), the system SHALL redirect to `/login?error=oauth_denied`; any thrown exception in the exchange/profile path SHALL be caught and mapped to `/login?error=oauth_failed`, never leaking provider/internal detail.
- **FR-oauth-signin-19**: The frontend `Login` page SHALL read `?error=<code>` and map it via `OAUTH_ERROR_KEYS` (`oauth_denied|unavailable|state|failed|unknown`) to a specific localized message, falling back to the generic `auth.oauth.error` for any unrecognized/empty code so a raw code is never displayed.
- **FR-oauth-signin-20**: The system SHALL compute the browser-facing base origin via `baseUrl(req, env)`: prefer `PUBLIC_BASE_URL` (trailing slashes stripped); otherwise derive from `x-forwarded-proto`/`x-forwarded-host` (or `Host`, default `127.0.0.1:3000`), so the same value backs both `redirect_uri` and the post-login redirect.
- **FR-oauth-signin-21**: In dev the Vite proxy SHALL forward `/oauth` (and `/auth`) with `xfwd: true`, so `x-forwarded-host` carries the browser origin `localhost:5173`, making the derived `redirect_uri` `http://localhost:5173/oauth/{provider}/callback` — matching the URI registered with the Google client (GCP project `akis-492505`) and GitHub app.
- **FR-oauth-signin-22**: The `state` HMAC and the session cookie HMAC/JWT SHALL be derived from the same server `secret` (`deps.secret` = `authSecret`); the OAuth `state` envelope/secret SHALL be byte-identical to the per-user GitHub `connect` state envelope so the two flows share one signing discipline.

### Non-Functional Requirements

**Security / Gate-safety**
- **NFR-oauth-signin-1**: OAuth SHALL NOT be a side-channel around the no-open-signup gate: creation is gated by the identical `resolveSignupDisabled(env)` used by `POST /auth/signup`, and a refused creation returns `null` → generic `oauth_denied` (no new account).
- **NFR-oauth-signin-2**: `state` SHALL provide CSRF protection and provider binding with no server-side storage, verified in constant time (`timingSafeEqual` guarded by equal-length), with a ≤600s expiry bounding replay.
- **NFR-oauth-signin-3**: Email-based account linking SHALL occur only after the email is provider-verified (GitHub primary+verified; Google `email_verified` true) — the documented precondition of `upsertOAuth`'s by-email link step.
- **NFR-oauth-signin-4**: Refusals SHALL be account-existence-non-revealing: owner-allowlist mismatch, signup-disabled creation refusal, and provider-denied all collapse to the same generic `oauth_denied` redirect.
- **NFR-oauth-signin-5**: OAuth sessions SHALL be revocable identically to password sessions — the cookie carries the user's `tokenVersion`, so password-reset / logout-all invalidates them.

**Privacy / Secrets**
- **NFR-oauth-signin-6**: Access tokens and granted scopes SHALL never be logged or returned over the wire; `client_secret` lives only in env and is sent only to the provider token endpoint.
- **NFR-oauth-signin-7**: The wire user projection (`toPublic`) SHALL never include the password hash; `avatarUrl` is surfaced only for display and is explicitly never used for identity/authorization.

**Reliability / Concurrency**
- **NFR-oauth-signin-8**: Profile fetching SHALL fail closed: a missing/failed GitHub `/user/emails` call SHALL degrade to `[]` (`.catch(() => [])`) and absent required fields SHALL throw rather than authenticate with partial identity.
- **NFR-oauth-signin-9**: `exchangeCode` SHALL fail closed on a missing `scope` field (parse to `[]`, never throw on absent scope) while still throwing on non-OK status or absent `access_token`.

**Usability / Accessibility**
- **NFR-oauth-signin-10**: Both Login and Signup SHALL render the OAuth buttons above the email/password form with an "or" separator; clicking performs a full-page navigation into the flow (anchor `href`), not a fetch.
- **NFR-oauth-signin-11**: Provider glyphs (GitHub SVG mark, Google mark) SHALL be exported and reused so the account menu's "signed in via X" badge uses the same marks; decorative SVG SHALL be `aria-hidden`.

**Internationalization (TR + EN parity)**
- **NFR-oauth-signin-12**: Every user-facing OAuth string SHALL exist in both EN and TR catalogs at parity — button labels (`auth.oauth.github/google`), the "or" divider, the generic `auth.oauth.error`, and all five per-code keys (`auth.oauth.err.{denied,unavailable,state,failed,unknown}`).

**Maintainability / Strict-TS**
- **NFR-oauth-signin-13**: Optional `avatarUrl` SHALL be conditionally spread (never written as explicit `undefined`) to satisfy `exactOptionalPropertyTypes` consistently across `fetchProfile`, the route upsert input, and `UserStore`.
- **NFR-oauth-signin-14**: `HttpFetch` SHALL be an injectable seam (defaults to global `fetch`) so the exchange/profile paths are unit-testable without network; provider definitions live in one `DEFS` table keyed by `OAuthProviderId`.
- **NFR-oauth-signin-15**: `baseUrl` SHALL be exported and reused verbatim by the per-user GitHub/Atlassian connect routes so all OAuth-base-sensitive routes derive one origin.

**Honesty / Trust-legibility**
- **NFR-oauth-signin-16**: The UI SHALL advertise only providers the server can actually serve (buttons driven by `configuredProviders`), so the sign-in surface never promises an unconfigured path.
- **NFR-oauth-signin-17**: The "signed in via" badge SHALL reflect the provider used for the most-recent login (`lastLoginProvider`), not the permanently-bound identity, keeping the badge honest when an account bound to identity A signs in via identity B at the same verified email.

**Self-hostability**
- **NFR-oauth-signin-18**: OAuth SHALL be fully optional: with no provider credentials the buttons disappear and password auth still works; `.env.example` documents that a button appears only when a provider's id AND secret are both set.
- **NFR-oauth-signin-19**: A production self-host SHALL be closed to OAuth-driven account creation by default (signup-disabled), and `PUBLIC_BASE_URL` SHALL be settable to the registered public origin so `redirect_uri` matches without relying on client-controlled forwarded headers.

### Use Cases

- **UC-oauth-signin-1 — Owner signs in with GitHub (happy path)**
  - **Actor**: AKIS owner / user with a GitHub account.
  - **Preconditions**: `GITHUB_OAUTH_CLIENT_ID`/`_SECRET` set; redirect URI registered; an AKIS account exists for the user's verified GitHub email (or signup enabled).
  - **Main flow**: (1) User opens `/login`; `OAuthButtons` shows "Continue with GitHub". (2) Click → full-page redirect to `GET /oauth/github/authorize`. (3) Server signs `state`, redirects to GitHub authorize (`scope=read:user user:email`, `allow_signup=true`). (4) User approves on GitHub → returns to `/oauth/github/callback?code=…&state=…`. (5) Server verifies `state`, exchanges `code` for a token, fetches the GitHub profile + primary-verified email. (6) `upsertOAuth` returns the bound/linked user; `lastLoginProvider='github'`. (7) Server sets the session cookie and redirects to `{base}/`.
  - **Postconditions**: User is authenticated with a revocable session; avatar refreshed if the provider sent one.
  - **Gate-safety note**: Existing-account login/link is always allowed; no new account is created unless signup is enabled.

- **UC-oauth-signin-2 — First-time sign-in with Google (create, signup enabled)**
  - **Actor**: New user with a Google account.
  - **Preconditions**: Google creds set (GCP `akis-492505`, redirect `http://localhost:5173/oauth/google/callback` in dev); signup enabled (`allowCreate=true`); no matching AKIS account.
  - **Main flow**: (1–4) As UC-1 but Google (`scope=openid email profile`). (5) Server fetches `/oauth2/v3/userinfo`, asserts `email_verified` true. (6) `upsertOAuth` finds no `externalId`/email match and creates a user (empty passwordHash, `externalId=google:{sub}`). (7) Session cookie set; redirect to `{base}/`.
  - **Postconditions**: New OAuth-only account exists and is signed in.
  - **Error flow**: If `email_verified` is not true → throw → `oauth_failed`; no account created.

- **UC-oauth-signin-3 — Sign-in refused because signup is disabled**
  - **Actor**: Any user without an existing AKIS account.
  - **Preconditions**: `signupDisabled=true` (e.g. production default); no matching account by externalId or verified email.
  - **Main flow**: (1–5) As the happy path through profile fetch. (6) `upsertOAuth(..., {allowCreate:false})` → `null`. (7) Server redirects to `/login?error=oauth_denied`; Login shows the localized "cancelled or denied" message.
  - **Postconditions**: No account created; no session.
  - **Gate-safety note**: This is the core guard — OAuth cannot mint an account when password signup is closed; the existing owner can still link/log in.

- **UC-oauth-signin-4 — Non-owner blocked by owner allowlist**
  - **Actor**: A user who is not the configured owner.
  - **Preconditions**: `AKIS_OWNER_EMAIL` set; user's verified provider email ≠ owner email.
  - **Main flow**: 1–5 as happy path → server compares trimmed/lowercased emails, mismatch → `/login?error=oauth_denied`.
  - **Postconditions**: No session; refusal is generic (no account-existence leak).
  - **Gate-safety note**: Defense-in-depth — even with creds configured and an account present, only the owner email can authenticate.

- **UC-oauth-signin-5 — Tampered/expired state**
  - **Actor**: Attacker or a stale browser tab.
  - **Preconditions**: Callback hit with missing/forged/expired `state` (or provider mismatch).
  - **Main flow**: Server runs `verifyState` (constant-time HMAC + expiry + provider check) → fails → `/login?error=oauth_state`; Login shows "couldn't be verified, try again".
  - **Postconditions**: No token exchange occurs; no session.
  - **Gate-safety note**: CSRF/replay defense with no server-side state store.

- **UC-oauth-signin-6 — User cancels / unknown or unconfigured provider**
  - **Actor**: User who denies consent, or a request for a bad/unconfigured provider.
  - **Preconditions**: Provider returns `?error=`, or `:provider` not in {github,google}, or creds absent.
  - **Main flow**: Provider-error → `oauth_denied`; unknown provider → `oauth_unknown`; configured-but-no-creds → `oauth_unavailable`; each maps via `OAUTH_ERROR_KEYS` to a specific localized message (generic fallback for unrecognized codes).
  - **Postconditions**: User remains on `/login` with a clear, non-raw, localized error; no session.

- **UC-oauth-signin-7 — Frontend renders only configured providers**
  - **Actor**: Any visitor to `/login` or `/signup`.
  - **Preconditions**: `GET /oauth/providers` reflects which credentials are set.
  - **Main flow**: `OAuthButtons` fetches the list on mount and renders only matching buttons; if empty (or the fetch fails) it renders nothing.
  - **Postconditions**: The sign-in surface advertises exactly the providers the server can serve.
  - **Trust-legibility note**: No button promises an unconfigured path; self-hosts with no OAuth see only password auth.

---

## Account menu + provider/avatar

### Purpose
Replaces the old click-the-avatar-to-instantly-sign-out header control with a proper account dropdown: clicking the avatar now opens a menu that shows the user's name, email, a "Signed in via …" provider badge, a Settings link, and an explicit Sign-out action. The avatar renders the user's real provider photo (GitHub `avatar_url` / Google `picture`) and degrades to a gradient initial when none is present or the image fails to load. Beyond fixing an accidental-logout footgun, the provider badge makes the *identity provenance* of the current session legible — it honestly reflects how the user signed in *this* time, consistent with the AKIS trust thesis of surfacing verifiable provenance rather than hiding it.

### Functional Requirements

- **FR-account-menu-1** — The system SHALL render the avatar as a button that acts purely as a menu trigger: clicking it toggles the dropdown open/closed and SHALL NOT invoke `logout`.
- **FR-account-menu-2** — The system SHALL mount the AccountMenu in the app header only when an authenticated `user` is present (`{user && <AccountMenu user={user} logout={logout} />}`).
- **FR-account-menu-3** — When `user.avatarUrl` is a non-empty string and the image has not errored, the system SHALL render that URL as the avatar `<img>` (`object-cover`, rounded) in both the trigger (`size="sm"`) and the menu header (`size="md"`).
- **FR-account-menu-4** — When `user.avatarUrl` is absent/empty, the system SHALL render a gradient circle containing the uppercased first character of `user.name`, or `?` when `name` is empty.
- **FR-account-menu-5** — When the avatar image fails to load (`onError`), the system SHALL flip an internal `failed` flag and degrade to the gradient-initial fallback instead of a broken-image glyph.
- **FR-account-menu-6** — When opened, the system SHALL display a header row showing `user.name` (semibold) and `user.email` (muted), each single-line truncated so a long email cannot overflow the 64-unit-wide panel.
- **FR-account-menu-7** — The system SHALL render a provider line whose label is `account.via.github` for `provider === 'github'`, `account.via.google` for `'google'`, and `account.via.password` ("Email account") otherwise, including when `provider` is `undefined` (older sessions).
- **FR-account-menu-8** — The system SHALL render the GitHub glyph next to the GitHub label, the Google glyph next to the Google label, and no glyph for the password/email case.
- **FR-account-menu-9** — The system SHALL render a Settings menu item that, on click, closes the menu and navigates to `/settings` via the in-app history router (`useRouter().navigate`), without a full page reload.
- **FR-account-menu-10** — The system SHALL render a Sign-out menu item that, on click, closes the menu and invokes `logout()` exactly once (fire-and-forget via `void logout()`).
- **FR-account-menu-11** — While open, the system SHALL close the menu on a mousedown outside the component subtree (`ref` containment check) or on the Escape key, and SHALL detach both listeners when the menu closes or unmounts.
- **FR-account-menu-12** — The system SHALL project `provider` and (when present) `avatarUrl` onto the wire user via `toPublic`, deriving `provider` as `u.lastLoginProvider ?? providerOf(u.externalId)` and attaching `avatarUrl` only when truthy (never an explicit `undefined`). This projection backs `/auth/me`, login, signup, and profile-update responses.
- **FR-account-menu-13** — `providerOf` SHALL return `'github'` for an `externalId` starting `github:`, `'google'` for `google:`, and `'password'` otherwise (including a missing `externalId`).
- **FR-account-menu-14** — `toPublic` SHALL prefer the recorded `lastLoginProvider` over the derived bound-identity provider, so that when an account bound to identity A signs in via a different verified-email identity B, the badge reflects B (this login) while the row stays bound to A.
- **FR-account-menu-15** — On OAuth login (`upsertOAuth`), the system SHALL record `lastLoginProvider = providerOf(externalId)` on every existing-account path (returning identity, fresh email link, and already-bound-to-a-different-identity) and on creation, so the badge stays honest about the current login (Pg parity in `PgUserStore`).
- **FR-account-menu-16** — On OAuth login, the system SHALL refresh `avatarUrl` only when the incoming profile carries one: for a returning/already-bound identity it updates the stored avatar; for a fresh link it adopts the provider avatar only when the account has none (never clobbering an existing picture); and it SHALL never write an explicit `undefined` over the optional field (Pg `COALESCE` parity).
- **FR-account-menu-17** — `fetchProfile` SHALL populate `avatarUrl` from the GitHub `avatar_url` field and from the Google `picture` field, attaching it only when present.
- **FR-account-menu-18** — The frontend `AuthUser` type SHALL treat `provider` and `avatarUrl` as optional (matching `PublicUser`), and consumers SHALL default `provider` to the password/email line and fall back to the initial avatar when `avatarUrl` is absent.

### Non-Functional Requirements

**Security / Gate-safety**
- **NFR-account-menu-1** — The feature SHALL be read-only with respect to external systems and the external-write gate: it renders an existing session projection and triggers only navigation and the existing `logout`. It introduces no new mutating route and therefore does not touch the external-write gate.
- **NFR-account-menu-2** — The provider badge SHALL be derived strictly from server-controlled provenance (`externalId` namespace / recorded `lastLoginProvider`), not from client input, so a user cannot self-assert a provider badge they did not authenticate with.

**Privacy / secrets**
- **NFR-account-menu-3** — The wire projection (`toPublic`) SHALL never include the password hash or any token; only `id, name, email, provider, avatarUrl?` are exposed.
- **NFR-account-menu-4** — `avatarUrl` SHALL be attached only for OAuth users whose provider exposed a picture; absent pictures SHALL omit the field entirely rather than emit `null`/`undefined`.

**Reliability / resilience**
- **NFR-account-menu-5** — A broken, expired, or unreachable avatar URL SHALL NOT degrade the UI: the `onError` handler guarantees a graceful fallback to the gradient initial. The dropdown SHALL remain fully usable regardless of avatar load state.
- **NFR-account-menu-6** — The component SHALL clean up its global `mousedown`/`keydown` listeners on close/unmount to avoid leaks and stale handlers.
- **NFR-account-menu-7** — Backward compatibility: sessions/rows written before this feature (no `lastLoginProvider`, no `avatarUrl`) SHALL still render correctly, falling back to `providerOf(externalId)` and the initial avatar.

**Usability / Accessibility**
- **NFR-account-menu-8** — The trigger SHALL expose `aria-haspopup="menu"`, `aria-expanded` reflecting open state, and an `aria-label` from `t('account.menuLabel')`; the panel SHALL use `role="menu"` and its items `role="menuitem"`.
- **NFR-account-menu-9** — The trigger SHALL provide a visible keyboard focus ring (`focus-visible:ring-2 ring-[#07D1AF]`) and SHALL be dismissible by keyboard (Escape).
- **NFR-account-menu-10** — Avatar `<img>` elements used purely as decoration SHALL carry an empty `alt=""` so screen readers are not given a redundant/uninformative label.

**Internationalization (TR + EN parity)**
- **NFR-account-menu-11** — Every user-facing string SHALL come from the i18n catalog with full EN+TR parity: `account.menuLabel`, `account.via.github`, `account.via.google`, `account.via.password`, plus reused `nav.settings` and `nav.logout`.

**Maintainability / Strict-TS**
- **NFR-account-menu-12** — The optional-field handling SHALL be compatible with `exactOptionalPropertyTypes`: `avatarUrl`/`lastLoginProvider` are conditionally spread or guarded so an absent value never becomes an explicit `undefined` assignment.
- **NFR-account-menu-13** — `providerOf` SHALL be the single shared source of provider derivation, reused by `toPublic`, the stores, and tests, avoiding duplicated namespace-prefix logic.
- **NFR-account-menu-14** — The dropdown SHALL reuse the established HistoryMenu interaction pattern (click-outside + Escape, `role="menu"`/`menuitem`, absolute glass panel) for visual and behavioral consistency.

**Honesty / Trust-legibility**
- **NFR-account-menu-15** — The provider badge SHALL reflect the provider used for the *most-recent* login (`lastLoginProvider`), not merely the permanently bound identity, so the displayed "Signed in via …" is truthful for the current session even across cross-identity same-email sign-ins.

**Self-hostability / Storage parity**
- **NFR-account-menu-16** — The in-memory `UserStore` and the Postgres `PgUserStore` SHALL behave identically for provider/avatar derivation and refresh semantics (returning-identity refresh, link-don't-clobber, no-rebind-on-existing-identity), keeping self-hosted in-memory and DB-backed deployments consistent.

### Use Cases

- **UC-account-menu-1 — Open the account menu without logging out**
  - Actor: Authenticated user. Preconditions: A `user` projection is loaded; AccountMenu is mounted.
  - Main flow: (1) User clicks the avatar trigger. (2) The dropdown opens (`aria-expanded=true`), showing name, email, provider line, Settings, and Sign out. (3) `logout` is not called.
  - Postconditions: Menu is open; session unchanged. Alternate: Clicking the trigger again, clicking outside, or Escape closes the menu (FR-account-menu-1, FR-account-menu-11).
  - Gate-safety: No external write; pure UI state.

- **UC-account-menu-2 — Sign out from the menu**
  - Actor: Authenticated user. Preconditions: Menu is open.
  - Main flow: (1) User clicks "Sign out". (2) The menu closes and `logout()` is invoked exactly once.
  - Postconditions: Logout flow proceeds (handled by the parent's `logout`). Gate-safety: No external write introduced here.

- **UC-account-menu-3 — Navigate to Settings**
  - Actor: Authenticated user. Preconditions: Menu is open.
  - Main flow: (1) User clicks "Settings". (2) The menu closes and the app navigates to `/settings` via the history router (no full reload).
  - Postconditions: Current route is `/settings`; SPA state preserved.

- **UC-account-menu-4 — See how I signed in (provider badge + photo)**
  - Actor: Authenticated OAuth user. Preconditions: `/auth/me` returned `provider` and, if exposed, `avatarUrl`.
  - Main flow: (1) User opens the menu. (2) The avatar shows the real provider photo; the provider line shows the matching glyph + "Signed in via GitHub/Google".
  - Postconditions: User can verify the session's identity provenance. Error flow: If the photo URL fails to load, the avatar degrades to the gradient initial; the badge remains correct.

- **UC-account-menu-5 — Email/password (or legacy) user with no photo and no provider**
  - Actor: Password-account user, or any user on a pre-feature session lacking `provider`/`avatarUrl`. Preconditions: `provider` is `'password'` or absent; `avatarUrl` absent.
  - Main flow: (1) User opens the menu. (2) The avatar shows the gradient initial (or `?` if name is empty). (3) The provider line shows "Email account" with no glyph.
  - Postconditions: Menu fully functional with graceful defaults.

- **UC-account-menu-6 — Badge stays honest across a cross-identity, same-email login**
  - Actor: User whose account is bound to identity A but who signs in via identity B (same verified email). Preconditions: Account row has `externalId` = A; user authenticates via provider B.
  - Main flow: (1) `upsertOAuth` records `lastLoginProvider = B` (without rebinding `externalId`) and refreshes the avatar from B's profile if present. (2) `toPublic` derives `provider = B`. (3) The menu badge shows "Signed in via B".
  - Postconditions: The badge reflects this login (B) while the bound identity remains A.
  - Gate-safety: Identity binding is server-side and never rebound; the badge cannot be spoofed by the client.

---

## Provider badge reflects the CURRENT login (`lastLoginProvider`)

### Purpose
When a user signs in, the account menu shows a "Signed in via GitHub / Google / Email account" badge that reflects the provider used for THIS login — not whatever identity the account is permanently bound to. The system records `lastLoginProvider` on every OAuth login path and `toPublic` prefers it over the identity derived from `externalId`, so the badge stays honest even when an account bound to one identity (e.g. `github:…`) signs in through a different verified-email provider (e.g. Google). This serves the AKIS trust thesis: what the UI tells you about your session is provably the truth of what just happened, with no silent identity rebind behind the scenes.

### Functional Requirements

- **FR-provider-badge-1**: The system SHALL expose `AuthProvider = 'github' | 'google' | 'password'` and a pure `providerOf(externalId)` that returns `'github'` for an id prefixed `github:`, `'google'` for `google:`, and `'password'` for any other value including `undefined`, `''`, and unknown namespaces.
- **FR-provider-badge-2**: The system SHALL project the wire-safe `PublicUser.provider` as `lastLoginProvider ?? providerOf(externalId)` — i.e. it SHALL prefer the recorded most-recent-login provider and fall back to deriving from the bound `externalId` only when `lastLoginProvider` is absent.
- **FR-provider-badge-3**: On an OAuth login where the provider identity already exists (`byExternalId` / `external_id` match), the system SHALL set `lastLoginProvider` to the provider of the incoming `externalId` and return the same bound account, never minting a new one.
- **FR-provider-badge-4**: On an OAuth login that links a provider identity to an existing verified-email account that has NO `externalId` yet (fresh link), the system SHALL record `lastLoginProvider`, bind `externalId` to the new identity, and adopt the provider avatar only when the account had none (`avatar_url = COALESCE(avatar_url, $2)`).
- **FR-provider-badge-5**: On an OAuth login for an email account ALREADY bound to a DIFFERENT identity (cross-provider same-email — e.g. Google login on a `github:`-bound email), the system SHALL set `lastLoginProvider` to the current login's provider and SHALL NOT clobber the existing `external_id` (the bound identity is permanent).
- **FR-provider-badge-6**: In the cross-provider case of FR-provider-badge-5, `toPublic` SHALL therefore report `provider = 'google'` (the login just used) while the row's `externalId` remains `github:…`, making the badge reflect THIS login rather than the bound identity.
- **FR-provider-badge-7**: On OAuth account CREATION (no identity, no existing email, and creation permitted), the system SHALL persist `lastLoginProvider` set to the provider of the new identity.
- **FR-provider-badge-8**: When OAuth creation is refused because signup is disabled (`allowCreate === false`), the system SHALL return `null` and SHALL NOT record any provider or mint an account.
- **FR-provider-badge-9**: A password (non-OAuth) account SHALL have no `lastLoginProvider` and no `externalId`, so `toPublic` SHALL derive `provider = 'password'`.
- **FR-provider-badge-10**: The Postgres `last_login_provider` column SHALL be nullable `text` constrained by `CHECK (last_login_provider IN ('github','google','password'))`, present both in `CREATE_USERS_TABLE` and in the idempotent `ADD_USER_LAST_LOGIN_PROVIDER` `ADD COLUMN IF NOT EXISTS` migration.
- **FR-provider-badge-11**: When mapping a DB row to `AuthUser`, the system SHALL accept `last_login_provider` into `lastLoginProvider` ONLY when it is exactly `'github'`, `'google'`, or `'password'`; any other/`NULL` value SHALL be dropped (so `toPublic` falls back to `providerOf(externalId)`), preventing a stray DB string from widening `AuthProvider`.
- **FR-provider-badge-12**: For rows written before this column existed (`lastLoginProvider` absent), `toPublic` SHALL still produce a correct badge by deriving from `externalId`, so the feature is backward-compatible.
- **FR-provider-badge-13**: The authenticated `GET /auth/me` endpoint SHALL re-read the user via `findById` and re-project via `toPublic`, so the badge returned to the client reflects the persisted `lastLoginProvider` after any login (not just the freshly-issued session).
- **FR-provider-badge-14**: The OAuth callback SHALL issue the session cookie from `toPublic(user)` after `upsertOAuth`, so the very first response after an OAuth login already carries the correct `provider`.
- **FR-provider-badge-15**: The frontend account menu SHALL map `provider` to a localized label + glyph: `github → "Signed in via GitHub"` with the GitHub mark, `google → "Signed in via Google"` with the Google mark, and any other value (including absent) → `"Email account"` with no mark.

### Non-Functional Requirements

**Security / Gate-safety**
- **NFR-provider-badge-1**: Recording `lastLoginProvider` SHALL NOT relax any auth gate: the cross-provider path SHALL NOT rebind `external_id` and SHALL NOT touch `status` (no silent re-activation of a `disabled`/`deleted` account that can still pass the provider email check).
- **NFR-provider-badge-2**: The provider badge value SHALL be confined to the `AuthProvider` value-domain at both the DB boundary (CHECK constraint, FR-10) and the row-mapper boundary (whitelist, FR-11), so an injected/garbage value cannot escalate or display as an arbitrary string.
- **NFR-provider-badge-3**: Recording the login provider SHALL NOT bypass the no-open-signup posture: it occurs only on existing-identity/existing-email/permitted-create paths, never minting an account when `allowCreate === false`.

**Privacy / secrets**
- **NFR-provider-badge-4**: `toPublic` SHALL never include `passwordHash` or other internal fields when projecting `provider`/`avatarUrl`; the badge data is derived solely from non-secret fields.

**Reliability / concurrency**
- **NFR-provider-badge-5**: The Pg create path SHALL remain race-safe: on a `23505` unique violation from a concurrent first login, it SHALL recover the existing row (including its recorded provider) rather than failing.
- **NFR-provider-badge-6**: Pg writes that record the provider SHALL use `RETURNING *` (and an in-memory fallback object carrying `lastLoginProvider`) so the returned `AuthUser` reflects the just-written value, keeping the issued session and the persisted row consistent.

**Performance**
- **NFR-provider-badge-7**: Recording `lastLoginProvider` SHALL add no extra round-trip — it is folded into the existing per-path `UPDATE`/`INSERT` (an extra assigned column, not a new query).

**Usability / Accessibility**
- **NFR-provider-badge-8**: The badge SHALL degrade gracefully for unknown/absent providers by showing "Email account" with no glyph rather than an empty or broken label.

**Internationalization (TR+EN parity)**
- **NFR-provider-badge-9**: Every badge label key SHALL have both EN and TR entries with no gaps: `account.via.github`, `account.via.google`, `account.via.password`.

**Maintainability / Strict-TS**
- **NFR-provider-badge-10**: Optional fields SHALL respect `exactOptionalPropertyTypes`: `avatarUrl`/`lastLoginProvider` SHALL be attached only when present (spread guards), never written as an explicit `undefined`.
- **NFR-provider-badge-11**: `providerOf` and `AuthProvider` SHALL be the single shared source of truth, reused by `toPublic`, `PgUserStore`, and tests, so the badge mapping cannot drift between layers.

**Honesty / Trust-legibility**
- **NFR-provider-badge-12**: The badge SHALL report the provider of the login that just occurred, never a stale or merely-bound identity; the cross-provider invariant (record provider, never clobber identity) SHALL be enforced by test.

**Self-hostability**
- **NFR-provider-badge-13**: The feature SHALL work identically on the in-memory store and the Pg store, and the Pg column SHALL be provisioned by an idempotent `ADD COLUMN IF NOT EXISTS` migration so an upgraded self-hosted DB gains it safely with no manual step.

### Use Cases

- **UC-provider-badge-1 — Returning OAuth user sees the correct provider**
  - Actor: Authenticated user who previously signed in via GitHub. Preconditions: An account exists bound to `external_id = github:…`.
  - Main flow: (1) User completes the GitHub OAuth callback. (2) `upsertOAuth` matches by `external_id` and sets `last_login_provider='github'`. (3) The callback issues a session from `toPublic(user)`. (4) The menu renders the GitHub glyph + "Signed in via GitHub".
  - Postconditions: `lastLoginProvider='github'`; identity unchanged; badge correct. Gate-safety: No account created; `status` untouched.

- **UC-provider-badge-2 — Cross-provider same-email login (Google on a GitHub-bound email)**
  - Actor: User whose verified email is bound to a `github:` identity, signing in this time with Google. Preconditions: Account exists with `external_id = github:115497334`; the Google profile returns the SAME verified email.
  - Main flow: (1) Google OAuth callback completes. (2) `upsertOAuth` finds the account by email, sees an existing `external_id`, and updates ONLY `last_login_provider='google'` (and avatar via COALESCE). (3) Session is issued from `toPublic`, which returns `provider='google'`. (4) Badge shows the Google glyph + "Signed in via Google".
  - Postconditions: `external_id` STILL `github:115497334`; `lastLoginProvider='google'`; badge reflects the current login. Alternate: New avatar refreshes; absent avatar preserves the existing photo.
  - Gate-safety: Identity is NOT rebound and `status` is NOT changed — no silent re-activation or identity hijack.

- **UC-provider-badge-3 — First-time link of an OAuth identity to a password account**
  - Actor: Owner who created a password account, now signing in via Google for the first time. Preconditions: Account exists with no `external_id`; provider-verified email matches.
  - Main flow: (1) Google callback completes. (2) `upsertOAuth` links `external_id=google:…`, sets `last_login_provider='google'`, marks email verified, adopts the avatar only if absent. (3) Badge shows "Signed in via Google".
  - Postconditions: Account now bound to the Google identity; `lastLoginProvider='google'`. Gate-safety: Linking does not write `status='active'`.

- **UC-provider-badge-4 — Pre-feature account logs in (backward compatibility)**
  - Actor: User whose row predates the `last_login_provider` column. Preconditions: Row has `external_id` but `last_login_provider IS NULL`.
  - Main flow: (1) `GET /auth/me` re-reads the row and projects via `toPublic`. (2) With no `lastLoginProvider`, `provider` is derived from `externalId`. (3) Badge shows the matching provider.
  - Postconditions: Correct badge with no migration data; the next OAuth login records `last_login_provider` going forward.

- **UC-provider-badge-5 — Password user sees "Email account"**
  - Actor: User with a pure password account. Preconditions: No `externalId`, no `lastLoginProvider`.
  - Main flow: (1) After login, `toPublic` derives `provider='password'`. (2) The menu shows "Email account" with no glyph.
  - Postconditions: Honest non-OAuth badge.

- **UC-provider-badge-6 — OAuth login attempt while signup is disabled**
  - Actor: A would-be new user hitting OAuth with signup closed. Preconditions: `signupDisabled` true ⇒ `allowCreate=false`; no matching identity/email.
  - Main flow: (1) `upsertOAuth` reaches the create step and returns `null`. (2) The callback redirects to login with `oauth_denied`.
  - Postconditions: No account created, no provider recorded, no badge. Gate-safety: Enforces the no-open-signup / no-sandbox-RCE posture.

---

## Atlassian Jira-only MCP connect + Confluence scope-gating

### Purpose
This feature lets a signed-in AKIS user connect their own Atlassian Cloud account over a browser OAuth 2.1 + PKCE flow (driven by the MCP SDK with Dynamic Client Registration, so no OAuth app to register and no PAT to paste) and then propose-and-confirm external writes (Jira issues, and Confluence pages where granted) from a finished build. Because the connected Atlassian site only grants Jira scopes, the requested OAuth scope is reduced to Jira-only (`offline_access read:me read:jira-work write:jira-work`) so Atlassian doesn't fail the whole authorization on an ungranted Confluence scope; the frontend then offers the Confluence publish button only when the *live granted* scope actually contains `write:confluence-content`, so the UI never lets a user mint a proposal that would be rejected at execution. This serves the AKIS trust thesis: capabilities are surfaced honestly from real granted scope (data-driven, auto-restoring), and every outward write still flows through the external-write gate (agent proposes → human confirms the exact bytes), never autonomously.

### Functional Requirements

- **FR-atlassian-jira-1** — The system SHALL request only the Jira-and-identity OAuth scope set `offline_access read:me read:jira-work write:jira-work` for the Atlassian provider, and SHALL NOT request any Confluence scope (`read:confluence-content.all`, `write:confluence-content`, `read:confluence-space.summary`), so that a Confluence scope the connected Atlassian site does not grant cannot cause Atlassian to fail the entire authorization.
- **FR-atlassian-jira-2** — The system SHALL connect the Atlassian provider via the MCP SDK's Dynamic Client Registration and SHALL NOT supply a static OAuth client for it; only `github` receives a static client (`staticClientFor` returns `{}` for any provider other than `github`).
- **FR-atlassian-jira-3** — On `GET /mcp/atlassian/connect`, the system SHALL require an authenticated user, returning HTTP 401 `{error:'unauthorized', code:'Unauthorized'}` when `userIdOf` resolves no user.
- **FR-atlassian-jira-4** — On `GET /mcp/:provider/connect` with an unknown provider id, the system SHALL redirect to `${base}/settings?mcp=unknown` without starting any OAuth flow.
- **FR-atlassian-jira-5** — On `GET /mcp/atlassian/connect`, the system SHALL fail closed when the token store cannot persist (`store.canStore()` is false), redirecting to `${base}/settings?mcp=unavailable` and never starting an OAuth flow it cannot persist.
- **FR-atlassian-jira-6** — When the SDK `auth()` returns `'REDIRECT'` and an authorization URL was captured, the system SHALL override the URL's `state` query parameter with a freshly HMAC-signed, short-TTL value bound to `(userId, 'atlassian')` and SHALL redirect the browser to that authorization URL.
- **FR-atlassian-jira-7** — When the SDK `auth()` returns `'AUTHORIZED'` on the connect step (cached/valid tokens already present), the system SHALL redirect to `${base}/settings?mcp=connected`; on any other result it SHALL redirect to `${base}/settings?mcp=error`.
- **FR-atlassian-jira-8** — When `auth()` throws during connect, the system SHALL redirect to `${base}/settings?mcp=error` and SHALL NOT echo the underlying error into the URL, response body, or logs.
- **FR-atlassian-jira-9** — On `GET /mcp/atlassian/callback`, the system SHALL verify the signed `state` FIRST (before any token exchange), refusing with `${base}/settings?mcp=denied` when the state is missing, forged, expired, or signed for a different provider than the path provider (`st.repo !== req.params.provider`).
- **FR-atlassian-jira-10** — On the callback, the system SHALL treat the signed-state `userId` as the authoritative identity, so the flow completes even under `SameSite=Strict` where the session cookie is dropped on the cross-site return; when a session cookie IS present (Lax), the system SHALL additionally require it to match `st.userId` and SHALL refuse with `mcp=denied` on mismatch.
- **FR-atlassian-jira-11** — On the callback, when the OAuth provider returned an `error` query param or no `code`, the system SHALL redirect to `${base}/settings?mcp=denied` without attempting a token exchange.
- **FR-atlassian-jira-12** — On a successful callback token exchange (`auth()` returns `'AUTHORIZED'`), the system SHALL clear the spent transient PKCE verifier for `(userId, 'atlassian')` and redirect to `${base}/settings?mcp=connected`; otherwise it SHALL redirect to `mcp=error` (and on a thrown exception, `mcp=error` with no error detail leaked).
- **FR-atlassian-jira-13** — `GET /mcp/atlassian/status` SHALL require authentication (401 when no user), SHALL return HTTP 404 `{code:'UnknownProvider'}` for an unknown provider, and otherwise SHALL return `{connected: boolean}` plus, only when tokens carry a scope, `scopes: <space-separated granted-scope string>` — and SHALL NEVER include the token itself.
- **FR-atlassian-jira-14** — The `scopes` value returned by `/status` SHALL be the live, server-granted scope string from the persisted OAuth tokens (`tokens.scope`), not the statically requested scope, so the client can detect what the connected site actually granted (persisted via `saveTokens` → store).
- **FR-atlassian-jira-15** — `DELETE /mcp/atlassian` SHALL require authentication (401 when no user), SHALL return 404 `{code:'UnknownProvider'}` for an unknown provider id, and otherwise SHALL remove the stored `(user, provider)` connection and return `{ok:true}`, remaining idempotent for a known-but-absent connection.
- **FR-atlassian-jira-16** — The ExternalWriteCard SHALL, on mount, fetch `/mcp/atlassian/status` and derive `confluenceAvailable` as true only when the returned `scopes` string, split on whitespace, contains the exact token `write:confluence-content`; on a status load error or while loading, `scopes` SHALL be `undefined` and Confluence SHALL be treated as unavailable (fail-safe).
- **FR-atlassian-jira-17** — When Atlassian is connected, the system SHALL render the "Create Jira issue" action unconditionally and SHALL render the "Publish to Confluence" action ONLY when `confluenceAvailable` is true; when false it SHALL instead display the `mcpwrite.confluenceUnavailable` notice explaining the connected Atlassian doesn't grant Confluence write access.
- **FR-atlassian-jira-18** — The Confluence gating SHALL be purely data-driven from the live grant with no client-side hard-coded "Confluence off" flag, so the Confluence action SHALL auto-restore the moment `write:confluence-content` reappears in the granted scope without a frontend code change.
- **FR-atlassian-jira-19** — When `/mcp/atlassian/status` reports `connected:false`, the card SHALL hide all write actions and instead show the amber "not connected" guidance with a link to `/settings`, rather than letting the user reach a confirm-time 409.
- **FR-atlassian-jira-20** — While the connection state is still loading (`connected === undefined`), the card SHALL render neither the action buttons nor the not-connected banner, hiding actions until the connection state is known.
- **FR-atlassian-jira-21** — On "Create Jira issue", the system SHALL require a non-empty project key, then propose an external write with `provider:'atlassian'`, `action:'createJiraIssue'`, `target:{projectKey}`, and `payload:{summary:title, description:readme}`; on "Publish to Confluence" it SHALL propose `action:'createPage'`, `target:{spaceKey}`, `payload:{title, body:readme}`.
- **FR-atlassian-jira-22** — After a successful propose, the system SHALL show a review step displaying the exact `target` and `payload` bytes (the same body the server-side digest bound) and the first 16 chars of the digest, and SHALL execute the write only after an explicit human confirm carrying that proposal id + digest.
- **FR-atlassian-jira-23** — When a confirm fails with HTTP 409, the system SHALL interpret it as "not connected / unavailable" and surface the localized `mcpwrite.notConnected` guidance; other errors SHALL surface their message (409 maps from `CONFLICT_ERRORS` server-side).
- **FR-atlassian-jira-24** — The system SHALL execute a confirmed Atlassian write through the per-user OAuth-backed transport resolved by `mcpTransportFor`, which SHALL return a transport only when the user has connected the provider (tokens present), and SHALL otherwise return `undefined` (honest absence → confirm replies 409).

### Non-Functional Requirements

- **NFR-atlassian-jira-1** (Security/Gate-safety) — Every Atlassian write capability granted by the OAuth scope (including `write:jira-work`) SHALL remain non-autonomous: the agent may only PROPOSE, and execution SHALL require an explicit human confirm of the exact target+payload bound by a server-side digest. The scope grants the *capability*, never autonomy.
- **NFR-atlassian-jira-2** (Security/CSRF) — The OAuth `state` SHALL be the sole unforgeable identity binding, HMAC-signed with a short TTL and verified before any token exchange; a missing, forged, expired, or cross-provider state SHALL be refused, and identity SHALL be taken from the signed state (not the cookie) so the flow is robust under `SameSite=Strict` cookie drop.
- **NFR-atlassian-jira-3** (Privacy/secrets) — Tokens SHALL never appear in any URL, log, response body, or error surface; connect/callback outcomes SHALL be conveyed only as `?mcp=connected|error|denied|unknown|unavailable`, `/status` SHALL return at most `connected`+`scopes`, and OAuth/SDK errors SHALL be swallowed into a generic `mcp=error`.
- **NFR-atlassian-jira-4** (Reliability/fail-closed & fail-safe) — The connect flow SHALL fail closed when encryption/persistence is unavailable (`canStore()===false → mcp=unavailable`), and the Confluence-gating UI SHALL fail safe: any status-load error or in-flight load SHALL be treated as Confluence-unavailable rather than offering an action that would be rejected at execution.
- **NFR-atlassian-jira-5** (Reliability/robustness) — Frontend status and history loads SHALL be wrapped so a synchronous throw (e.g. a partial/older API mock missing the method) becomes a handled rejection and the card degrades rather than crashing (`Promise.resolve().then(...)` pattern).
- **NFR-atlassian-jira-6** (Usability) — The Confluence button SHALL never present an action that would 409/reject at execution; the user SHALL be guided to Settings before reaching a confirm-time failure when not connected, and SHALL see a plain-language reason when Confluence is unavailable due to scope.
- **NFR-atlassian-jira-7** (Internationalization / TR+EN parity) — All user-facing strings SHALL be localized with matching EN and TR keys, including `mcpwrite.confluenceUnavailable`, `mcpwrite.toConfluence`, `mcpwrite.toJira`, `mcpwrite.spaceKey`, `mcpwrite.projectKey`, `mcpwrite.notConnected`, `mcpwrite.goSettings`, and the `mcpwrite.st.*` status labels; both locales SHALL be present with no missing key.
- **NFR-atlassian-jira-8** (Maintainability/Strict-TS) — The Confluence scope check SHALL key off a single named constant (`CONFLUENCE_WRITE_SCOPE`) and the provider scope SHALL live in one `REMOTE_MCP_PROVIDERS.atlassian.scope` string, so re-enabling Confluence is a single backend-scope edit that the data-driven UI follows automatically; `staticClientFor` SHALL return a spreadable `{}` (never a present-but-undefined key) to satisfy `exactOptionalPropertyTypes`.
- **NFR-atlassian-jira-9** (Honesty/Trust-legibility) — The UI SHALL reflect only the *live granted* capability (derived from `tokens.scope` via `/status`) rather than the requested scope, so the surface never over-claims; when the scope is re-added to the Atlassian app the Confluence capability SHALL re-appear with no code change (auto-restoring).
- **NFR-atlassian-jira-10** (Self-hostability) — The Atlassian connection SHALL require no AKIS-registered OAuth app (DCR handles client provisioning) and no PAT, so a self-hosting operator needs only a user with an Atlassian Cloud site carrying Jira (and, optionally, Confluence) permissions; absent connection degrades honestly to no MCP tools (`mcpTransportFor` returns `undefined`).

### Use Cases

- **UC-atlassian-jira-1 — Connect an Atlassian (Jira) account**
  - Actor: Signed-in AKIS user. Preconditions: Encryption/token store configured (`canStore()` true); user has an Atlassian Cloud site with Jira permissions.
  - Main flow: (1) User triggers `GET /mcp/atlassian/connect` from Settings. (2) System verifies auth and a known provider, confirms `canStore()`. (3) SDK performs DCR + PKCE and captures the authorization URL; system overrides `state` with a signed `(userId, 'atlassian')` token and redirects to Atlassian consent. (4) User consents to the Jira-only scopes; Atlassian redirects back to `/mcp/atlassian/callback?code&state`. (5) System verifies the signed state first, exchanges the code (PKCE), persists encrypted tokens, clears the spent verifier, and redirects to `/settings?mcp=connected`.
  - Postconditions: `(user, atlassian)` tokens stored; `/status` returns `connected:true` with the live granted scopes.
  - Alternate/Error: Unauthenticated → 401. Encryption off → `mcp=unavailable`. User denies / no code → `mcp=denied`. Forged/expired/cross-provider state → `mcp=denied`. Cookie-mismatch → `mcp=denied`. SDK/auth throw → `mcp=error` with no detail.
  - Gate-safety: Connecting only grants capability; no write occurs at connect time.

- **UC-atlassian-jira-2 — Propose & confirm a Jira issue from a build**
  - Actor: Signed-in user (build owner). Preconditions: Atlassian connected; a finished build with an idea/README; a valid Jira project key.
  - Main flow: (1) Card loads `/status`; sees `connected:true` and renders the "Create Jira issue" action. (2) User opens the Jira form, enters a project key, and proposes. (3) System mints a proposal and shows the review step with exact bytes + digest. (4) User confirms; system executes via the per-user OAuth transport. (5) System shows the result and refreshes history.
  - Postconditions: A Jira issue is created; the write appears in history with its outcome.
  - Alternate/Error: Empty key → propose disabled. Confirm 409 → localized "Connect Jira/Confluence in Settings first." Other errors → message surfaced.
  - Gate-safety: The write fires only on explicit human confirm of the exact digest-bound bytes.

- **UC-atlassian-jira-3 — Confluence action hidden because the live grant lacks the scope**
  - Actor: Signed-in user. Preconditions: Atlassian connected, but the granted scope does NOT include `write:confluence-content`.
  - Main flow: (1) Card derives `confluenceAvailable = false`. (2) Card renders only the Jira action and shows `mcpwrite.confluenceUnavailable`.
  - Postconditions: No Confluence proposal can be minted. Alternate: Status load fails/loading → `scopes` undefined → fail-safe unavailable.
  - Gate-safety: Capability surfaced honestly from real granted scope.

- **UC-atlassian-jira-4 — Confluence auto-restores when the scope is re-added**
  - Actor: AKIS owner/operator + end user. Preconditions: Owner re-adds the Confluence write scope to `REMOTE_MCP_PROVIDERS.atlassian.scope`; the connected site enables Confluence + Rovo MCP with `write:confluence-content`; the user re-connects.
  - Main flow: (1) On the next connect, Atlassian grants the Confluence scope; tokens persist with `...write:confluence-content...`. (2) `/status` returns that scope. (3) The card derives `confluenceAvailable = true` and renders "Publish to Confluence" with no frontend code change.
  - Postconditions: Confluence publish becomes available, data-driven. Gate-safety: Re-enabling adds capability only; writes still require propose → human confirm.

- **UC-atlassian-jira-5 — Disconnect / not-connected guidance**
  - Actor: Signed-in user. Preconditions: User wants to remove the connection, or has never connected.
  - Main flow: (1) `DELETE /mcp/atlassian` removes the stored connection and returns `{ok:true}` (idempotent for known-but-absent). (2) The card's next `/status` returns `connected:false`; it hides all actions and shows the amber "not connected" banner linking to `/settings`.
  - Postconditions: No tokens remain; the card guides re-connection. Alternate/Error: Unauthenticated → 401. Unknown provider → 404 `UnknownProvider`.
  - Gate-safety: Disconnect revokes capability locally; no write side effects.

---

## GitHub remote MCP connect (static-client, DCR bypass)

### Purpose
Lets a signed-in AKIS user connect their own GitHub account to GitHub's remote MCP server (`api.githubcopilot.com/mcp/`) through a browser OAuth 2.1 + PKCE flow, so agents can read real repo/org/user context as grounded MCP tools instead of guessing. Because `github.com/login/oauth` has no Dynamic Client Registration endpoint and a non-standard token endpoint, AKIS hands the MCP SDK a *static* pre-registered OAuth client (its existing GitHub OAuth App) via `clientInformation()`, which makes the SDK skip DCR and run the rest of the standard flow against GitHub's discovered endpoints. This keeps the "agents really use MCP" capability real and per-user while every write the connection enables still flows through the external-write gate (agent proposes, human confirms), preserving AKIS's trust thesis.

### Functional Requirements

- **FR-github-mcp-1**: The system SHALL expose the GitHub remote MCP server under the registry key `github` with `serverUrl = https://api.githubcopilot.com/mcp/`, `kind = 'streamable-http'`, and `scope = 'repo read:org read:user'`, and SHALL request exactly that scope on the authorization request.
- **FR-github-mcp-2**: For the `github` provider only, the system SHALL resolve a static OAuth client from AKIS's existing GitHub OAuth App credentials (`oauthCreds('github', env)` → `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`) and pass it to the provider as `staticClient`. For any other provider it SHALL NOT pass a static client, preserving the DCR path.
- **FR-github-mcp-3**: When a static client is configured, `StoreBackedOAuthProvider.clientInformation()` SHALL return `{ client_id, client_secret }` from that static client (not the store record), causing the MCP SDK to skip Dynamic Client Registration entirely and proceed to PKCE authorize + token exchange against GitHub's discovered endpoints.
- **FR-github-mcp-4**: With a static client set, `saveClientInformation()` SHALL be a no-op and SHALL NOT overwrite the static credentials with any store record, keeping the static client authoritative and the auth store free of DCR client info for GitHub.
- **FR-github-mcp-5**: `GET /mcp/github/connect` SHALL require an authenticated user; when absent it SHALL respond `401` with `{ error: 'unauthorized', code: 'Unauthorized' }` and SHALL NOT begin any OAuth flow.
- **FR-github-mcp-6**: `GET /mcp/github/connect` SHALL fail closed before starting the flow if the auth store cannot persist material: when `store.canStore()` is false it SHALL redirect to `${base}/settings?mcp=unavailable` and SHALL NOT invoke the SDK `auth()`.
- **FR-github-mcp-7**: On the connect step the system SHALL call the SDK `auth(provider, { serverUrl, scope })`; when it returns `'REDIRECT'` and an authorization URL was captured, the system SHALL append an HMAC-signed `state` bound to `(userId, 'github')` via `signConnectState` and 302 the user's browser to GitHub's authorization URL. The server SHALL never perform the redirect itself inside the SDK — `redirectToAuthorization` only captures the URL.
- **FR-github-mcp-8**: The system SHALL set `redirectUrl = ${baseUrl(req,env)}/mcp/github/callback`, and this callback SHALL be covered by AKIS's existing GitHub OAuth App registered base `/` redirect, so no new redirect URI registration is required.
- **FR-github-mcp-9**: If the connect-step `auth()` returns `'AUTHORIZED'` (valid cached tokens already present), the system SHALL redirect to `${base}/settings?mcp=connected` without re-prompting the user.
- **FR-github-mcp-10**: If the connect-step `auth()` returns any other result, or throws (e.g. discovery failure, or missing GitHub OAuth App creds so DCR is attempted and fails), the system SHALL redirect to `${base}/settings?mcp=error` and SHALL NOT echo the underlying error or any token material into the URL, log, or response body.
- **FR-github-mcp-11**: When the GitHub OAuth App credentials are absent, `staticClientFor` SHALL return `{}` so no static client is passed; the SDK then attempts DCR against GitHub (which has no registration endpoint) and fails, producing an honest `mcp=error` redirect rather than a crash.
- **FR-github-mcp-12**: During the connect step the PKCE `code_verifier` produced by the SDK SHALL be persisted via `saveCodeVerifier` into the per-(user,provider) store, and the static `client_secret` SHALL NOT be persisted to the store at any point.
- **FR-github-mcp-13**: `GET /mcp/github/callback` SHALL treat the OAuth return as denied (`mcp=denied`) when `query.error` is present or `query.code` is missing.
- **FR-github-mcp-14**: The callback SHALL verify the `state` HMAC signature, expiry, and provider binding *before* any token exchange: it SHALL refuse (`mcp=denied`) when `state` is missing, forged, expired, or `st.repo !== 'github'`. The signed `state.userId` SHALL be the authoritative identity so the flow survives `SameSite=Strict` cookie drop.
- **FR-github-mcp-15**: As defense-in-depth, when a session cookie IS present on the callback (`SameSite=Lax`), the system SHALL require `cookieUser === st.userId` and SHALL refuse (`mcp=denied`) on mismatch; when the cookie is absent (`Strict`) this check SHALL be skipped.
- **FR-github-mcp-16**: On a valid callback the system SHALL call `auth(provider, { serverUrl, authorizationCode })`; when it returns `'AUTHORIZED'` it SHALL persist the access/refresh tokens via `saveTokens`, clear the spent PKCE verifier (`store.clearVerifier`), and redirect to `${base}/settings?mcp=connected`; otherwise redirect to `${base}/settings?mcp=error`.
- **FR-github-mcp-17**: `codeVerifier()` SHALL throw a non-secret error when no verifier is stored for the in-flight connect (expired or out-of-order callback); the route SHALL catch it and redirect `mcp=error`.
- **FR-github-mcp-18**: `GET /mcp/github/status` SHALL require auth, and for a known provider SHALL return `{ connected: <bool> }` derived solely from the presence of stored `tokens`, plus `scopes` (the token's granted scope string) when available, and SHALL NEVER return the access or refresh token.
- **FR-github-mcp-19**: `DELETE /mcp/github` SHALL require auth, validate the provider (returning `404 UnknownProvider` for an unknown id), and on a known provider remove the entire stored connection and return `{ ok: true }`, idempotently for a known-but-absent connection.
- **FR-github-mcp-20**: An unknown provider id on `/mcp/:provider/connect` or `/mcp/:provider/callback` SHALL redirect to `${base}/settings?mcp=unknown` rather than starting any flow.
- **FR-github-mcp-21**: For agent use, `mcpTransportFor({ userId, provider: 'github', … })` SHALL return an `HttpMcpTransport` only when stored `tokens` exist (else `undefined` = honest "not connected, no tools"), and SHALL construct its `StoreBackedOAuthProvider` with the SAME static GitHub client so SDK auto-refresh presents that static client at GitHub's token endpoint (avoiding a DCR fallback on refresh).
- **FR-github-mcp-22**: Token auto-refresh SHALL be handled by the SDK transport (bearer attach + refresh on 401), with rotated tokens re-persisted via `saveTokens`; AKIS SHALL NOT hand-roll refresh logic.

### Non-Functional Requirements

**Security / Gate-safety**
- **NFR-github-mcp-1**: Every connect/callback/status/disconnect route SHALL be auth-gated and SHALL never create a session or account; the callback SHALL bind identity through the HMAC-signed `state` (CSRF + flow integrity + identity) verified before token exchange.
- **NFR-github-mcp-2**: The `state` HMAC SHALL use a constant-time comparison and a tight TTL (≤600s) and SHALL bind both userId and the `github` provider, so a state cannot be tampered, replayed cross-provider, or swapped between users.
- **NFR-github-mcp-3**: Any write tool exposed by the GitHub MCP server SHALL still pass through the external-write gate (agent proposes → human confirms); the connection grants capability, never autonomous writes.
- **NFR-github-mcp-4**: The GitHub OAuth App `client_secret` SHALL exist only in-process; it SHALL never be written to the auth store, placed in a URL, returned in a response, or logged.

**Privacy / secrets**
- **NFR-github-mcp-5**: Access tokens, refresh tokens, DCR client info, and the PKCE verifier SHALL be stored only inside one AES-256-GCM encrypted blob, AAD-bound to `<provider>:<userId>`, file mode `0600`.
- **NFR-github-mcp-6**: Error and status responses SHALL be token-free; failures SHALL surface only the opaque `mcp=connected|error|denied|unavailable|unknown` query token, never the underlying OAuth/discovery error text.

**Reliability / concurrency**
- **NFR-github-mcp-7**: The store SHALL be owner-scoped one instance per `(userId, provider)`; an undecryptable row (rotated/unset master key, corrupt file) SHALL read as ABSENT (never throw), so the user is treated as not-connected and can re-connect.
- **NFR-github-mcp-8**: The connect route SHALL fail closed (`mcp=unavailable`) when encryption is not configured, so the system never begins an OAuth flow whose result it cannot persist.
- **NFR-github-mcp-9**: Stored material SHALL be restart-durable (persisted to disk), so a connection survives process restarts without re-auth.

**Performance**
- **NFR-github-mcp-10**: OAuth endpoint discovery and DCR-skip SHALL avoid an unnecessary DCR round-trip for GitHub; with a static client present, no registration request is issued.

**Usability / Accessibility**
- **NFR-github-mcp-11**: All flow outcomes SHALL land the user back on `/settings` with a stable, machine-readable `mcp=` status the FE maps to a user-facing message (no dead-end pages).

**Internationalization (TR + EN parity)**
- **NFR-github-mcp-12**: Each `mcp=` outcome SHALL have a matching FE catalog string in both English and Turkish (`settings.mcp.ok.connected`, `settings.mcp.err.error`, `settings.mcp.err.denied`, `settings.mcp.err.unavailable`, plus connect/disconnect/connected labels) with full TR/EN parity.

**Maintainability / Strict-TS**
- **NFR-github-mcp-13**: The static-client option SHALL be modeled so `exactOptionalPropertyTypes` is satisfied — `staticClientFor` returns a spreadable `{ staticClient? }` so the key is OMITTED (not present-but-undefined) when creds are absent.
- **NFR-github-mcp-14**: The DCR-vs-static branching SHALL live entirely in `clientInformation()`/`saveClientInformation()`/`staticClientFor`, keeping the connect/callback/transport routes provider-agnostic and the Atlassian DCR path unchanged.

**Honesty / Trust-legibility**
- **NFR-github-mcp-15**: Absence of GitHub OAuth App creds SHALL degrade honestly to `mcp=error` (DCR attempted and fails), matching a missing-OAuth-app outcome rather than masking it; `status` SHALL report `connected:false` whenever tokens are absent.
- **NFR-github-mcp-16**: `mcpTransportFor` SHALL return `undefined` (no MCP tools) for an unconnected GitHub provider, so the agent never claims a capability it lacks.

**Self-hostability**
- **NFR-github-mcp-17**: The static GitHub client SHALL reuse the operator's existing `GITHUB_OAUTH_CLIENT_ID/SECRET` and the existing base-`/` redirect, so a self-hosted operator needs no separate OAuth app or extra redirect-URI registration to enable GitHub remote MCP.

### Use Cases

- **UC-github-mcp-1 — Connect GitHub remote MCP (happy path)**
  - Actor: Signed-in AKIS user (browser). Preconditions: User authenticated; `GITHUB_OAUTH_CLIENT_ID/SECRET` configured; master key usable (`canStore()` true).
  - Main flow: (1) User clicks "Connect" for GitHub → `GET /mcp/github/connect`. (2) Server confirms auth and `canStore()`, builds the provider with the static GitHub client. (3) SDK `auth()` discovers GitHub endpoints, skips DCR, generates PKCE, persists the verifier, and captures the authorize URL → `'REDIRECT'`. (4) Server appends a signed `state=(userId, github)` and 302s to GitHub's authorize page. (5) User approves the `repo read:org read:user` scopes; GitHub redirects to `/mcp/github/callback?code&state`. (6) Server verifies `state` and exchanges the code; tokens encrypted-stored, the verifier cleared. (7) Server redirects to `/settings?mcp=connected`.
  - Postconditions: Encrypted tokens persisted for `(userId, github)`; `/status` returns `{ connected: true, scopes }`.
  - Gate-safety: Only read/connect capability is established; any subsequent write tool still requires the external-write gate confirmation.

- **UC-github-mcp-2 — Agent uses connected GitHub MCP for grounding**
  - Actor: AKIS agent/orchestrator (on behalf of the session owner). Preconditions: Owner has connected GitHub (UC-1); `PUBLIC_BASE_URL` set.
  - Main flow: (1) Orchestrator calls `mcpTransportFor({ userId, provider:'github', store, env })`. (2) Store confirms tokens exist → an `HttpMcpTransport` is built with the static GitHub client. (3) SDK attaches the bearer; on 401 it auto-refreshes against GitHub's token endpoint and re-persists rotated tokens. (4) Agent reads repo/org/user context via MCP tools.
  - Postconditions: Refreshed tokens persisted; agent has grounded GitHub context. Alternate: No stored tokens → `mcpTransportFor` returns `undefined` → no GitHub MCP tools (honest absence).
  - Gate-safety: Read grounding is autonomous; proposed writes route through the external-write gate.

- **UC-github-mcp-3 — Encryption not configured (fail-closed)**
  - Actor: Signed-in user. Preconditions: Master key not usable (`canStore()` false).
  - Main flow: `GET /mcp/github/connect` → server detects `!canStore()` → redirects `/settings?mcp=unavailable` without starting OAuth.
  - Postconditions: No flow begun; FE shows the EN/TR "encryption not configured" message. Gate-safety: System never holds tokens it cannot encrypt.

- **UC-github-mcp-4 — User declines / forged or expired return**
  - Actor: Signed-in user (or attacker). Preconditions: A callback hits `/mcp/github/callback`.
  - Main / Error flows: (1) GitHub returns `?error=access_denied` or no `code` → `mcp=denied`. (2) `state` missing/forged/expired or `state.repo !== 'github'` → `mcp=denied`, refused before any token exchange. (3) Present session cookie whose user ≠ signed-state user (Lax) → `mcp=denied`. (4) Exchange/discovery throws or returns non-`AUTHORIZED` → `mcp=error`, token-free.
  - Postconditions: No tokens stored; no error detail leaked. Gate-safety: Identity binding enforced by the signed state, surviving SameSite=Strict cookie drop.

- **UC-github-mcp-5 — Missing GitHub OAuth App credentials (honest degrade)**
  - Actor: Signed-in user on an operator instance without GitHub OAuth App creds. Preconditions: `GITHUB_OAUTH_CLIENT_ID/SECRET` absent; `canStore()` true.
  - Main flow: Connect proceeds without a static client → SDK attempts DCR against GitHub → fails → caught → `/settings?mcp=error`.
  - Postconditions: No tokens; outcome indistinguishable from a missing OAuth app, never a crash. Gate-safety: No capability granted.

- **UC-github-mcp-6 — Disconnect GitHub**
  - Actor: Signed-in user. Preconditions: Authenticated; GitHub connection may or may not exist.
  - Main flow: `DELETE /mcp/github` → provider validated → `store.remove(userId, 'github')` → `{ ok: true }`.
  - Postconditions: Connection wiped; `status` returns `{ connected: false }`; `mcpTransportFor` returns `undefined`. Alternate/Error: Unknown provider id → `404 UnknownProvider`; known-but-absent → idempotent `{ ok: true }`.

---

## Provider-aware external-write gate + GitHub write-action allow-list

### Purpose
The external-write gate is the security keystone that lets an AKIS agent *propose* a write to a connected external system (Atlassian Jira/Confluence or GitHub) over MCP, but **never perform one** — a write executes only after an explicit human confirmation, and only of the exact content the human reviewed. This is the AKIS trust thesis applied to outward side effects: the model produces, a human approves, the server executes, so the model is never autonomous over an action that touches someone else's repo or tracker. The provider-aware allow-list narrows this further — each provider admits only its own frozen, live-MCP-verified set of write-tool names, with the irreversible `merge_pull_request` getting the strongest friction.

### Functional Requirements

- **FR-ext-write-gate-1** — The system SHALL define `ExternalWriteProvider` as the closed union `'atlassian' | 'github'` and maintain one frozen write-action allow-list per provider via `WRITE_ACTIONS_BY_PROVIDER: Record<ExternalWriteProvider, ReadonlySet<string>>`, so that adding a provider to the union is a compile error until its set is supplied.
- **FR-ext-write-gate-2** — The system SHALL expose `isAllowedExternalWriteAction(provider, action)` returning `true` if and only if `action` is a member of the allow-list set **for that provider**, and SHALL return `false` for an unknown provider (no set → `?.has(action) ?? false`).
- **FR-ext-write-gate-3** — The system SHALL pin `GITHUB_WRITE_ACTIONS` to exactly these 8 live-MCP-verified tool names and no others: `issue_write`, `add_issue_comment`, `pull_request_review_write`, `create_pull_request`, `update_pull_request`, `merge_pull_request`, `update_pull_request_branch`, `request_copilot_review`. A pinning test SHALL fail loudly if the set diverges, including asserting the flat names (`create_issue`, `update_issue`, `create_pull_request_review`) and the guessed consolidated `pull_request_write` are **absent**.
- **FR-ext-write-gate-4** — The system SHALL pin `ATLASSIAN_WRITE_ACTIONS` to exactly `createPage` and `createJiraIssue`, and SHALL guarantee the GitHub and Atlassian sets are disjoint — no name is valid for both providers.
- **FR-ext-write-gate-5** — The system SHALL reject cross-provider action smuggling: a GitHub action under provider `atlassian` (and vice-versa) SHALL be refused by `isAllowedExternalWriteAction` and SHALL cause `mintApprovedExternalWrite` to throw `ExternalWriteActionNotAllowedError`.
- **FR-ext-write-gate-6** — The system SHALL make each allow-list set immutable *in fact*: `add()`, `delete()`, and `clear()` on the set instance SHALL throw `TypeError`, and the set object SHALL be frozen, so the allow-list cannot be widened at runtime.
- **FR-ext-write-gate-7** — The system SHALL compute a stable SHA-256 content digest over the canonicalized `{provider, action, target, payload}` via `digestExternalWrite`, **excluding the proposal `id`** (a handle, not content).
- **FR-ext-write-gate-8** — The digest SHALL be invariant to object-key ordering at any depth (deep recursive key sort, including object keys inside arrays) while preserving array element order as content; the digest SHALL change when any content byte changes, when array element order changes, or when `action`/`target`/`payload`/`provider` changes.
- **FR-ext-write-gate-9** — The system SHALL define `ApprovedExternalWrite` as a nominal-branded token whose brand is a module-private `unique symbol`, so it cannot be written as a literal or forged with `as` outside the module; `mintApprovedExternalWrite` SHALL be the only producer.
- **FR-ext-write-gate-10** — `mintApprovedExternalWrite(proposal, confirmedDigest)` SHALL, in order: (a) throw `ExternalWriteActionNotAllowedError` if the action is off the provider's allow-list; (b) throw `ExternalWriteKeyCollisionError` if `target` and `payload` share any own key; (c) throw `ExternalWriteDigestMismatchError` if `confirmedDigest !== digestExternalWrite(proposal)`; and only on passing all three return a token bearing `{ writeId: proposal.id, digest }`.
- **FR-ext-write-gate-11** — The system SHALL enforce the disjoint-key invariant because `executeExternalWrite` merges `{...target, ...payload}` (a colliding key would let `payload` silently override `target` with no signal to the confirming human). `collidingExternalWriteKeys(target, payload)` SHALL be exported so the propose side runs the same predicate, and the check SHALL be re-asserted at execute.
- **FR-ext-write-gate-12** — `executeExternalWrite(token, transport, proposal)` SHALL be uncallable without a branded token, and SHALL re-verify before any transport call: (a) action still on the provider's allow-list (else `ExternalWriteActionNotAllowedError`); (b) `token.writeId === proposal.id` **and** `token.digest === digestExternalWrite(proposal)` (else `ExternalWriteDigestMismatchError`); (c) disjoint keys (else `ExternalWriteKeyCollisionError`). Only then SHALL it call `transport.callTool(proposal.action, {...target, ...payload})`.
- **FR-ext-write-gate-13** — On a post-mint tamper — an action/content swap that re-derives a matching digest but names an off-list or off-provider action — `executeExternalWrite` SHALL refuse and the transport SHALL NOT be called (zero `callTool` invocations).
- **FR-ext-write-gate-14** — `executeExternalWrite` SHALL normalize the provider response into `{ ok: boolean; text: string }` where `ok = !res.isError`, surfacing a provider-side failure as `ok:false` **without throwing**.
- **FR-ext-write-gate-15** — The system SHALL record a GitHub proposal through a single shared `recordGithubProposal` (used by both the propose route and the agent tool) that hardcodes `provider:'github'` as a non-parameter, so neither the route nor the model can record a GitHub proposal under another provider.
- **FR-ext-write-gate-16** — `recordGithubProposal` SHALL fail closed in order: reject an off-allow-list action; reject a `merge_pull_request` whose `target.pullNumber` is not a positive integer (so the typed-merge friction can never be skipped for a malformed merge); reject colliding target/payload keys; then compute the digest and append a `status:'proposed'` record. It SHALL never execute and SHALL hold no reference to mint/execute/the token.
- **FR-ext-write-gate-17** — The agent-facing `propose_github_write` tool SHALL advertise its action enum sourced from `[...GITHUB_WRITE_ACTIONS]` (schema cannot drift from the gate), SHALL close over `sessionId` and import only `recordGithubProposal` (never mint/execute/token), SHALL only ever append a `status:'proposed'` record, and SHALL never throw — every failure returns `Error: <why>` to the bounded tool loop.
- **FR-ext-write-gate-18** — The propose route `POST /sessions/:id/external-writes` SHALL default `provider` to `'atlassian'` (back-compat), route GitHub proposals through `recordGithubProposal`, validate Atlassian actions against the provider allow-list (else `400 BadAction`), and return `{ id, digest, summary }` where the digest is computed over the same narrowed `{provider, action, target, payload}` that validation used.
- **FR-ext-write-gate-19** — The confirm route `POST /sessions/:id/external-writes/:writeId/confirm` SHALL be the **only** path that executes, and SHALL: require an authenticated owner (`401` else); require a configured/connected per-provider MCP transport (`409 McpUnavailable`/`NotConnected` else); reject a non-`'proposed'` record as `409 AlreadyResolved`; validate via `mintApprovedExternalWrite` before any state change (mismatch → terminal `failed`, nothing written); then execute exactly once.
- **FR-ext-write-gate-20** — The confirm route SHALL enforce at-most-once execution: a per-`writeId` in-flight guard (`confirmingWrites` Set) rejects a concurrent confirm with `409 ConfirmInProgress`; the record is durably patched `proposed → executing` **before** the outward call, and only the winner of that single transition proceeds; a crash between call and outcome leaves an honest in-doubt `executing` record rather than re-executing.
- **FR-ext-write-gate-21** — Appends SHALL go through the shared `appendExternalWrite`, which under an optimistic-lock retry loop (max 5) evicts only the **oldest terminal** (`executed`/`failed`) record when the cap (`EXTERNAL_WRITES_MAX = 50`) is reached, never an in-flight `proposed`/`executing` record; if no slot is terminal it SHALL refuse with `TooManyPending` (surfaced as `409` by both providers) — preserving the at-most-once ledger so a re-proposed identical write can never execute twice.
- **FR-ext-write-gate-22** — GitHub proposal recording SHALL be idempotent by content digest: if a `status:'proposed'` record with the same `{provider, action, target, payload}` digest already exists, the system SHALL reuse it (return its `writeId`, no second append), re-evaluated against the freshly-read records on every retry attempt.
- **FR-ext-write-gate-23** — The list route `GET /sessions/:id/external-writes` SHALL return each record with a server-recomputed `digest` over its stored `{provider, action, target, payload}` so the confirm UI renders the exact bound bytes and confirms with that digest without a re-propose round-trip; it SHALL carry **no token**.
- **FR-ext-write-gate-24** — The confirm UI SHALL gate an irreversible `merge_pull_request` behind typing the literal `pullNumber` the digest binds: Confirm stays disabled until the typed value matches `String(pr)`, and the friction applies only when a `pullNumber` is present (otherwise it cannot demand an echo).

### Non-Functional Requirements

**Security / Gate-safety**
- **NFR-ext-write-gate-1** — The gate SHALL be orthogonal to the 4 structural build gates (spec-approval, producer≠verifier, verified-real, push): it neither reads nor mints any of them.
- **NFR-ext-write-gate-2** — There SHALL be exactly one production code path from a proposal to an external side effect: human-hit confirm route → mint → execute. The propose tool, recorder, and append helper SHALL import no reference to `mintApprovedExternalWrite`, `executeExternalWrite`, or the `ApprovedExternalWrite` type (gate-keeper reachability invariant).
- **NFR-ext-write-gate-3** — Every authority-bearing check (allow-list, digest, disjoint-keys) SHALL be enforced defense-in-depth at **both** mint and execute, so the unambiguous-merge and on-list properties never rest on mint alone.
- **NFR-ext-write-gate-4** — `merge_pull_request` is irreversible (can trigger deploys, cannot be undone) and SHALL carry both a backend numeric-`pullNumber` requirement and a frontend typed-PR-number confirmation; an `APPROVE` review SHALL be treated as destructive (can unblock a required-review merge) and warned.

**Privacy / secrets**
- **NFR-ext-write-gate-5** — No record, digest, list response, or token SHALL contain provider OAuth credentials; the transport is resolved at confirm time from the owner's per-provider MCP auth store and is owner-scoped. Result text SHALL be truncated (≤500 backend, ≤200 UI) to avoid unbounded leakage.

**Reliability / concurrency**
- **NFR-ext-write-gate-6** — External writes are non-idempotent at the provider; the system SHALL prevent double execution under sequential replay (status guard), concurrent confirms (in-flight Set + single `proposed→executing` transition), and crash/retry (durable in-doubt `executing` state).
- **NFR-ext-write-gate-7** — All read-modify-write persistence SHALL retry only on `version conflict` (optimistic lock, bounded to 5) and propagate other errors without silently swallowing them.

**Performance**
- **NFR-ext-write-gate-8** — Allow-list membership SHALL be O(1) `Set.has`; the persisted external-write row SHALL be hard-capped at `EXTERNAL_WRITES_MAX = 50` per session so state stays bounded.

**Usability / Accessibility**
- **NFR-ext-write-gate-9** — The confirm card SHALL render the human-readable summary plus the exact target/payload bytes and a digest preview, surface a not-connected state as guidance (not a confirm-time 409), and provide accessible merge friction (`role="alert"` banner, `aria-label` and `inputMode="numeric"` on the typed-PR-number input).

**Internationalization (TR + EN parity)**
- **NFR-ext-write-gate-10** — All confirm/merge/banner/status strings SHALL exist with full TR+EN parity, including the irreversible-merge banners (`aw.banner.merge` / `mergeNoBase`), the approve-destructive banner, the typed-merge prompt (`aw.merge.typeToConfirm` / `placeholder`), and the status labels — e.g. EN "IRREVERSIBLE — this MERGES PR #{n} into {base}…" / TR "GERİ ALINAMAZ — bu, PR #{n}'i {base} dalına BİRLEŞTİRİR…".

**Maintainability / Strict-TS**
- **NFR-ext-write-gate-11** — The provider→set map SHALL be a total `Record<ExternalWriteProvider, …>` so a new provider is a compile error until its allow-list is supplied; the action enum advertised to the model SHALL be derived from the single frozen set (no drift).
- **NFR-ext-write-gate-12** — The GitHub allow-list SHALL be guarded by a pinning test against the live-advertised tool names plus negative pins for the flat/consolidated names, so a server rename is caught loudly rather than silently refusing every write.

**Honesty / Trust-legibility**
- **NFR-ext-write-gate-13** — The model-facing tool SHALL report only that a write was *proposed* and is *awaiting human confirmation* ("not executed. Do not assume it happened"), never that it occurred. The UI SHALL frame AKIS as strictly on the propose side, the human as the executor.

**Self-hostability**
- **NFR-ext-write-gate-14** — Execution SHALL run through the `McpTransport` seam using the self-hoster's own connected, owner-scoped MCP connection — no AKIS-hosted credentials or central broker — so the gate works identically in a self-hosted deployment.

### Use Cases

- **UC-ext-write-gate-1 — Agent proposes a GitHub write during a build**
  - Actor: Build agent (LLM), via `propose_github_write`. Preconditions: A session exists; the tool is registered with `sessionId` closed over and a store injected.
  - Main flow: (1) The agent calls the tool with `{action, summary, target, payload}`. (2) The handler validates types and delegates to `recordGithubProposal` (provider hardcoded `github`). (3) The recorder checks the allow-list, the merge-`pullNumber` rule, and disjoint keys, computes the digest, and appends/reuses a `status:'proposed'` record. (4) The tool returns `Proposed GitHub <action> (writeId …). AWAITING HUMAN CONFIRMATION — not executed.`
  - Postconditions: One `proposed` record on the session; nothing executed. Alternate/Error: Off-list action, bad merge target, key collision, or `TooManyPending` → the tool returns `Error: <why>` (no throw).
  - Gate-safety: The handler holds no reference to mint/execute/the token — the strongest it can do is append a proposal.

- **UC-ext-write-gate-2 — Human confirms and executes a proposed write**
  - Actor: Session owner (human). Preconditions: A `proposed` record exists; the owner is authenticated; a per-provider MCP transport is configured and connected.
  - Main flow: (1) The UI loads the record + server-recomputed digest. (2) The human reviews the exact target/payload bytes and clicks Confirm, posting the stored digest. (3) The route mints `ApprovedExternalWrite` (allow-list + disjoint-keys + digest match), durably marks the record `executing`, calls the provider tool exactly once via the transport, and patches the outcome (`executed`/`failed` with result text). (4) The UI shows the outcome.
  - Postconditions: The record is terminal; the external system reflects exactly the confirmed content. Alternate/Error: Digest/allow-list mismatch → terminal `failed`, nothing written; not connected → `409`; already resolved → `409 AlreadyResolved`.
  - Gate-safety: This is the only path that executes; the bytes that run are exactly the bytes confirmed (digest re-checked at execute).

- **UC-ext-write-gate-3 — Human confirms an irreversible PR merge**
  - Actor: Session owner (human). Preconditions: A `merge_pull_request` proposal with a numeric `target.pullNumber` exists.
  - Main flow: (1) The card renders an `IRREVERSIBLE` banner naming the PR and base. (2) Confirm stays disabled until the human types the exact PR number echoing the bound `pullNumber`. (3) On match, Confirm enables and proceeds as UC-ext-write-gate-2.
  - Postconditions: The PR is merged exactly once. Alternate/Error: A merge proposal lacking a numeric `pullNumber` is refused at recording time.
  - Gate-safety: The typed-PR-number friction (frontend) plus the numeric-`pullNumber` requirement (backend) plus the digest binding the `merge_method` ensure deliberate, content-exact confirmation.

- **UC-ext-write-gate-4 — Tamper between display and execution is rejected**
  - Actor: Any caller (adversarial path). Preconditions: A minted token exists.
  - Main flow: (1) A proposal whose content differs from the minted token is presented to `executeExternalWrite`. (2) The digest re-check (and allow-list/disjoint-key re-checks) fail.
  - Postconditions: The transport is never called (zero `callTool`); no external write occurs. Gate-safety: Even a re-derived matching digest for an off-list or off-provider action is refused, because the allow-list is re-checked at execute independently of the digest.

- **UC-ext-write-gate-5 — Concurrent confirms / crash mid-execute**
  - Actor: Two concurrent owner requests (or a retry after a crash). Preconditions: One `proposed` record.
  - Main flow: (1) Both reads see `proposed`. (2) The per-`writeId` in-flight Set admits one; the loser gets `409 ConfirmInProgress`. (3) The single durable `proposed→executing` transition gates execution; a retry reading `executing` gets `409 AlreadyResolved`. (4) A crash between call and outcome leaves an honest `executing` record for manual resolution.
  - Postconditions: At most one external write; no silent re-execute. Gate-safety: The in-flight guard + single state transition + durable in-doubt state are the at-most-once mechanism.

---

## Agent-proposed GitHub writes (propose tool + recorder + wiring + prompt guidance)

### Purpose
This feature lets the build agents (Scribe, Proto) **propose** a GitHub write — open/comment-on/close an issue, open/update/merge a PR, or submit a PR review — during a build, recording it as a `status:'proposed'` record that a human must explicitly confirm before the server executes it. The agent is never autonomous over an outward side effect: it can only queue a confirm card, holding zero gate authority and no reference to the executor or its approval token. This realizes the AKIS trust thesis — *the model produces, a human approves, the server executes* — and makes every agent-initiated external write legible and human-gated rather than silent.

### Functional Requirements

- **FR-agent-propose-1** — The system SHALL expose an LLM-callable tool named `propose_github_write` whose handler RECORDS a proposed GitHub write and executes nothing; the handler returns a string on every path and never throws, with handler errors fed back to the model as `Error: <msg>` by the bounded tool loop.
- **FR-agent-propose-2** — The system SHALL advertise the tool's `action` enum sourced from the same frozen `GITHUB_WRITE_ACTIONS` allow-list the gate enforces, so the schema and the authoritative server-side predicate cannot drift; the schema requires `action`, `summary`, `target`, `payload`.
- **FR-agent-propose-3** — The system SHALL validate handler args before recording and return a specific `Error: …` string (not a throw) when `action` or `summary` is not a non-empty string, or when `target`/`payload` is not a plain object (rejecting arrays/null/primitives).
- **FR-agent-propose-4** — The system SHALL hardcode `provider:'github'` inside the recorder so it is never a model or route argument, making it impossible for a caller to record a GitHub proposal under another provider (e.g. `atlassian`).
- **FR-agent-propose-5** — The system SHALL close `sessionId` over the tool at registry-build time so it is never a model argument, so the model can never name another session to record into.
- **FR-agent-propose-6** — The system SHALL refuse a proposal whose `action` is not on the GitHub external-write allow-list via `isAllowedExternalWriteAction('github', action)`, returning `{ error: 'action is not on the GitHub external-write allow-list' }`.
- **FR-agent-propose-7** — The system SHALL refuse a `merge_pull_request` proposal that lacks a positive-integer `target.pullNumber`, returning `{ error: 'merge_pull_request requires a numeric target.pullNumber' }`, so the confirm UI's typed-PR-number friction can never be silently dropped for a malformed merge.
- **FR-agent-propose-8** — The system SHALL refuse a proposal whose `target` and `payload` share any key (disjoint-key pre-check), returning `target/payload keys overlap: <keys>`, so the `{...target,...payload}` execute-merge can never silently override a target key.
- **FR-agent-propose-9** — The system SHALL compute the content digest over the same narrowed `{provider,action,target,payload}` the human confirm binds, so record / propose-route / digest cannot diverge.
- **FR-agent-propose-10** — The system SHALL be idempotent: if a `status:'proposed'` record with the same content digest already exists, it SHALL return the EXISTING `{writeId}` instead of appending a second record (one card per content across a model's loop turns and double-submits), with the dedupe re-evaluated against the freshly-read session on every retry attempt.
- **FR-agent-propose-11** — The system SHALL build a fresh record with `id` (UUID), `status:'proposed'`, `proposedAt` (ISO), and a `summary` truncated to 200 chars, then delegate the capped append to the shared `appendExternalWrite`.
- **FR-agent-propose-12** — The system SHALL enforce a per-session cap of `EXTERNAL_WRITES_MAX = 50` proposals; when full it SHALL evict only the OLDEST record whose status is TERMINAL (`executed` || `failed`), never a still-in-flight `proposed`/`executing` record.
- **FR-agent-propose-13** — The system SHALL refuse with `{ code: 'TooManyPending' }` (surfaced to the model as an `Error:` string, and as HTTP 409 on the propose route) when the row is full and NO record is terminal, so a pending confirm's record / the at-most-once ledger is never silently dropped.
- **FR-agent-propose-14** — The system SHALL persist the appended row via the store's GENERIC version-checked `update` patch (not a gate method), inside a `/version conflict/`-only read-modify-write retry loop bounded at `MAX_RETRY = 5`; on a non-conflict failure or budget exhaustion it SHALL return an error string and never throw.
- **FR-agent-propose-15** — On a successful record the system SHALL return to the model a string stating the action was proposed with its `writeId` and explicitly that it is **AWAITING HUMAN CONFIRMATION — not executed**.
- **FR-agent-propose-16** — The system SHALL register the `propose_github_write` tool ONLY when a GitHub connection is present (`deps.githubMcp`) AND a session `store` is wired AND the `propose_github_write` capability is granted; otherwise the tool is absent.
- **FR-agent-propose-17** — The system SHALL register the propose tool independently of the GitHub read tools actually spawning: a degraded read-tool build (e.g. Docker missing) where zero `github_*` reads register SHALL still surface the propose tool because it is a pure store-append.
- **FR-agent-propose-18** — The system SHALL grant the `propose_github_write` capability in Scribe ONLY when a GitHub connection is present AND a store is wired, and in Proto's read-only gather pass ONLY when a store is wired (Proto's gather is always entered under `githubMcp`).
- **FR-agent-propose-19** — The system SHALL append the `SCRIBE_PROPOSE_HINT` / `PROTO_PROPOSE_HINT` system-prompt guidance ONLY when the propose tool ACTUALLY registered (`hasPropose`), so a build without the tool sends a byte-identical prompt with no propose guidance.
- **FR-agent-propose-20** — The prompt guidance SHALL instruct the agent to PROPOSE only (never execute, never assume it happened, describe writes as "proposed (awaiting your confirmation)"), to require a USER/build-NAMED `{owner, repo}` target before any proposal (no named repo ⇒ do not propose), to make AT MOST ONE low-risk proposal, and to NEVER propose `merge_pull_request` or a close/update unless the user explicitly asked.
- **FR-agent-propose-21** — The system SHALL surface each propose-tool use as an EPHEMERAL `tool_call`/`tool_result` event narrated under the `propose_github_write` display tag (degrading to `chat` for an unexpected name), so the proposal is observable on the live stream without becoming trusted grounding.
- **FR-agent-propose-22** — In Proto's gather pass the system SHALL emit the "gathered from the user's GitHub repo" provenance header ONLY when a real `github_*` READ tool registered; a propose-only (no-read) build SHALL inject NO fabricated "gathered" context even though it may still have recorded a proposal.
- **FR-agent-propose-23** — The system SHALL share the SAME `recordGithubProposal` between the agent tool and the `POST /sessions/:id/external-writes` route (`provider:'github'` branch), so route and tool produce a byte-identical record, one digest, and the same idempotent dedupe.
- **FR-agent-propose-24** — The system SHALL guarantee there is NO code path from a recorded proposal to execution: the recorder, appender, and propose tool import only the record/append/allow-list surface and hold NO reference to `mintApprovedExternalWrite`, `executeExternalWrite`, or the `ApprovedExternalWrite` token; an external write executes ONLY through the human-hit confirm route that mints the digest-bound token.

### Non-Functional Requirements

**Security / Gate-safety**
- **NFR-agent-propose-1** — `propose_github_write` SHALL NOT be a gate capability: it is absent from `GATE_TOOLS`, so granting it to any role cannot break a build gate; the tool is wired only through `buildAdvisoryTools`, whose invariant admits only read-only / non-gate tools.
- **NFR-agent-propose-2** — Reachability SHALL be provable by static import-graph: the propose surface's module-level comments pin that it imports ONLY `recordGithubProposal` (never mint/execute/token), and this property must hold for the invariant "agent proposes → human confirms → server executes, never autonomous" to be enforced by construction, not convention.
- **NFR-agent-propose-3** — All recording SHALL be fail-closed: an off-list action, a key collision, a numeric-pullNumber-less merge, an unknown provider, or a full pending row each refuses the record rather than recording a weaker/ambiguous one.

**Reliability / Concurrency**
- **NFR-agent-propose-4** — The append SHALL be optimistic-lock resilient: concurrent chat turns / double-proposes bumping the session version mid-record SHALL be absorbed by re-read + retry (≤5), and a full-but-all-pending row SHALL refuse deterministically with `TooManyPending` rather than silently evict an in-flight record.
- **NFR-agent-propose-5** — The propose tool and its recorder/appender SHALL NEVER throw — every failure returns a typed error result that the tool loop converts to an `Error:` string — so a propose failure can never crash a build or be swallowed.
- **NFR-agent-propose-6** — The GitHub wiring SHALL be fail-closed and crash-proof: any MCP/pool failure discards the GitHub tools and degrades to the RAG-only (or no-tools) registry, never weakening or crashing the producer path; the propose tool, holding no pool ref, returns a no-op `release`.

**Privacy / Secrets**
- **NFR-agent-propose-7** — A recorded `ExternalWriteRecord` SHALL carry NO token or secret (only id/provider/summary/action/target/payload/status/timestamps), and the propose path SHALL never persist the connection token.

**Honesty / Trust-legibility**
- **NFR-agent-propose-8** — Tool absence SHALL be honest: a build with no GitHub connection never even names the `propose_github_write` capability nor adds its prompt hint, so the agent is never told it can propose when it cannot.
- **NFR-agent-propose-9** — The model-facing return string and the prompt guidance SHALL force honest framing — proposals are "awaiting confirmation", never assumed executed — so the agent cannot claim an external effect that did not occur.

**Maintainability / Strict-TS**
- **NFR-agent-propose-10** — The action enum, allow-list predicate, digest, and disjoint-key check SHALL be sourced from the single `externalWriteGate` module shared by propose-route, agent-tool, mint, and execute, so the schema/check cannot drift; `provider` is typed `Record<ExternalWriteProvider, …>` so adding a provider is a compile error until its allow-list is supplied.

**Internationalization (TR+EN parity)**
- **NFR-agent-propose-11** — The recorder SHALL be content-agnostic (it stores arbitrary summary/title/body text and digests it deterministically with deep key-sorting), so Turkish and English proposal content are recorded, deduped, and confirm-bound identically.

**Self-hostability**
- **NFR-agent-propose-12** — The feature SHALL depend only on the per-owner GitHub MCP connection and the session store, with the read-MCP child optional (proposals still record when it is absent), so a self-hosted deployment without the GitHub Docker child still supports proposing.

### Use Cases

- **UC-agent-propose-1 — Scribe proposes a tracking issue for an approved spec**
  - Actor: Scribe agent (acting on the user's idea); human confirms. Preconditions: The session owner has a connected GitHub repo (`githubMcp`), a `store` is wired, RAG/github caps resolved, and the user/build named an `owner/repo`.
  - Main flow: (1) Scribe's loop runs with `propose_github_write` registered and `SCRIBE_PROPOSE_HINT` in the prompt. (2) Scribe calls the tool with `action:'issue_write'`, `payload:{method:'create',title,body}`, `target:{owner,repo}`. (3) The recorder validates the allow-list + disjoint keys, digests the content, and appends one `status:'proposed'` record. (4) The tool returns `Proposed GitHub issue_write (writeId …). AWAITING HUMAN CONFIRMATION`. (5) A confirm card surfaces for the human.
  - Postconditions: Exactly one `proposed` record; nothing executed; an ephemeral `tool_call`/`tool_result` narrates the step. Gate-safety: The propose path holds no token; the issue is created only if the human later confirms through the gate.

- **UC-agent-propose-2 — Proto proposes an honest result comment after a build**
  - Actor: Proto agent's read-only gather pass; human confirms. Preconditions: `githubMcp` present, `store` wired, a named `owner/repo` (+ issue_number/pullNumber).
  - Main flow: (1) Proto's gather loop registers the propose tool and adds `PROTO_PROPOSE_HINT`. (2) After the build settles, Proto proposes `action:'add_issue_comment'` with a payload that honestly states "verified" + real-test count or "demo/simulated". (3) The recorder appends one `proposed` record. (4) The tool returns the awaiting-confirmation string.
  - Postconditions: A confirm card; no autonomous comment; if no `github_*` read ran, no fabricated "gathered" provenance header is injected. Alternate/Error: If the build named no target repo, Proto (per hint) makes no proposal.

- **UC-agent-propose-3 — Idempotent re-proposal across loop turns / double-submit**
  - Actor: An agent (or a double-clicking route caller). Preconditions: A `proposed` record with content digest D already exists.
  - Main flow: (1) The same content is proposed again. (2) The recorder computes digest D; the appender's dedupe (re-checked against the freshly-read row) finds the existing record. (3) It returns the EXISTING `writeId` — no second append.
  - Postconditions: Still exactly one card for that content. Gate-safety: Prevents card spam and a duplicate write at confirm time.

- **UC-agent-propose-4 — Refused merge proposal lacking a numeric pullNumber**
  - Actor: An agent. Main flow: (1) Agent calls `action:'merge_pull_request'` without a positive-integer `target.pullNumber`. (2) The recorder refuses with `merge_pull_request requires a numeric target.pullNumber`. (3) The tool returns `Error: …`; no record appended.
  - Postconditions: No proposal recorded. Gate-safety: Guarantees the confirm UI's typed-PR-number friction can never be skipped for an irreversible merge.

- **UC-agent-propose-5 — Off-list or key-colliding action refused**
  - Actor: An agent. Main flow: (1) Agent proposes an action not in `GITHUB_WRITE_ACTIONS`, or a `target`/`payload` sharing a key. (2) The recorder returns `action is not on the GitHub external-write allow-list` or `target/payload keys overlap: <keys>`. (3) The tool returns `Error: …`; nothing recorded.
  - Gate-safety: A name the gate would reject at mint never becomes a proposal; an ambiguous execute-merge is refused at propose time.

- **UC-agent-propose-6 — Too many pending proposals (no terminal slot)**
  - Actor: An agent or the propose route. Preconditions: All 50 records are non-terminal (`proposed`/`executing`).
  - Main flow: (1) A 51st propose arrives. (2) The appender finds no terminal record to evict and refuses with `TooManyPending`. (3) The agent receives `Error: too many pending external-write proposals — resolve or confirm some first`; the route returns HTTP 409.
  - Postconditions: No in-flight record evicted; no proposal recorded. Gate-safety: Preserves the at-most-once ledger and every pending confirm's record.

- **UC-agent-propose-7 — Honest absence: no GitHub connection**
  - Actor: An agent building without a connected repo. Preconditions: No `githubMcp` (and/or no `store`).
  - Main flow: (1) The cap `propose_github_write` is never added; the tool is not registered; no propose hint is added. (2) The agent's prompt and tool set are byte-identical to a non-GitHub build.
  - Postconditions: The agent is never told it can propose and cannot record a proposal. Gate-safety: Honest absence — capability claims never exceed what is wired.

---

## Agent-write confirm-cards UI

### Purpose
The Agent-write confirm-cards UI (`frontend/src/components/AgentWriteProposals.tsx`) surfaces every GitHub write a build agent recorded via `propose_github_write` as a `status:'proposed'` proposal, rendering each as a human-readable confirm card so a person — never the model — authorizes the outward side effect. It renders the exact structured `target`/`payload` the server-computed digest binds (shown == bound == executes) and confirms by posting that stored digest verbatim, minting nothing client-side; this is the front-of-house of AKIS's trust thesis that the system is strictly on the propose side and holds no gate authority. Risk-keyed friction (typed-merge echo, destructive banners) makes the consequence legible without ever being the security primitive — the digest and the backend allow-list are.

### Functional Requirements

- **FR-confirm-cards-1** — The system SHALL poll `api.listExternalWrites(sessionId)` on first mount and every `pollMs` interval (default 4000 ms), so an agent-emitted proposal surfaces live during a build; on a rejected/throwing poll it SHALL degrade to an empty list and never crash the build view (`Promise.resolve().then(...).catch(() => {})`).
- **FR-confirm-cards-2** — The system SHALL render a confirm card only for writes where `provider === 'github'` AND `status === 'proposed'` AND the id is not in the local `dismissed` set; non-GitHub, executed/executing/failed, or dismissed records SHALL NOT produce a card.
- **FR-confirm-cards-3** — When no card is open (`proposed` ∪ `pinned` is empty), the component SHALL render `null` (no empty container).
- **FR-confirm-cards-4** — For each card the system SHALL classify a human-facing action via `classifyGithubAction(action, payload)`, reading both the tool name and payload discriminators (`method`, `state`, `event`, `reviewers`), defaulting to the generic `'write'` for any unmapped action, and SHALL display the corresponding `aw.act.*` chip plus a fixed `aw.badge.github` badge.
- **FR-confirm-cards-5** — For review actions (`reviewApprove`/`reviewRequestChanges`/`reviewComment`) when `payload.event` is present, the system SHALL render a colored event pill: APPROVE → emerald, REQUEST_CHANGES → rose, otherwise slate.
- **FR-confirm-cards-6** — The system SHALL render a structured `<dl>` of only the `target`/`payload` fields actually present, never a raw JSON dump, covering repo (`owner/repo`), issue/PR number, method, state, state_reason, event, head, base, merge_method, labels, reviewers, title (≤120 char preview), and body (≤240 char preview). A field absent from the payload SHALL NOT appear.
- **FR-confirm-cards-7** — The system SHALL append a generic catch-all row for EVERY remaining present `payload` key not in `KNOWN_PAYLOAD_KEYS` and every remaining `target` key not in `KNOWN_TARGET_KEYS`, labelling well-known keys (`commit_title`, `commit_message`, `draft`, `expectedHeadSha`) and falling back to `aw.f.other` ("Other ({k})") carrying the raw key name — so no digest-bound field is ever hidden (UI faithfulness), and no key is shown twice.
- **FR-confirm-cards-8** — For catch-all values the system SHALL stringify strings/numbers/booleans as-is and JSON-serialize objects/arrays (truncated at 240 chars), never emitting `[object Object]`, and SHALL skip `undefined`/`null`/empty values.
- **FR-confirm-cards-9** — The system SHALL read a #issue/#PR number whether the producer sent it as a number or a numeric string (`numLike`), taking the PR number from `target.pullNumber` and the issue number from `target.issue_number`.
- **FR-confirm-cards-10** — The system SHALL classify destructiveness via `classifyGithubRisk(action, payload)`: `merge_pull_request` → `irreversible`; a `closed` state on `issue_write`/`update_pull_request`, or an `APPROVE`/`resolve_thread` review → `destructive`; everything else → `reversible`.
- **FR-confirm-cards-11** — For an `irreversible` (merge) write the system SHALL show an amber `role="alert"` banner, using `aw.banner.merge` with the PR number and resolved base (`payload.base` → `target.base` → `"main"`) when a PR number is present, otherwise `aw.banner.mergeNoBase`.
- **FR-confirm-cards-12** — For a `destructive` close-issue, close-PR, or APPROVE the system SHALL show the corresponding destructive `role="alert"` banner (rose for close, amber for approve) interpolating the issue/PR number, or `?` when the number is absent.
- **FR-confirm-cards-13** — For an `irreversible` merge WITH a known PR number the system SHALL require the user to type the exact PR number (`needsTypedConfirm`), disabling Confirm until `typed.trim() === String(pr)`; when no PR number is present it SHALL keep the strong banner but NOT block confirm.
- **FR-confirm-cards-14** — The system SHALL provide a default-collapsed "Show/Hide exact bytes" toggle that, when open, renders the verbatim `JSON.stringify({ target, payload }, null, 2)` the digest binds plus the first 16 chars of the digest, so a human can audit the exact bound content.
- **FR-confirm-cards-15** — On Confirm the system SHALL call ONLY `api.confirmExternalWrite(sessionId, w.id, w.digest)`, posting the record's own server-bound digest verbatim and minting no digest or token client-side.
- **FR-confirm-cards-16** — While a confirm is in flight the system SHALL set `busy`, disable both Confirm and Dismiss, and label the Confirm button `aw.confirming`; on completion it SHALL show a `role="status"` outcome panel (`aw.done.ok` teal / `aw.done.failed` rose) with the server result truncated to 200 chars.
- **FR-confirm-cards-17** — On a confirm error the system SHALL render the message via `ErrorNote` (`ApiError.message` for typed API errors, else `String(e)`) and leave the card in its pre-confirm state so the user can retry.
- **FR-confirm-cards-18** — On a successful confirm the system SHALL pin the resolved card from a local cache (`resolved` map keyed by id with the original write object) for `RESOLVED_GRACE_MS` (8000 ms) so its outcome panel survives the poll tick that flips the server status off `'proposed'`, after which it SHALL auto-drop.
- **FR-confirm-cards-19** — Dismiss SHALL be a front-end-only hide that adds the id to `dismissed` and unpins any grace-cached copy; it SHALL NOT call the server, so the proposal remains on the server until confirmed.
- **FR-confirm-cards-20** — The system SHALL clear every outstanding grace-timer on dismiss and on unmount, never calling setState after unmount.
- **FR-confirm-cards-21** — A pinned (grace-cached) card SHALL be re-added to the open list only while the live poll no longer returns it as `proposed` and it has not been dismissed, preventing a duplicate card alongside the live one.
- **FR-confirm-cards-22** — The backend LIST route (`GET /sessions/:id/external-writes`) SHALL return, for each owner-scoped record, `target`, `payload`, and a freshly recomputed `digest` over `{provider, action, target, payload}` (the same narrowing the mint binds), and SHALL carry no token.

### Non-Functional Requirements

- **NFR-confirm-cards-1 (Security/Gate-safety)** — The front end SHALL hold no gate authority: confirm only re-posts the server's own stored digest, and all authorization (digest match + provider-scoped action allow-list + the single `proposed→executing` at-most-once transition) is enforced server-side. The card's classifier, banners, and typed-merge friction are advisory UX only and MUST NOT be relied on as a security control.
- **NFR-confirm-cards-2 (Security/Honesty — shown==bound)** — Every field rendered (structured rows + catch-all) SHALL be drawn solely from the digest-bound `target`/`payload`; the UI MUST NOT show a field the digest does not bind, nor hide a present field, and the exact-bytes drawer SHALL show the verbatim serialization the digest covers.
- **NFR-confirm-cards-3 (Privacy/secrets)** — Neither the LIST payload, the card, the outcome panel, nor the exact-bytes drawer SHALL surface any token or credential; the digest is shown truncated (16 chars) and is a SHA-256 over content only.
- **NFR-confirm-cards-4 (Reliability/concurrency)** — A failing or throwing poll SHALL degrade to empty without crashing; grace-timer cleanup SHALL prevent setState-after-unmount; the pin/poll reconciliation SHALL never double-render a card. The server SHALL enforce at-most-once execution so a double-click or retry cannot execute twice.
- **NFR-confirm-cards-5 (Performance)** — Rendering SHALL truncate previews (title 120, body/catch-all 240 chars) and cap the exact-bytes `<pre>` height with overflow-auto so a large payload does not blow up the card; the poll interval default (4000 ms) SHALL be configurable via `pollMs`.
- **NFR-confirm-cards-6 (Usability/Accessibility)** — Friction banners SHALL use `role="alert"`, the outcome panel `role="status"`; the typed-merge `Input` SHALL have an `aria-label` and `inputMode="numeric"`; destructive/irreversible actions SHALL be visually distinguished by color and an explicit consequence sentence; Confirm SHALL stay disabled until friction is satisfied.
- **NFR-confirm-cards-7 (Internationalization — TR+EN parity)** — Every user-visible string SHALL come from the `aw.*` catalog with full Turkish and English entries; placeholder interpolation (`{n}`, `{base}`, `{k}`) SHALL be done via `fill` against the localized template so both locales render correctly.
- **NFR-confirm-cards-8 (Maintainability/Strict-TS)** — `classifyGithubAction`, `classifyGithubRisk`, and the typed `WriteRisk`/`ActionKind`/`FieldRow` shapes SHALL be pure and exported for isolated unit testing; value reads SHALL go through typed guards (`str`/`num`/`numLike`/`showValue`) rather than unchecked casts.
- **NFR-confirm-cards-9 (Honesty/Trust-legibility)** — Card copy SHALL state plainly that AKIS proposes and the human confirms ("Nothing happens until you confirm — you confirm the exact bytes shown", `aw.sub`), and consequence banners SHALL name the concrete effect (merge into base, close notifies people, APPROVE can unblock a merge) rather than a generic warning.
- **NFR-confirm-cards-10 (Self-hostability)** — The component SHALL depend only on the injected `ApiClient` and session id with no external service assumption; when remote-MCP is unconfigured/not-connected the confirm path SHALL surface the server's `McpUnavailable`/`NotConnected` error through the standard error note rather than failing opaquely.

### Use Cases

- **UC-confirm-cards-1 — Confirm a reversible GitHub write (open issue/PR, comment, edit, request review)**
  - Actor: Human operator (session owner). Preconditions: A build agent recorded a `status:'proposed'` GitHub write; the LIST poll has returned it.
  - Main flow: (1) The card renders with the GitHub badge, action chip, summary, and the structured `target`/`payload` rows (only present fields). (2) The operator optionally opens "Show exact bytes" to audit the digest-bound JSON and digest prefix. (3) The operator clicks Confirm; the system posts `confirmExternalWrite(sessionId, id, digest)`. (4) The server validates the digest + allow-list, executes once, and returns `{ok, status, result}`. (5) The card swaps to the `role="status"` outcome panel and is pinned for the 8 s grace period.
  - Postconditions: The write is executed server-side; the outcome is visible; the card auto-drops after grace. Gate-safety: No client-side minting; the FE only re-posts the server's stored digest.

- **UC-confirm-cards-2 — Confirm an irreversible merge with typed-PR friction**
  - Actor: Human operator. Preconditions: A proposed `merge_pull_request` write with a known `target.pullNumber`.
  - Main flow: (1) The card shows the amber `aw.banner.merge` naming PR #n and the base branch, and renders the typed-confirm input. (2) Confirm stays disabled until the operator types the exact PR number. (3) On match, the operator clicks Confirm; the digest is posted and the merge executes server-side.
  - Postconditions: PR merged; outcome panel shown. Alternate: If no PR number is present, the strong banner shows but Confirm is NOT blocked (`aw.banner.mergeNoBase`).
  - Gate-safety: Typing the PR number is legibility friction only; the digest already binds the exact `merge_method`/PR — the gate is the security primitive.

- **UC-confirm-cards-3 — Confirm a destructive close / APPROVE behind a warning banner**
  - Actor: Human operator. Preconditions: A proposed close-issue, close-PR, or APPROVE review write.
  - Main flow: (1) The card shows the rose (close) or amber (approve) `role="alert"` banner naming the concrete consequence and the #number. (2) The operator reads the consequence and clicks Confirm; the digest is posted and the action executes.
  - Postconditions: Issue/PR closed or review submitted; outcome shown. Gate-safety: The banner is advisory; the bound digest/state and the server allow-list authorize the action.

- **UC-confirm-cards-4 — Dismiss a proposal without executing**
  - Actor: Human operator. Preconditions: A proposed write the operator does not want to act on now.
  - Main flow: (1) The operator clicks Dismiss. (2) The system adds the id to the local `dismissed` set and unpins any grace copy; no server call is made. (3) The card disappears from this client's view.
  - Postconditions: The proposal remains `proposed` on the server (can be confirmed later or in another client); nothing was executed. Gate-safety: Dismiss is FE-only; it never resolves or executes the proposal.

- **UC-confirm-cards-5 — Audit an unmapped/extra digest-bound field**
  - Actor: Human operator. Preconditions: A proposed write whose payload/target contains keys beyond the per-action set (e.g. `commit_title`, `expectedHeadSha`, or an arbitrary key).
  - Main flow: (1) The card renders well-known extra keys with readable labels and any unmapped key as `aw.f.other` ("Other ({k})") carrying the raw key name and stringified value. (2) The operator can cross-check against the exact-bytes drawer.
  - Postconditions: The operator has seen every field the digest binds before confirming (shown == bound == executes). Gate-safety: UI faithfulness — the human can never confirm a field they were not shown.

- **UC-confirm-cards-6 — Live proposal surfacing during a build / poll failure**
  - Actor: Build agent (proposer) + human operator. Preconditions: A build is running; the agent emits `propose_github_write`.
  - Main flow: (1) The 4 s poll picks up the new `proposed` record and a card appears live without page reload. (2) The operator confirms or dismisses per the flows above.
  - Postconditions: The proposal is acted on as soon as it is recorded. Error flow: If the LIST call rejects/throws, the surface degrades to empty (no card, no crash) and recovers on the next successful poll.
  - Gate-safety: Surfacing is read-only; execution still requires an explicit human confirm posting the server-bound digest.

---

## Reliability + correctness hardening (adversarial bug-hunt batch)

### Purpose
This feature is a batch of correctness and reliability fixes (PR #152), found and verified by an 8-agent adversarial bug-hunt, that close real holes in AKIS's external-write proposal path and its trust-legibility surfaces. The backend gains a single shared, status-aware, version-resilient appender for the capped `externalWrites` row — closing a MED→HIGH at-most-once double-execute hole and an Atlassian-propose 500/lost-proposal bug — while the ProtoAgent and the confirm UI are tightened so the human only ever sees what is true and what is actually bound by the digest. The user value is the AKIS trust thesis itself: a proposed external write must be recorded exactly once, never silently dropped while in-flight, never double-executed, and the human's confirm card must show every field that will execute and never fabricate provenance it cannot prove.

### Functional Requirements

- **FR-reliability-1** — The system SHALL append every new `ExternalWriteRecord` onto a session's `externalWrites` row through ONE shared seam, `appendExternalWrite(store, sessionId, record, opts?)`, used by BOTH the Atlassian propose route and the GitHub recorder (`recordGithubProposal`), so the two propose paths grow the capped row with identical status-aware, version-resilient semantics.
- **FR-reliability-2** — The shared appender SHALL NOT execute, mint, or authorize any outward write: it only appends a caller-built record (of any status) and persists it via the store's generic version-checked `update` patch; there SHALL be no code path from this helper to an external write.
- **FR-reliability-3** — When `externalWrites.length < EXTERNAL_WRITES_MAX` (50), the system SHALL append the new record without evicting anything and return `{ ok: true, id }`.
- **FR-reliability-4** — When `externalWrites.length >= EXTERNAL_WRITES_MAX`, the system SHALL make room by evicting the OLDEST record whose status is TERMINAL (`'executed'` or `'failed'`) — found via `writes.findIndex(w => isTerminal(w.status))` — and SHALL NEVER evict a non-terminal (`'proposed'`/`'executing'`) record.
- **FR-reliability-5** — When the row is full and NO record is terminal (every slot is `'proposed'` or `'executing'`), the system SHALL refuse the append, leaving the row untouched, and return `{ error, code: 'TooManyPending' }` rather than silently dropping an in-flight record.
- **FR-reliability-6** — The status-aware cap SHALL preserve the at-most-once ledger: because a still-in-flight `'executing'`/`'executed'` record is never evicted, a re-proposed identical write can never lose the record that would otherwise prevent a SECOND execution (closing the MED→HIGH double-execute hole).
- **FR-reliability-7** — The append SHALL run inside a read-modify-write retry loop (`MAX_RETRY = 5`) that re-reads the session on each attempt and retries ONLY when the store's `update` throws an error whose message matches `/version conflict/`; any other failure SHALL be returned as `{ error }` and the helper SHALL NEVER throw.
- **FR-reliability-8** — On a version conflict during an Atlassian propose, the route SHALL retry-and-land the proposal (HTTP 200, record persisted) instead of returning a Fastify 500 and losing the proposal; the previous bare `[...].slice(-EXTERNAL_WRITES_MAX)` + bare `store.update` path is replaced by the shared appender.
- **FR-reliability-9** — When the appender is given a `dedupe` predicate (the GitHub recorder's content-digest idempotency check), the system SHALL re-evaluate it against the FRESHLY-read `externalWrites` on EVERY retry attempt, and if a record matches, SHALL reuse that record (return its id, no append) so one card exists per content across model loop turns / double-submits / concurrent identical proposes.
- **FR-reliability-10** — When the session does not exist, the appender SHALL return `{ error }` containing the session id (e.g. `session <id> not found`), never throw.
- **FR-reliability-11** — The Atlassian propose route SHALL map a `TooManyPending` result to HTTP 409 `{ code: 'TooManyPending' }` and any other appender error to a server error, achieving parity with the GitHub branch.
- **FR-reliability-12** — The GitHub propose route SHALL map a `recordGithubProposal` result carrying `code: 'TooManyPending'` to HTTP 409 `{ code: 'TooManyPending' }` (a state conflict), and any other error to HTTP 400 `{ code: 'BadAction' }`.
- **FR-reliability-13** — `recordGithubProposal` SHALL delegate its capped append and version-conflict retry entirely to the shared appender (passing the digest idempotency check as `dedupe`), returning `{ writeId, digest }` on success and propagating the appender's `TooManyPending` code on refusal; it SHALL no longer keep its own retry loop or status-blind slice.
- **FR-reliability-14** — `recordGithubProposal` SHALL continue to hardcode `provider: 'github'` (never a parameter), so neither the route nor the model can record a proposal under a different provider through this recorder.
- **FR-reliability-15** — In ProtoAgent's GitHub-context gather pass, the system SHALL proceed to the gather loop when EITHER a `github_*` read tool OR the `propose_github_write` tool registered, and SHALL short-circuit (return `''`, fail-closed) when NEITHER registered.
- **FR-reliability-16** — The gather system prompt SHALL include the "Use the github_* tools to read…" instruction ONLY when at least one `github_*` read tool actually registered (`hasReadTools`); in a degraded propose-only build it SHALL be dropped so the model is never told to use read tools that do not exist.
- **FR-reliability-17** — ProtoAgent SHALL wrap the gather model's free-text output in the "CONNECTED-REPO CONTEXT … gathered from the user's GitHub repo" header ONLY when a real `github_*` read tool registered AND the summary is non-empty; otherwise it SHALL return `''`, so no model free-text is ever falsely labeled as repo-gathered context when nothing was read.
- **FR-reliability-18** — A GitHub failure during gather SHALL never block or degrade code production: the gather is wrapped so any thrown error yields `''` (fail-closed) and a degraded build can still record any proposal the propose tool made.
- **FR-reliability-19** — The agent-write confirm card (`AgentWriteProposals.structuredFields`) SHALL render EVERY present, digest-bound payload key in the structured "what executes" view: per-action rows for known keys, a readable label for `commit_title`/`commit_message`/`draft`/`expectedHeadSha`, and a generic `aw.f.other` = "Other ({k})" carrying the raw key name for any unmapped key — so no digest-bound field is hidden behind the default-collapsed exact-bytes drawer.
- **FR-reliability-20** — The catch-all SHALL skip keys already rendered by per-action rows (`KNOWN_PAYLOAD_KEYS`, `KNOWN_TARGET_KEYS`) so no field is shown twice, and SHALL stringify object/array values via `JSON.stringify` (truncated to 240 chars) rather than render `[object Object]`, returning `undefined` for null/undefined/empty values which are then not rendered.
- **FR-reliability-21** — A catch-all row whose label is `aw.f.other` SHALL interpolate the raw key name at render time via `fill(t('aw.f.other'), { k })`, and its React `key` SHALL include `f.labelArg` so distinct catch-all fields do not collide.
- **FR-reliability-22** — After a successful confirm, the system SHALL keep that card's outcome panel ("Done: …") pinned for a grace period of `RESOLVED_GRACE_MS = 8000` ms, surviving the poll tick that flips the server record off `'proposed'`, by caching the resolved write object and re-adding it to the rendered set when the live poll no longer returns it.
- **FR-reliability-23** — The grace-period timers SHALL be cleared on Dismiss and on component unmount (no setState-after-unmount), and a user Dismiss SHALL drop a pinned card immediately while leaving the proposal on the server until confirmed.
- **FR-reliability-24** — The dead `dismissedRef` (no longer read inside the polling closure) SHALL be removed; the dismissed set SHALL be consulted directly when computing the open/pinned card set.
- **FR-reliability-25** — `ExternalWriteCard`'s read-only history SHALL filter out GitHub writes with status `'proposed'` (owned by `AgentWriteProposals`'s confirm surface), so a proposed GitHub write never double-renders as both a confirm card and a history line; executed/failed GitHub writes SHALL still appear in history.
- **FR-reliability-26** — Each backend and frontend fix SHALL ship with a regression test that fails against the pre-fix code, including parity coverage asserting the status-aware cap behaves identically on BOTH `MockSessionStore` and `PgSessionStore`.

### Non-Functional Requirements

- **NFR-reliability-1 (Security / Gate-safety)** — The shared appender SHALL hold no mint or execute authority and SHALL NOT move the session status; it persists only via the generic version-checked `update` patch, not a gate method. The build/confirm gates and the existing per-writeId in-flight execution guard (which rejects sequential and concurrent double-confirms via status-guarded patch) SHALL remain untouched (at-most-once preserved).
- **NFR-reliability-2 (Reliability / concurrency)** — Both propose paths SHALL be safe under concurrent version bumps from live chat turns or a second propose: a `/version conflict/` triggers a bounded read-modify-write retry (≤5) rather than a 500 or a lost proposal, and idempotency dedupe is re-evaluated on every retry so concurrency cannot create duplicate cards.
- **NFR-reliability-3 (Reliability / data integrity)** — A non-terminal (`'proposed'`/`'executing'`) external-write record SHALL never be silently lost: capacity pressure either evicts a terminal record or refuses with `TooManyPending`. This invariant SHALL hold identically across the Mock and Pg stores (parity-tested).
- **NFR-reliability-4 (Honesty / Trust-legibility)** — The confirm card SHALL satisfy "what is shown == what is bound by the digest == what executes": no digest-bound field may be invisible to the human, and the outcome of a confirmed write SHALL remain visible long enough to be read. ProtoAgent SHALL never attribute context to a "GitHub repo read" that did not occur.
- **NFR-reliability-5 (Internationalization / TR+EN parity)** — All new confirm-card labels (`aw.f.commitTitle`, `aw.f.commitMessage`, `aw.f.draft`, `aw.f.expectedHeadSha`, `aw.f.other` with `{k}` interpolation) SHALL be present in BOTH the English and Turkish catalogs with equivalent meaning.
- **NFR-reliability-6 (Maintainability / Strict-TS)** — The fixes SHALL preserve a single source of truth for the capped append (one shared helper replacing two divergent inline implementations), compile under strict TypeScript with no `any`-leakage in the typed result unions (`AppendExternalWriteResult`, the `code?: 'TooManyPending'` extension), and keep the full suite green (BE 1532 + FE 472 + tsc + build).
- **NFR-reliability-7 (Usability / Accessibility)** — The structured field view SHALL truncate long previews (240/120 chars) for readability while the exact-bytes drawer remains the source of the whole value, and the post-confirm grace SHALL be user-overridable (Dismiss clears it sooner).
- **NFR-reliability-8 (Self-hostability)** — A degraded GitHub-MCP environment (the github-MCP Docker child failing to start → zero `github_*` read tools) SHALL NOT crash, block, or fabricate context; code production proceeds and proposals can still be recorded, so the feature degrades gracefully on a self-hosted box where the MCP child is unavailable.

### Use Cases

- **UC-reliability-1 — A 51st proposal evicts only a terminal record, preserving an in-flight one**
  - Actor: AKIS backend (Atlassian/GitHub propose route on behalf of an authenticated owner). Preconditions: A session's `externalWrites` row is at 50; the oldest in-flight record is `'proposed'`/`'executing'`; at least one record is terminal.
  - Main flow: (1) The route builds a new proposal record. (2) It calls `appendExternalWrite`. (3) The appender finds the oldest TERMINAL record and removes it. (4) It appends the new record and persists with the read version. (5) The route replies 200 with the new record's id/digest.
  - Postconditions: The in-flight record survives; a later confirm of it still finds it and executes exactly once; the row is still capped at 50. Gate-safety: No execution occurs in this path; the at-most-once ledger entry for any in-flight write is never dropped.

- **UC-reliability-2 — Propose into a row full of in-flight records is refused (no silent eviction)**
  - Actor: AKIS backend propose route. Preconditions: All 50 records are non-terminal.
  - Main flow: (1) The route calls `appendExternalWrite`. (2) The appender finds no terminal record. (3) It returns `{ error, code: 'TooManyPending' }` without mutating the row. (4) The route replies HTTP 409 `{ code: 'TooManyPending' }`.
  - Postconditions: The row is unchanged; the caller/UI is told to resolve or confirm existing proposals first. Error flow: Identical 409 mapping for both the GitHub and Atlassian branches (parity).

- **UC-reliability-3 — Concurrent version bump during an Atlassian propose is absorbed**
  - Actor: AKIS backend Atlassian propose route, with a concurrent chat turn / second propose writing first. Preconditions: A live writer bumps the session version between the propose's read and its write.
  - Main flow: (1) The appender reads the session, appends, attempts `store.update` with the stale version. (2) The store throws `version conflict`. (3) The appender re-reads, re-applies the cap/dedupe, and retries (≤5). (4) The update succeeds; the route replies 200; the proposal is listed.
  - Postconditions: The proposal lands exactly once; no Fastify 500; no lost proposal. Error flow: After `MAX_RETRY` conflicts, or on any non-conflict error, the appender returns `{ error }` and the route surfaces a clean error (never an unhandled throw).

- **UC-reliability-4 — Degraded propose-only build injects no fabricated repo context**
  - Actor: ProtoAgent during a build where GitHub is connected but the github-MCP read child failed (only `propose_github_write` registered). Preconditions: `hasReadTools` is false; `hasPropose` is true.
  - Main flow: (1) The gather loop runs but the system prompt omits the "use the github_* tools" line. (2) The model returns free text. (3) ProtoAgent returns `''` for `repoContext` (no "gathered from the repo" header) because `hasReadTools` is false. (4) Code production proceeds normally; any proposal the propose tool made is still recorded.
  - Postconditions: The code-production user message contains no `CONNECTED-REPO CONTEXT` header; no false provenance is asserted. Gate-safety / honesty: The honesty header is emitted only when a real read tool registered and could have run; gather never blocks code production (fail-closed on error).

- **UC-reliability-5 — Human reviews and confirms a merge proposal with full field visibility**
  - Actor: The owner reviewing an agent-proposed GitHub write in `AgentWriteProposals`. Preconditions: A `'proposed'` GitHub write exists with payload fields beyond the per-action rows (e.g. `commit_title`, `commit_message`, `draft`, an unmapped `some_future_key`).
  - Main flow: (1) The card renders every present payload/target field in the structured view — known labels for known keys, "Other ({k})" for unknowns, JSON-stringified objects — without expanding the collapsed exact-bytes drawer. (2) For a merge, the user clears the typed-PR-number friction. (3) The user clicks Confirm + execute; the card posts the record's own server-bound digest verbatim. (4) On success the card shows "Done: …".
  - Postconditions: Everything the digest binds was visible before confirming; the outcome panel stays pinned for ~8s across the poll tick that flips the record to executed, then clears (or the user dismisses sooner). Gate-safety: Confirm posts only the record's existing server-bound digest — nothing is minted client-side.

- **UC-reliability-6 — A proposed GitHub write does not double-render in history**
  - Actor: The owner viewing the publish/history surface (`ExternalWriteCard`). Preconditions: A GitHub write with status `'proposed'` and another with status `'executed'` exist on the session.
  - Main flow: (1) `ExternalWriteCard` loads the external-write list. (2) It filters out GitHub `'proposed'` writes (owned by `AgentWriteProposals`). (3) It renders the executed GitHub write in history.
  - Postconditions: The proposed write appears only as a confirm card (one place); the executed write appears only in history — no duplicate rendering.

---

## Cross-cutting Non-Functional Requirements & Invariants

These system-wide guarantees are upheld by every feature in this specification and constitute the AKIS trust thesis applied to authentication, connected integrations, and outward side effects.

- **XC-1 — Gate-safe principle (agent proposes · human confirms · server executes — never autonomous).** No agent, model, or background path may perform an outward external write. A write touches a third-party system only through exactly one production code path: a human-hit confirm route that mints a digest-bound `ApprovedExternalWrite` token and then executes it through the owner's MCP transport. The propose tool, recorder, and append helper hold no reference to `mintApprovedExternalWrite`, `executeExternalWrite`, or the token type — reachability is provable by static import-graph, enforced by construction rather than convention. (FR-ext-write-gate-19/-24, NFR-ext-write-gate-2, FR-agent-propose-24, NFR-agent-propose-1/-2, NFR-atlassian-jira-1, NFR-github-mcp-3, NFR-confirm-cards-1.)

- **XC-2 — The 4 structural build gates remain untouched.** This session's external-write gate is orthogonal to and never reads, mints, or relaxes the four structural build gates (spec-approval, producer≠verifier, verified-real, push). Recording `lastLoginProvider`, connecting MCP, appending a proposal, and confirming a write all leave the build gates and the per-`writeId` in-flight execution guard intact. (NFR-ext-write-gate-1, NFR-reliability-1, NFR-provider-badge-1.)

- **XC-3 — Owner-scoping.** Every connection, token store, proposal record, transport resolution, and external-write execution is scoped to the authenticated owner. MCP auth material is keyed per `(userId, provider)`; `mcpTransportFor` and the confirm route resolve the transport from the owner's own per-provider store; identity in OAuth/connect callbacks is bound by an HMAC-signed `state` (authoritative even under `SameSite=Strict`). No AKIS-hosted credentials or central broker mediate a user's writes. (NFR-github-mcp-1/-7, NFR-atlassian-jira-2, FR-atlassian-jira-24, NFR-ext-write-gate-5/-14, NFR-account-menu-2.)

- **XC-4 — Secrets are never logged or returned.** Access tokens, refresh tokens, OAuth `client_secret`, DCR client info, and PKCE verifiers exist only in-process or inside one AES-256-GCM encrypted blob (AAD-bound, file mode `0600`); they are never placed in a URL, log line, response body, error surface, proposal record, digest, or list response. Connect/callback outcomes are conveyed only as opaque `?mcp=…` / `?error=…` tokens; `/status` returns at most `connected`+`scopes`; the wire user projection (`toPublic`) never includes the password hash. (NFR-oauth-signin-6/-7, NFR-github-mcp-4/-5/-6, NFR-atlassian-jira-3, NFR-ext-write-gate-5, NFR-agent-propose-7, NFR-confirm-cards-3, NFR-account-menu-3, NFR-provider-badge-4.)

- **XC-5 — Honest absence (no capability surfaced when not connected).** The UI advertises only what the server can actually serve and what is actually granted: OAuth buttons appear only for providers whose creds are both set; the Confluence action appears only when the *live granted* scope contains `write:confluence-content`; not-connected states guide the user to Settings instead of reaching a confirm-time 409; `mcpTransportFor` returns `undefined` (no MCP tools) when not connected; and the `propose_github_write` tool, capability, and prompt hint are absent entirely on a build with no GitHub connection. The model is never told it can do something it cannot. (NFR-oauth-signin-16, FR-oauth-signin-2, NFR-atlassian-jira-9, FR-atlassian-jira-16/-18/-19, NFR-github-mcp-15/-16, FR-agent-propose-16/-17, NFR-agent-propose-8.)

- **XC-6 — Trust-legibility / honest provenance.** What the UI tells the user is provably the truth of what just happened: the "signed in via" badge reflects the *most-recent* login (`lastLoginProvider`), never a stale or merely-bound identity, even across cross-identity same-email logins; the confirm card satisfies "shown == bound == executes" (every digest-bound field is visible, none fabricated); and ProtoAgent never labels free text as "gathered from the GitHub repo" unless a real read tool registered. (NFR-oauth-signin-17, NFR-account-menu-15, NFR-provider-badge-12, NFR-confirm-cards-2/-9, NFR-reliability-4, FR-reliability-17.)

- **XC-7 — TR + EN i18n parity.** Every user-facing string introduced by these features exists in both the English and Turkish catalogs at full parity with no missing key in either locale — OAuth button/error keys, account-menu/provider-badge labels, MCP status strings, the `mcpwrite.*` connect/write strings, and the `aw.*` confirm-card/banner/field strings (placeholders interpolated via `fill` against the localized template). (NFR-oauth-signin-12, NFR-account-menu-11, NFR-provider-badge-9, NFR-github-mcp-12, NFR-atlassian-jira-7, NFR-ext-write-gate-10, NFR-confirm-cards-7, NFR-agent-propose-11, NFR-reliability-5.)

- **XC-8 — Strict-TS.** All code compiles under strict TypeScript with `exactOptionalPropertyTypes`: optional fields (`avatarUrl`, `lastLoginProvider`, `staticClient`) are conditionally spread so an absent value is never an explicit `undefined`; the action enum advertised to the model derives from the single frozen allow-list (no drift); the provider→set map is a total `Record<ExternalWriteProvider, …>` so a new provider is a compile error until its allow-list is supplied; value reads go through typed guards rather than unchecked casts; and the typed result unions leak no `any`. (NFR-oauth-signin-13, NFR-account-menu-12, NFR-provider-badge-10, NFR-github-mcp-13, NFR-atlassian-jira-8, NFR-ext-write-gate-11, NFR-agent-propose-10, NFR-confirm-cards-8, NFR-reliability-6.)

- **XC-9 — Provider-agnostic + self-hostable.** The system runs identically self-hosted with the operator's own resources and degrades honestly when they are absent. OAuth and MCP are fully optional (password auth still works with no OAuth creds; absent connections degrade to no tools); a production self-host is closed to OAuth-driven account creation by default; Atlassian needs no AKIS-registered OAuth app (DCR) and no PAT; the GitHub static client reuses the operator's existing OAuth App and base-`/` redirect (no extra registration); provider branching is confined to `clientInformation`/`saveClientInformation`/`staticClientFor` so routes stay provider-agnostic; execution runs through the `McpTransport` seam against the self-hoster's own connection; the in-memory and Postgres stores are behavior-identical (parity-tested, idempotent migrations); and a degraded GitHub-MCP Docker child never crashes, blocks, or fabricates. (NFR-oauth-signin-18/-19, NFR-github-mcp-14/-17, NFR-atlassian-jira-10, NFR-ext-write-gate-14, NFR-account-menu-16, NFR-provider-badge-13, NFR-agent-propose-12, NFR-confirm-cards-10, NFR-reliability-8.)

---

## Traceability appendix

| Feature | FR/NFR/UC prefix | Merged commit | PR |
|---------|------------------|---------------|----|
| OAuth sign-in (GitHub + Google) | `oauth-signin` | `73dcfaf` (OAuth login foundation) + dev-origin proxy `2b49b61` | #18 (PR-B/C), PR19 |
| Account menu + provider/avatar | `account-menu` | `73dcfaf` | #18 (PR-B/C) |
| Provider badge reflects the CURRENT login (`lastLoginProvider`) | `provider-badge` | `67e9bc2` | — (auth fix on #18 chain) |
| Atlassian Jira-only MCP connect + Confluence scope-gating | `atlassian-jira` | `67e9bc2` (Jira-only scope + gating); connect routes `3639f91` / state-first `8e69f6e` | PR16 |
| GitHub remote MCP connect (static-client, DCR bypass) | `github-mcp` | `562fd04`; state-first callback `8e69f6e` | PR16 |
| Provider-aware external-write gate + GitHub write-action allow-list | `ext-write-gate` | `9b2b17f` | — |
| Agent-proposed GitHub writes (propose tool + recorder + wiring + prompt guidance) | `agent-propose` | `1a63f09` (tool/recorder/wiring) + `5cdf4da` (prompt guidance) | — |
| Agent-write confirm-cards UI | `confirm-cards` | `f2bc632` | — |
| Reliability + correctness hardening (adversarial bug-hunt batch) | `reliability` | `8fb3d79` | #152 |

Notes: this 2026-06-08 session is the OAuth → connect → propose → confirm → harden chain. Commits `73dcfaf` → `67e9bc2` (auth/badge/Jira-only) → `562fd04` (GitHub MCP) → `9b2b17f` (gate) → `1a63f09` + `5cdf4da` (agent propose + prompt guidance) → `f2bc632` (confirm-cards UI) → `8fb3d79` (PR #152 reliability batch) land sequentially on `main`. PR numbers shown where a commit message or the feature spec named one; the gate, propose-tool, prompt-guidance, and confirm-cards commits were merged as part of the same session series without an externally-numbered PR in the commit subject.