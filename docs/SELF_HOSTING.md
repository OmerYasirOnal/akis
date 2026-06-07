# Self-hosting AKIS

Run your own AKIS the way you run Ollama: one command, one container stack, your
machine. The bundled image serves the built frontend **and** the API on a single
port; an optional Postgres service makes your users, sessions, and workflows
survive restarts.

> [!CAUTION]
> **AKIS runs AI-generated code as ordinary child processes on the host — there
> is NO sandbox.** Previews, real boot-smoke verification (the produced app is
> booted and HTTP-probed), and any tool the model invokes execute with the same
> privileges as the AKIS process, sharing
> your kernel and filesystem. Node's permission model is **not** a security
> boundary; neither is a container (see [`THREAT-MODEL.md`](../THREAT-MODEL.md)).
> Therefore AKIS self-host is **SINGLE-USER**. **Do NOT expose it to untrusted
> users or the public internet** without supplying your own isolation (a VM per
> user, a microVM/Firecracker/gVisor isolate, a locked-down network). The default
> stack publishes the port on `127.0.0.1` (loopback only) for exactly this reason.
>
> If you DO put AKIS behind auth for a small trusted group, also set
> **`AKIS_REQUIRE_AUTH_FOR_BUILDS=1`** so a build can't be started anonymously — every
> session is then owned + private to its owner (otherwise an unauthenticated build is
> public-by-UUID). Leave it unset for the zero-login keyless demo. See `THREAT-MODEL.md`.

---

## Quickstart

Prerequisites: Docker with Compose v2 (`docker compose version`).

```bash
# from the repo root
docker compose up            # add -d to run detached; --build to force a rebuild
```

That builds the bundled image (a frozen `pnpm install` + `pnpm -r build` for the
frontend), starts Postgres, waits for it to be healthy, then starts AKIS. Open:

```
http://localhost:3000
```

With **no provider key**, this is a fully working **keyless mock demo**: the
compose file defaults `AKIS_ALLOW_MOCK=1` (deterministic mock provider + passing
demo verification) so a session runs end-to-end without any API key. It also ships
a working **insecure default `AUTH_JWT_SECRET`** so the production-mode container
boots instead of failing closed on an empty secret — **override it before any real
use** (see [Run a real build](#run-a-real-build-optional) and the env table below).

Stop it with `Ctrl-C` (or `docker compose down` if detached). Your data persists
in named volumes across `down`/`up` — see [Persistence](#persistence) below.

#### Stamp provenance labels on a local build (optional)

A `docker compose up --build` (or a plain `docker build`) leaves the image's
provenance labels **empty** — fine for local use. If you want a live-box drift
check to be a single `docker inspect` (which commit + when + which version), pass
the git sha, a UTC build time and a version as build-args; they're stamped as the
standard OCI annotation keys `org.opencontainers.image.revision`, `.created` and
`.version` (the published GHCR images already carry these — the release pipeline
sets them):

```bash
docker build -t akis:local \
  --build-arg GIT_REVISION="$(git rev-parse HEAD)" \
  --build-arg BUILD_CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg IMAGE_VERSION="$(git describe --tags --always)" .

# then, on the live box — dump ALL provenance labels at once (revision + created + version):
docker inspect -f '{{ json .Config.Labels }}' akis:local
```

> [!NOTE]
> **Image size (design-pending, audit #25).** The runtime currently carries the full pnpm-workspace
> `node_modules`, including the dev/build toolchain (TypeScript, Vite/@rolldown, lightningcss, jsdom,
> Playwright — ~100MB+) that it does not need at runtime. As a prerequisite, `tsx` is now a backend
> **runtime** dependency (it executes the uncompiled server), so a prune can keep it. A plain
> `pnpm prune --prod` after the build was **measured to buy ~0** here — it does not prune the workspace
> importers' devDeps from the `.pnpm` store. The two effective fixes are deferred, each needing its own
> verification pass: **(a)** `pnpm deploy --prod` of the backend into a self-contained dir — must prove
> the `tsx` start command and the source-resolved `@akis/shared` alias survive the deploy bundle; or
> **(b)** a targeted `rm -rf` of the build-toolchain `.pnpm` dirs (the existing `pdf-parse` pattern) —
> must **not** remove `esbuild`, which is a `tsx` runtime dependency (two esbuild versions coexist).
> The runtime's own `pnpm`/Playwright needs are unaffected: real-test verification runs in the
> **generated app's** own dependency tree (`pnpm exec`), not AKIS's.

> [!IMPORTANT]
> The bundled `AUTH_JWT_SECRET` default is **insecure and shared** — it exists only
> so the keyless demo boots zero-config. For anything beyond a throwaway local demo,
> set your own (`AUTH_JWT_SECRET=$(openssl rand -hex 32)` in a `.env`). An empty
> secret in production fails closed by design; the default keeps that guard happy
> while still nudging you to replace it.

### Run the published image (no local build)

Don't want to build from source? Each release publishes a ready-to-run image to
GitHub Container Registry, so you can `docker run` it directly — Ollama-style:

```bash
# keyless mock demo (no provider key, in-memory state) → http://localhost:3000
docker run --rm -p 3000:3000 \
  -e AKIS_ALLOW_MOCK=1 -e AKIS_ALLOW_DEMO_IN_PROD=1 \
  ghcr.io/OmerYasirOnal/akis-platform-mvp:latest
```

Pin a specific version instead of `latest` for a reproducible deploy, e.g.
`ghcr.io/OmerYasirOnal/akis-platform-mvp:v0.1.0`. Every published image has already
passed a keyless `/health` boot-smoke in the release pipeline — a tag that exists is
a tag that boots.

> **Architecture: the published GHCR image is `linux/amd64` only.** The release
> pipeline does not (yet) build multi-arch, so on an **ARM host** (Apple Silicon, an
> Ampere/`arm64` VM) `docker pull` of the published image either fails to run or runs
> under slow emulation. On ARM, build locally instead (`docker compose up --build`, or
> the `build:` block above) — the Dockerfile is arch-agnostic.

> The package is created on the **first** release. New GHCR packages default to
> **private**; flip it to public once (GitHub → the repo's Packages →
> akis-platform-mvp → Package settings → Change visibility) so anyone can
> `docker pull` without authenticating. Until then, `docker login ghcr.io` with a
> PAT that has `read:packages` is required to pull.

Prefer the full stack (with persistent Postgres) but **without** building locally?
Point the compose `app` service at the GHCR image instead of the `build:` block by
adding an override file next to `docker-compose.yml`:

```yaml
# docker-compose.override.yml  (compose auto-merges it)
services:
  app:
    build: !reset null            # drop the local build…
    image: ghcr.io/OmerYasirOnal/akis-platform-mvp:latest   # …and pull instead
```

Then `docker compose up -d` pulls the published image and starts the same
Postgres-backed stack documented below. (Omit `!reset` and just set `image:` if your
Compose version predates the `!reset` tag — Compose then prefers the local build only
when sources change.) The env table, persistence, and security notes all still apply.

### Run a real build (optional)

With **no** provider key, AKIS runs the keyless **mock** demo. To do real builds,
give it a provider key — put it in a `.env` file next to `docker-compose.yml`
(Compose auto-loads it) or export it in your shell:

```bash
# .env  (next to docker-compose.yml)
ANTHROPIC_API_KEY=sk-ant-...
AUTH_JWT_SECRET=$(openssl rand -hex 32)   # replace the insecure default; stable sessions
PUBLIC_BASE_URL=http://localhost:3000     # browser-facing origin (cookies/OAuth)
```

Then `docker compose up` again. Supplying a provider key **automatically takes
over from the mock** — `AKIS_ALLOW_MOCK` is a fallback, not a force, so a
configured key is never masked. (To require a real key and refuse the mock
entirely, also set `AKIS_ALLOW_MOCK=0`.) See the full key list in
[`backend/.env.example`](../backend/.env.example).

#### Live preview — what runs in the iframe

Once a build reaches `done`, AKIS materializes the produced files under
`AKIS_WORKSPACES_DIR` and runs them locally, embedding the running app in the
Studio iframe at `/preview/:id/` (a same-origin reverse proxy; HMR WebSockets are
tunneled). Supported app shapes: **static** (an `index.html`, served from disk),
**Vite** (launched with `--base /preview/:id/`, so assets resolve under the proxy),
and **Node services** (`node .`, must honor `PORT`). A boot that fails or an
unsupported app type surfaces its reason in the panel (with a Retry) — never a
silent blank.

> **Next.js caveat.** A detected Next app is launched with `next dev` and the proxy
> prefix exposed as `NEXT_PUBLIC_BASE_PATH`, but `next dev` does **not** read that
> natively — the generated app's own `next.config` must wire
> `basePath`/`assetPrefix` from it. Without that, the app still boots but serves
> root-absolute assets under the proxy and renders blank. Genuine base-path support
> for Next is a known follow-up.

### Open a real GitHub PR on a verified build (optional)

By default a finished build is published to the **in-memory mock** adapter (no
network). To make `confirmPush` open a **real pull request** instead, set BOTH:

```bash
# .env  (next to docker-compose.yml)
AKIS_GITHUB_PUSH_TOKEN=github_pat_...   # fine-grained PAT: Contents + Pull requests (write)
AKIS_GITHUB_PUSH_REPO=me/my-app         # owner/name of the target repo
```

When both are present (and `NODE_ENV` is not `test`), AKIS creates an
`akis-<sessionId>` branch, commits the verified files, and opens (or updates) a
PR against the repo's default branch via the GitHub REST API — **no Octokit, plain
`fetch` with a Bearer token**. The token is a fine-grained Personal Access Token
scoped to that one repo with **Contents** + **Pull requests** write (a GitHub App
installation token works too); it is **never logged and never returned** in any
response, event, or error.

This is **opt-in and still fully gated** — the PR is opened only after all four
structural gates pass (spec approval → no pre-approval code → real ≥1-test
verification → digest-bound `ApprovedPush`). Leave either var blank and the mock
adapter is used (the default boot is byte-for-byte unchanged). These vars are
**separate** from the RAG reader's `AKIS_GITHUB_TOKEN`/`AKIS_GITHUB_REPO`, so push
and knowledge-ingest can target different repos. Optional: `AKIS_GITHUB_PUSH_BASE`
(base branch; default = repo default) and `AKIS_GITHUB_PUSH_API_BASE` (GH
Enterprise). See [`backend/.env.example`](../backend/.env.example).

---

### Connect Jira / Confluence / GitHub via remote MCP (optional)

Connect **your own** Atlassian or GitHub account so AKIS can read context and **publish
human-confirmed** writes (a Jira issue / Confluence page from a finished build) — from
*Settings → Connected tools*. The flow is **browser OAuth 2.1 + Dynamic Client
Registration**: you authorize in your own account; there is **no OAuth app to register**
and **no token to paste**. Tokens are AES-256-GCM encrypted at rest, per `(user, provider)`,
and never reach the browser.

- **Required:** `AI_KEY_ENCRYPTION_KEY` (the same 32-byte master used by the KeyStore) —
  it also encrypts the MCP connection store. Without it, *Connect* is unavailable
  (fail-closed), not silently plaintext.
- **Optional:** `AKIS_MCP_AUTH_STORE_PATH` (defaults to `~/.config/akis/mcp-auth.json`,
  `0600`).

**What's shipped vs. owner-gated.** The transport, OAuth/DCR, encrypted store, connect
routes, and the external-write **propose → human-confirm → execute** flow (the 5th branded
gate — see `THREAT-MODEL.md`) are all in place: an agent/user only *proposes*; nothing is
written until you confirm the exact digest-bound, allow-listed content on your own session.
**Owner-credential / admin gated:** a live Atlassian connection needs your org admin to
enable the Atlassian Rovo MCP for the site + your browser consent; the write action
**tool-name + payload shapes** are pinned against the server's real `listTools()` only once
that live connection exists. Until then the allow-list is fail-CLOSED — an unrecognized tool
name is refused, never mis-sent. Agent **auto-use of MCP reads** for grounding is not wired
yet; GitHub read-grounding today uses the stdio+Docker path.

---

### Publish to your own server (OCI free-tier) (optional)

After a build reaches **`done`** (it passed the push gate), the owner can deploy that
session's produced files to **their own server** — e.g. an Oracle Cloud free-tier
instance — and get a live URL. This is a **POST-`done`, fully OPTIONAL, NON-GATING**
action: exactly like the GitHub PR push, it can never gate, block, or fake
verification. A failed deploy leaves the build `done` and records an honest
`{ok:false}` report; it never moves the session status.

**Configure it entirely from the UI** — *Settings → Publish destination*:

- **Host** — the instance hostname/IP, reachable over SSH from where AKIS runs.
- **SSH user** — the login user (`ubuntu` on Ubuntu, `opc` on Oracle Linux).
- **SSH private key** — a PEM private key for that user. It is **encrypted at rest**
  (AES-256-GCM under `akis:publish:<uid>`, the same KeyStore pattern as provider keys
  and GitHub connections), used only over SSH via a transient `0600` temp file under a
  `0700` per-run dir, **never shown again, never logged, never returned** (the card
  shows only a SHA-256 fingerprint).
- **Target directory** — an absolute, writable path under the login user's home
  (e.g. `/home/ubuntu/app`). AKIS `mkdir -p`s it and probes writability.
- **App port** — the port the app listens on. **Must be 1025–65535** (a non-root login
  user cannot bind ≤1024).
- **Public URL** (optional) — shown instead of `http://host:port` (e.g. your own domain).

**On the instance (one-time, minimal prep):**

- **Node.js on the login user's `PATH`** — required for BOTH node-service/fullstack apps
  AND the static fallback (the vendored `static-serve.mjs` runs via `node`). AKIS
  preflights `node`/`npm` over SSH and reports an honest failure if absent.
- **Open the inbound port.** The OCI free-tier **VCN security list** *and* the host
  firewall usually **block inbound ports by default** — so `http://host:appPort` can be
  unreachable even on a successful deploy. Add an ingress rule to the VCN security list
  AND open it in the host firewall:
  ```bash
  # Oracle Linux (firewalld)
  sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload
  # OCI Ubuntu (default-DROP iptables)
  sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
  ```
  AKIS **probes the URL after deploy** and records `reachable:false` honestly, so an
  `ok:true` deploy with a blocked port shows a clear "open the port" caution instead of a
  silent blank page.
- **NOT required:** rsync (AKIS falls back to `scp`), nginx, systemd-root, Docker, or any
  AKIS-specific agent. The only software AKIS needs on the box is the SSH daemon + node.

**SSRF guard — internal targets are blocked by default.** After deploy AKIS issues a
server-side reachability GET to the target URL (the probe above). So the publish **Host** /
**Public URL** must be a *public* address: by default AKIS **rejects** internal/loopback targets
— `127.0.0.0/8`, `::1`, the cloud-metadata + link-local range `169.254.0.0/16` (incl.
`169.254.169.254`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), unique-local IPv6, and obvious
internal names (`localhost`, `*.internal`, `*.local`). This is enforced both when you save the
profile (a `400 BadHost` / `400 BadPublicUrl`) **and** again, with a DNS re-resolve, right before
the probe (so a public-looking hostname that *resolves* to a private IP is still refused). A
public IP such as the OCI free-tier instance validates normally. If you genuinely run AKIS
single-user and *want* a loopback/LAN target (the documented self-host posture), set
`AKIS_PUBLISH_ALLOW_INTERNAL=1` to opt back in.

**On the AKIS host (one-time):** the Docker runtime image already includes
`openssh-client`. A **from-source** AKIS host needs `ssh`/`scp` on `PATH`. And
`AI_KEY_ENCRYPTION_KEY` must be set so the SSH key can be encrypted at rest — AKIS
**refuses to store** the key otherwise.

**Limitations (v1):**

- **Host-key trust is TOFU** (`StrictHostKeyChecking=accept-new`): the *first* connect to
  a host is **not** MITM-authenticated (a *changed* key afterwards is refused). Host-key
  fingerprint pinning is a documented follow-up.
- **Crash-survives, reboot-does-not.** A node-service is supervised by a small `run.sh`
  `until`-loop (restart-on-crash with a back-off `sleep`); it does **not** survive a box
  reboot (systemd-user units are deferred).
- Only **`static`** and **`node-service`/fullstack** apps publish in v1; `vite`/`next`
  return `ok:false` (they need a build step + a host we don't provision yet).
- One app per profile (a single `appPort`); the deploy **stops the prior app first** then
  overwrites the target dir in place (no rollbacks/versioning yet).

Optional env: `AKIS_PUBLISH_STORE_PATH` (where the encrypted profiles persist; default
`~/.config/akis/publish-profiles.json`), `AKIS_PUBLISH_DEADLINE_MS` (the total deploy
deadline; default 120000 — a slow box records `ok:false` rather than hanging), and
`AKIS_PUBLISH_ALLOW_INTERNAL=1` (the SSRF escape hatch above — opt back in to loopback/LAN
publish targets for a genuinely single-user host; unset by default = internal targets refused).

---

## Environment reference

The compose file sets the self-host essentials for you; everything else is
optional and flows through from your shell / `.env`. Full descriptions live in
[`backend/.env.example`](../backend/.env.example) — the highlights:

| Variable          | Set by compose            | Purpose |
| ----------------- | ------------------------- | ------- |
| `PORT`            | `3000`                    | Container listen port (also the published host port; override with `PORT=8080 docker compose up`). |
| `HOST`            | `0.0.0.0`                 | Bind address. **Containers MUST use `0.0.0.0`** or the published port is unreachable; local non-Docker dev defaults to `127.0.0.1`. |
| `SERVE_STATIC`    | `1`                       | Serve the built `frontend/dist` SPA alongside the API on the same port. |
| `DATABASE_URL`    | `postgres://akis:akis@db:5432/akis` | Postgres DSN → activates persistence (see below). Unset → in-memory. |
| `AKIS_ALLOW_MOCK` | `1` (override in `.env`)  | Keyless demo: run the deterministic mock provider + passing demo verification. **Fallback** — the mock *provider* is auto-disabled when a provider key is set, but mock *verification* stays on until you also clear this. Set `0` to require a real key + real verification (fail-closed). |
| `AKIS_ALLOW_DEMO_IN_PROD` | `1` (compose default) | **B1 — demo fail-closed.** A demo flag (`AKIS_ALLOW_MOCK` / `AKIS_DEMO_VERIFY`) *fakes* verification (a build reaches done+preview WITHOUT real tests). In `NODE_ENV=production` the backend **refuses to boot** on a demo flag unless this is set to acknowledge it. The bundled demo stack sets `1`; for your own production deployment set `0` and configure a real key + verification. |
| `AKIS_REAL_TESTS` | unset | Turn on **real** verification (Trace boots the generated app + HTTP-probes it). It **OVERRIDES a lingering demo flag**: with `AKIS_REAL_TESTS=1` the passing mock runner is never injected, so a leftover `AKIS_ALLOW_MOCK`/`AKIS_DEMO_VERIFY` can't silently bypass real tests (audit #43). |
| `AUTH_JWT_SECRET` | **insecure default** (`akis-insecure-demo-secret-change-me`); override via `.env`/shell | HS256 session-signing secret. The default only keeps the prod-mode demo booting. **Override it** for any real use (`openssl rand -hex 32`) — also makes sessions survive restarts. |
| `PUBLIC_BASE_URL` | pass-through              | Browser-facing origin for OAuth + cross-site cookies, e.g. `http://localhost:3000`. |
| `ANTHROPIC_API_KEY` (or another provider key) | pass-through | Enables real builds and auto-disables the mock. Absent → keyless mock demo. |
| `AKIS_GITHUB_PUSH_TOKEN` + `AKIS_GITHUB_PUSH_REPO` | pass-through | **Opt-in real GitHub PR push.** Both set → a verified build's `confirmPush` opens/updates a real PR (branch + commit + PR via the REST API) on `owner/name`; either blank → the in-memory mock (default). The token (fine-grained PAT, Contents + Pull requests write, or a GitHub App token) is sent as a Bearer credential and is **never logged/returned**. Still gated by `ApprovedPush`; always mock under `NODE_ENV=test`. |
| `AKIS_PUBLISH_STORE_PATH` | `~/.config/akis/publish-profiles.json` | Where per-user **publish destinations** (the encrypted SSH key + host/dir/port for "publish to your own server") persist, `0600`. Set in the UI, not env. Needs `AI_KEY_ENCRYPTION_KEY` to store the key (AKIS refuses otherwise). In-memory under `NODE_ENV=test`. |
| `AKIS_PUBLISH_DEADLINE_MS` | `120000` | Total deploy deadline for a publish-to-your-own-server action. On timeout AKIS records an honest `{ok:false}` and returns — it never hangs the worker. |
| `AKIS_PUBLISH_ALLOW_INTERNAL` | unset (refuse) | **SSRF escape hatch.** Unset → AKIS refuses internal/loopback/RFC1918/`169.254`-metadata publish targets (validated at save **and** re-resolved before the server-side reachability probe). Set `1` to allow loopback/LAN targets on a genuinely single-user host (the documented self-host posture). A public IP (e.g. the OCI instance) is unaffected either way. |

To change the published port without touching the container's internal port:

```bash
PORT=8080 docker compose up     # browser → http://localhost:8080  (container still :3000)
```

---

## Persistence

**Set `DATABASE_URL` and your users, sessions, and workflows persist across
restarts.** The compose stack does this automatically by pointing AKIS at its
bundled `db` (Postgres 16) service; on boot the backend connects and uses the
durable Postgres-backed store instead of the in-memory one. Drop `DATABASE_URL`
(remove the `db` service / unset the var) and AKIS falls back to fast in-memory
state that resets on restart — handy for an ephemeral demo.

**Boot is fail-closed in production.** When `DATABASE_URL` is set with
`NODE_ENV=production` (the compose default) but Postgres is unreachable at boot, the
backend **refuses to start** rather than silently running in-memory and losing your
data on the next restart. The bundled stack's `db` healthcheck + `depends_on`
ordering make this a non-issue; if you point AKIS at an external database, make sure
it is reachable. `GET /health` reports the active persistence + serving mode:
`{ "ok": true, "persistence": "postgres" | "memory", "mode": "live" | "demo" }`.
`mode: "demo"` means a demo flag is active so "verified" output is **not** from real
tests — the studio UI also shows an amber **"DEMO · mock-verified"** badge in that case.

What persists with `DATABASE_URL` set:

- **Users + auth sessions** (the Postgres user store)
- **Workflow presets** and **build history / sessions**

What does **NOT** persist yet (documented deferral):

- **The vector / RAG knowledge index.** Embeddings are held in memory and are
  **re-built on restart** from your configured knowledge sources (repo / uploads).
  Expect a one-time re-index after each restart; retrieval quality is unaffected
  once it completes. Persisting the vector index is deferred to a later milestone.

### Real semantic embeddings (optional)

RAG retrieval works **out of the box with no key**: AKIS ships an offline,
deterministic embedder (signed feature hashing) so the knowledge index builds
with zero network calls and the golden eval stays reproducible.

To upgrade to **real semantic embeddings**, just configure an **OpenAI key** — the
*same* `OPENAI_API_KEY` the chat provider uses (env var **or** a key saved in the
Settings UI; one key system, never a second). The moment that key resolves, AKIS
embeds via OpenAI's `text-embedding-3-small` (1536-dim) instead of the offline
embedder. The selection rule:

| Condition | Embedder | Dimension |
| --------- | -------- | --------- |
| `NODE_ENV=test` | offline `LocalEmbeddingProvider` (always) | 256 |
| no OpenAI key resolves | offline `LocalEmbeddingProvider` | 256 |
| OpenAI key resolves (env or KeyStore) | `ApiEmbeddingProvider` (OpenAI) | 1536 |

The active dimension follows the selected embedder automatically — nothing
downstream hardcodes a size, and the vector store is dimension-agnostic. Set
`AKIS_EMBEDDING_MODEL=text-embedding-3-large` to use the 3072-dim model instead.
The key is used only as a request header and is **never logged or returned**.

> **`OPENAI_BASE_URL` override:** if you point `OPENAI_BASE_URL` at an
> OpenAI-compatible proxy **and** enable real embeddings, that base URL must also
> expose `/v1/embeddings` — embeddings are fetched from `${OPENAI_BASE_URL}/embeddings`
> (so the base should end in `/v1`), or embedding requests will 404 at runtime.

> Switching embedders changes the vector space, so **re-index** your knowledge
> sources after enabling/disabling a real key (the in-memory index re-builds on
> restart anyway).

> **Changing the embedding dimension on a populated Postgres corpus needs a
> re-ingest.** Once `vector_chunks.vector` is upgraded to `vector(N)`, switching to
> a model with a different dim does **not** auto re-`ALTER` the column, and new-dim
> writes are rejected/contained — so re-ingest your sources after the change. The
> same is true semantically for the portable `double precision[]` array fallback.

Three named Docker volumes hold state:

| Volume         | Mount                        | Contents |
| -------------- | ---------------------------- | -------- |
| `akis_pgdata`  | `/var/lib/postgresql/data`   | Postgres data (users, sessions, workflows). |
| `akis_home`    | `/home/node/.akis`           | Preview workspaces + generated-app state. |
| `akis_config`  | `/home/node/.config/akis`    | Encrypted key store (Settings-UI saved keys). |

### Backup & restore the Postgres volume

Back up a logical dump while the stack is running (recommended — portable across
Postgres versions):

```bash
# dump → ./akis-backup.sql
docker compose exec -T db pg_dump -U akis -d akis > akis-backup.sql

# restore into a fresh stack (db must be up & healthy)
docker compose up -d db
cat akis-backup.sql | docker compose exec -T db psql -U akis -d akis
```

Or snapshot the raw volume (stack stopped, exact byte copy — same Postgres major
only):

```bash
docker compose down
# back up
docker run --rm -v akis_pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/akis_pgdata.tgz -C /data .
# restore
docker run --rm -v akis_pgdata:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/akis_pgdata.tgz -C /data"
docker compose up -d
```

Back up `akis_config` the same way if you saved provider keys via the Settings UI
(losing it just means re-entering keys); `akis_home` is regenerable preview state.

---

## Password-reset email (optional)

By default AKIS does **not** send email. `POST /auth/forgot-password` mints a
short-lived (15-minute) reset token and, in **dev only**, echoes the reset link in the
response so the flow is usable without a mail server; in production no link is surfaced.

To deliver the reset **link by email** instead, configure a mailer. Set `AKIS_MAIL_FROM`
plus **either** a one-line `AKIS_SMTP_URL` **or** the discrete `AKIS_SMTP_HOST`/`PORT`/
`USER`/`PASS` set:

```bash
AKIS_MAIL_FROM="AKIS <noreply@you.dev>"          # required to enable
AKIS_SMTP_URL=smtps://user:pass@smtp.you.dev:465  # smtps ⇒ implicit TLS (recommended)
# — or, equivalently —
# AKIS_SMTP_HOST=smtp.you.dev
# AKIS_SMTP_PORT=465
# AKIS_SMTP_USER=user
# AKIS_SMTP_PASS=pass
PUBLIC_BASE_URL=https://app.you.dev               # makes the emailed link clickable
```

| Variable          | Purpose |
| ----------------- | ------- |
| `AKIS_MAIL_FROM`  | **Required to enable.** Envelope + header `From`. With it **unset** the mailer is the default no-op (dev-echo preserved). |
| `AKIS_SMTP_URL`   | One-line relay `smtp://…:587` (plaintext) or `smtps://…:465` (implicit TLS). |
| `AKIS_SMTP_HOST` / `AKIS_SMTP_PORT` / `AKIS_SMTP_USER` / `AKIS_SMTP_PASS` | Discrete relay config (used when `AKIS_SMTP_URL` is unset). `465` ⇒ TLS. |
| `AKIS_SMTP_SECURE` | `1` forces implicit TLS regardless of port. |

Behavior and safety guarantees:

- **Configured ⇒ the link is emailed and the dev-echo is suppressed** (the token never
  appears in the HTTP response). **Unconfigured ⇒ byte-for-byte today's behavior.**
- The `forgot-password` response is **enumeration-safe**: the same
  `"If that email has an account, a reset link has been sent."` body is returned whether
  or not the email exists, and whether or not mail delivery succeeded (a mail outage is
  swallowed — it never becomes a 500 or a slow path that reveals account existence).
- The reset **token / link is never logged**, and the SMTP password is sent only inside
  the `AUTH` exchange (never logged).
- The mailer is **always a no-op under `NODE_ENV=test`** (tests/CI never send mail). A
  malformed config (e.g. a garbage `AKIS_SMTP_URL`) falls back to the no-op rather than
  breaking boot. **STARTTLS is not implemented** — use an implicit-TLS (`smtps` / 465)
  submission endpoint for a remote relay.

---

## Build Passport (optional)

On a **verified** build AKIS produces a durable, **Ed25519-signed Build Passport** — a portable,
offline-verifiable proof that the build *"passed N real tests behind the structural gates"*. It
signs the already-minted facts `{sessionId, testsRun, codeDigest, evidenceDigest, issuedAt}`; anyone
holding the public key can verify it **without trusting AKIS, the network, or replaying the build**.
Read it at `GET /sessions/:id/passport` (returns the passport, the server's trusted public key, and a
server-side `verified` result).

```bash
# .env — optional; without it a clearly-DEV key is generated + persisted (stable across restarts)
AKIS_PASSPORT_PRIVATE_KEY=    # Ed25519 PKCS#8 PEM → a stable, operator-owned signing key
# AKIS_PASSPORT_KEY_PATH=~/.config/akis/passport.json   # where the DEV key persists (mode 0600)
```

- The signing **private key is held only in memory and is NEVER logged or returned** — only the
  **public** key is published (on the passport + the read route). The dev key file is `0600`, outside the repo.
- The passport **signs already-minted facts** — it can never mint or forge verification; `mint` still
  requires a genuine ≥1-test pass. Generate an operator key with
  `openssl genpkey -algorithm ed25519` (keep the private PEM secret; publish only the public key).

---

## Upgrading

```bash
git pull
docker compose up --build      # rebuilds the image; volumes (your data) are preserved
```

`docker compose down` keeps volumes; `docker compose down -v` **deletes** them —
use `-v` only when you intend to wipe all data.

### Push an update to a remote box that runs the bundled image (maintainers)

If your box runs the prebuilt `akis:deploy` image via compose (no source/git on the box),
[`scripts/deploy-box.sh`](../scripts/deploy-box.sh) codifies the full ship: it cross-builds a
`linux/amd64` image to a **complete** tarball (with `--provenance=false --sbom=false` so
buildx doesn't emit a hollow image), backs up the box's current image as a rollback tag,
streams + `docker load`s the new one, recreates the `app` container, then probes `/health` and
**auto-rolls-back** if it doesn't come up. No secret is ever passed on the CLI or baked in.

```bash
AKIS_DEPLOY_HOST=your.box.ip ./scripts/deploy-box.sh
# optional: AKIS_DEPLOY_USER (default ubuntu) · AKIS_DEPLOY_DIR (default ~/akis-deploy)
#           AKIS_DEPLOY_PORT (default 3000) · AKIS_IMAGE_TAG (default akis:deploy)
```

Cross-arch caveat: it builds `linux/amd64` (most cloud VMs). The box's compose `image:` must be
`akis:deploy`; the box keeps a `~/akis-deploy/docker-compose.yml` + `.env` (never committed).

Migrations run automatically on boot and are idempotent. One edge case: upgrading a
database first created before AKIS added OAuth identities applies a uniqueness
constraint on `external_id`. If an earlier (buggy) build had recorded **duplicate**
OAuth identities, that migration — and therefore boot — fails until you de-duplicate.
This is intentional fail-closed behavior: merge/remove `users` rows that share an
`external_id`, then restart.

---

## Cutting a release (maintainers)

Publishing a new versioned image to GHCR + a GitHub Release is handled by the
[`release.yml`](../.github/workflows/release.yml) workflow. It runs **only** on a
deliberate trigger — never on an ordinary push to `main`, so nothing publishes by
accident:

```bash
# tag the commit you want to release and push the tag
git tag v0.1.0
git push origin v0.1.0
```

…or fire it manually: **Actions → Release → Run workflow**, and enter the version
(e.g. `v0.1.0`) in the prompt.

Either trigger runs the same pipeline: build the `Dockerfile` → **keyless `/health`
boot-smoke the freshly built image** → and only if that smoke passes, push the image
to `ghcr.io/OmerYasirOnal/akis-platform-mvp` under both the version tag and `latest`,
then create the GitHub Release with auto-generated notes. The publish is **gated on
the smoke** — an image that doesn't boot is never shipped. Auth to GHCR uses the
built-in `GITHUB_TOKEN` (no user secret, no host); the workflow only needs
`contents: write` (the Release) + `packages: write` (the GHCR push).

> Release **branches are intentionally kept** — cleanup is left manual. The
> pipeline only creates tags, images, and Releases; it never deletes branches.

---

## Troubleshooting

- **Browser can't reach `http://localhost:3000`** — confirm `HOST=0.0.0.0` is set
  on the `app` service (the compose file does this); a container bound to
  `127.0.0.1` is unreachable from the published port.
- **Sessions drop on every restart** — set your own stable `AUTH_JWT_SECRET` in a
  `.env` (the compose default is a shared insecure placeholder; in dev/non-prod an
  unset secret falls back to an ephemeral per-boot one).
- **Builds produce canned/mock output despite an API key** — a provider key
  auto-disables the mock, so check the key is actually reaching the container
  (`docker compose config | grep -i api_key`) and that you did not set
  `AKIS_ALLOW_MOCK` to something other than `1` while *also* expecting the mock.
- **`db` never becomes healthy** — check `docker compose logs db`; the `app`
  service waits for the `pg_isready` healthcheck before starting.
- **Data vanished after `down`** — you likely ran `down -v`, which removes the
  named volumes. Restore from a backup (above).
