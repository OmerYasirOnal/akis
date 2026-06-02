---
name: node-service-scaffold
description: How to scaffold a Node HTTP API service with clean layering and small modules
appliesToRole: proto
triggers: [node service, http api, backend service, api server, node backend, rest api]
status: draft
version: 0.1.0
---

Scaffold a runnable Node HTTP API with clear layering and small modules.

Layout (under src/): a server entry that builds the app and calls `listen(PORT)`; an app module that wires middleware and mounts routers (keep it framework-thin); routes/ defining endpoints; handlers/ (or controllers/) with the per-route logic; services/ for business logic; lib/ for shared utilities (config, logging, errors).

Rules:
- ONE server entry; read PORT and config from env via a single config module — never hardcode.
- Thin routes → handlers → services. Keep each file focused and under ~150 lines.
- Centralized error handling: a typed error shape and one error middleware.
- Validate request input at the edge (body/query/params) before it reaches services.
- Health endpoint (GET /health) returning 200.
- Provide package.json scripts: dev, start, build, test.

Deliver a minimal tree with one working endpoint and a passing dev/start path.
