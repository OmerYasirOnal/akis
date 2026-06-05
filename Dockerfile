# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════════════
# AKIS — single bundled self-host image. The backend serves BOTH the built
# frontend (frontend/dist via @fastify/static when SERVE_STATIC=1) AND the API on
# ONE port (default 3000). One Node major is pinned across the Dockerfile + CI;
# do NOT float `lts`.
#
# The backend runs UNCOMPILED TypeScript via `tsx src/main.ts` (there is no
# backend build step, and @akis/shared resolves to shared/src/index.ts directly),
# so the runtime image must retain `tsx` (a devDependency) plus the full
# pnpm-workspace node_modules graph. We achieve that by carrying the builder's
# frozen, fully-linked node_modules into the final stage rather than re-running a
# `--prod` install (which would PRUNE tsx and break the CMD).
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Stage 1: builder — frozen install + build the frontend (→ frontend/dist) ───
FROM node:22-alpine AS builder
WORKDIR /app

# Enable the repo's pinned pnpm (root package.json: packageManager pnpm@9.0.0).
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Install deps first against just the manifests + lockfile so this layer caches
# across source-only edits. --frozen-lockfile fails if the lockfile is stale.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json   ./shared/package.json
COPY backend/package.json  ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --frozen-lockfile

# Bring in the sources, then build. Only the frontend has a `build` script
# (vite build → frontend/dist); backend + shared are typecheck-only / tsx-run,
# so `pnpm -r build` produces exactly frontend/dist and nothing for the rest.
COPY tsconfig.base.json ./
COPY shared   ./shared
COPY backend  ./backend
COPY frontend ./frontend
RUN pnpm -r build

# ─── Stage 2: runtime — node:22-alpine, NON-ROOT, tsx-in-prod retained ──────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SERVE_STATIC=1
WORKDIR /app

# Carry the fully-linked workspace (incl. tsx, pg, and the @akis/shared symlink)
# and the built frontend from the builder. Owned by the built-in `node` user so
# preview/keystore writes under the home dir never hit EACCES. tini reaps the
# child processes AKIS spawns for previews/real-tests (avoids zombies, forwards
# signals so the process group is cleanly SIGKILLed on stop).
#
# openssh-client: the "publish to your own server" feature shells out to the system
# `ssh`/`scp` (no native `ssh2` dep — keeps the clean pnpm/Alpine story). RUNTIME stage
# only (the builder never spawns ssh). The spawned ssh runs as the non-root `node` user,
# writing the transient 0600 key into a 0700 per-run dir under os.tmpdir() (writable by node).
RUN apk add --no-cache tini openssh-client

COPY --from=builder --chown=node:node /app/node_modules          ./node_modules
COPY --from=builder --chown=node:node /app/package.json          ./package.json
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml   ./pnpm-workspace.yaml
COPY --from=builder --chown=node:node /app/tsconfig.base.json    ./tsconfig.base.json
# shared: package.json + src (the workspace alias resolves to shared/src/index.ts)
COPY --from=builder --chown=node:node /app/shared/package.json   ./shared/package.json
COPY --from=builder --chown=node:node /app/shared/tsconfig.json  ./shared/tsconfig.json
COPY --from=builder --chown=node:node /app/shared/src            ./shared/src
COPY --from=builder --chown=node:node /app/shared/node_modules   ./shared/node_modules
# backend: package.json + src (tsx runs src/main.ts; bundled skills live in src)
COPY --from=builder --chown=node:node /app/backend/package.json  ./backend/package.json
COPY --from=builder --chown=node:node /app/backend/tsconfig.json ./backend/tsconfig.json
COPY --from=builder --chown=node:node /app/backend/src           ./backend/src
COPY --from=builder --chown=node:node /app/backend/node_modules  ./backend/node_modules
# frontend: ONLY the built dist (the backend serves it; sources are not shipped)
COPY --from=builder --chown=node:node /app/frontend/package.json ./frontend/package.json
COPY --from=builder --chown=node:node /app/frontend/dist         ./frontend/dist

# Pre-create the dirs AKIS writes to (preview workspaces under ~/.akis, encrypted
# key store under ~/.config/akis) owned by `node`, else first write EACCEsses.
RUN mkdir -p /home/node/.akis /home/node/.config/akis \
 && chown -R node:node /home/node/.akis /home/node/.config

USER node
EXPOSE 3000

# tsx is REQUIRED in prod (backend has no compiled output). Run from the backend
# package so its node_modules/.bin/tsx and the @akis/shared workspace alias both
# resolve. This mirrors the backend `start` script (`tsx src/main.ts`).
WORKDIR /app/backend
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
