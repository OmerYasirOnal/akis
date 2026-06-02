---
name: react-spa-scaffold
description: How to scaffold a single-page React app with a clean layout and small files
appliesToRole: proto
triggers: [react spa, react app, single page app, frontend scaffold, react ui, spa scaffold, react frontend]
status: draft
version: 0.1.0
---

Scaffold a runnable React SPA with a conventional layout and small files.

Layout (under src/): a main entry that mounts `<App/>` to a `#root` div in index.html; an App component hosting routing/layout; components/ for reusable UI; pages/ (or routes/) for screens; hooks/ for shared logic; lib/ (or api/) for fetch wrappers.

Rules:
- ONE entry point: index.html with a single `#root`; the main file calls `createRoot(...).render`.
- One component per file; keep each file under ~150 lines; co-locate component + styles.
- Centralize all server calls in lib/api — never fetch inline in views.
- Read env-driven values from a config module; never hardcode URLs.
- Define routes in one place; lazy-load page components.
- Provide package.json scripts: dev, build, preview, test.
- Add a top-level error boundary and a loading fallback.

Deliver a minimal working tree that renders one page and proves dev/build scripts run.
