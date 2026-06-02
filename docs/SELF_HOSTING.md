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

Stop it with `Ctrl-C` (or `docker compose down` if detached). Your data persists
in named volumes across `down`/`up` — see [Persistence](#persistence) below.

### Run a REAL build (optional)

With **no** provider key, AKIS runs a fully working keyless **mock** demo. To do
real builds, give it a provider key — put it in a `.env` file next to
`docker-compose.yml` (Compose auto-loads it) or export it in your shell:

```bash
# .env  (next to docker-compose.yml)
ANTHROPIC_API_KEY=sk-ant-...
AUTH_JWT_SECRET=$(openssl rand -hex 32)   # stable sessions across restarts
PUBLIC_BASE_URL=http://localhost:3000     # browser-facing origin (cookies/OAuth)
```

Then `docker compose up` again. (See the full key list in
[`backend/.env.example`](../backend/.env.example).)

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
| `AUTH_JWT_SECRET` | pass-through (`.env`/shell) | HS256 session-signing secret. **Set it** in production, else sessions reset every boot. |
| `PUBLIC_BASE_URL` | pass-through              | Browser-facing origin for OAuth + cross-site cookies, e.g. `http://localhost:3000`. |
| `ANTHROPIC_API_KEY` (or another provider key) | pass-through | Enables real builds. Absent → deterministic mock demo. |

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
- **Sessions drop on every restart** — set `AUTH_JWT_SECRET` (a stable value);
  unset, the backend uses an ephemeral per-boot secret.
- **`db` never becomes healthy** — check `docker compose logs db`; the `app`
  service waits for the `pg_isready` healthcheck before starting.
- **Data vanished after `down`** — you likely ran `down -v`, which removes the
  named volumes. Restore from a backup (above).
