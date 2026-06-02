# Self-hosting AKIS

Run your own AKIS the way you run Ollama: one command, one container stack, your
machine. The bundled image serves the built frontend **and** the API on a single
port; an optional Postgres service makes your users, sessions, and workflows
survive restarts.

> [!CAUTION]
> **AKIS runs AI-generated code as ordinary child processes on the host — there
> is NO sandbox.** Previews, real Playwright/Cucumber verification, and any tool
> the model invokes execute with the same privileges as the AKIS process, sharing
> your kernel and filesystem. Node's permission model is **not** a security
> boundary; neither is a container (see [`THREAT-MODEL.md`](../THREAT-MODEL.md)).
> Therefore AKIS self-host is **SINGLE-USER**. **Do NOT expose it to untrusted
> users or the public internet** without supplying your own isolation (a VM per
> user, a microVM/Firecracker/gVisor isolate, a locked-down network). The default
> stack publishes the port on `127.0.0.1` (loopback only) for exactly this reason.

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

> [!IMPORTANT]
> The bundled `AUTH_JWT_SECRET` default is **insecure and shared** — it exists only
> so the keyless demo boots zero-config. For anything beyond a throwaway local demo,
> set your own (`AUTH_JWT_SECRET=$(openssl rand -hex 32)` in a `.env`). An empty
> secret in production fails closed by design; the default keeps that guard happy
> while still nudging you to replace it.

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
| `AKIS_ALLOW_MOCK` | `1` (override in `.env`)  | Keyless demo: run the deterministic mock provider + passing demo verification. **Fallback** — auto-disabled when a provider key is set. Set `0` to require a real key (fail-closed). |
| `AUTH_JWT_SECRET` | **insecure default** (`akis-insecure-demo-secret-change-me`); override via `.env`/shell | HS256 session-signing secret. The default only keeps the prod-mode demo booting. **Override it** for any real use (`openssl rand -hex 32`) — also makes sessions survive restarts. |
| `PUBLIC_BASE_URL` | pass-through              | Browser-facing origin for OAuth + cross-site cookies, e.g. `http://localhost:3000`. |
| `ANTHROPIC_API_KEY` (or another provider key) | pass-through | Enables real builds and auto-disables the mock. Absent → keyless mock demo. |

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

What persists with `DATABASE_URL` set:

- **Users + auth sessions** (the Postgres user store)
- **Workflow presets** and **build history / sessions**

What does **NOT** persist yet (documented deferral):

- **The vector / RAG knowledge index.** Embeddings are held in memory and are
  **re-built on restart** from your configured knowledge sources (repo / uploads).
  Expect a one-time re-index after each restart; retrieval quality is unaffected
  once it completes. Persisting the vector index is deferred to a later milestone.

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

## Upgrading

```bash
git pull
docker compose up --build      # rebuilds the image; volumes (your data) are preserved
```

`docker compose down` keeps volumes; `docker compose down -v` **deletes** them —
use `-v` only when you intend to wipe all data.

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
