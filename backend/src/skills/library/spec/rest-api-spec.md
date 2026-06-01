---
name: rest-api-spec
description: How to write a contract-first spec for a REST/HTTP API service
appliesToRole: scribe
triggers: [rest api, http api, build an api, api endpoint, backend api, api service, crud api, web service]
status: draft
version: 0.1.0
---

Turn an API idea into a contract-first spec a backend can build against. Produce, in order:

1. Overview & scope — what the API does, primary consumers, base URL, versioning.
2. Resources & data model — each resource, its fields, types, required/optional, relationships.
3. Endpoints — for every endpoint: METHOD + path, purpose, path/query params, request body schema, success response (status + body), error responses.
4. Auth — scheme (bearer/JWT/API key), which endpoints are protected, role/permission rules.
5. Cross-cutting rules — pagination, filtering, sorting, rate limits, idempotency, status-code and error-format conventions.
6. Acceptance criteria — concrete request/response examples per key endpoint.

Use concrete field names and example JSON. Flag undefined behavior as an open question rather than inventing it.
