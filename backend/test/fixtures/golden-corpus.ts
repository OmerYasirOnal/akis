/**
 * Golden-eval retrieval fixture (M1 exit criterion F1-AC8).
 *
 * A SMALL, self-contained fixture corpus + a golden set of ≥20 natural-language
 * query→expected-chunk pairs. The quality gate (test/unit/retrieval-golden-eval.test.ts)
 * ingests this corpus through the REAL hybrid path (vector + BM25 + RRF) with the offline,
 * deterministic LocalEmbeddingProvider and asserts top-5 hit-rate clears the gate.
 *
 * Each document is short (< 800 chars) so it stays a SINGLE chunk (see ingest/chunk.ts),
 * which lets the eval identify the expected chunk unambiguously by its `id` (the stable
 * sourceId stamped at ingest, surfaced as `provenance.sourceId`). Queries are paraphrases
 * — they deliberately AVOID copying the doc verbatim so the eval measures real retrieval
 * (semantic + lexical fusion), not string equality.
 */

export interface CorpusDoc {
  /** Stable, unique id — also the ingest sourceId and the eval's expected-chunk key. */
  id: string
  text: string
}

export interface GoldenPair {
  /** Natural-language query (a paraphrase, never the doc verbatim). */
  query: string
  /** The sourceId of the single document that should rank in the top-k. */
  expectedId: string
}

/** Fixture corpus: 20 distinct, topical documents (one chunk each). */
export const GOLDEN_CORPUS: CorpusDoc[] = [
  { id: 'doc-postgres-migrations', text: 'Postgres database migrations: create new tables, alter columns, and apply schema changes in ordered, reversible steps using a migration runner.' },
  { id: 'doc-jwt-auth', text: 'JSON Web Token authentication signs a compact token with a secret so the server can verify a user session without storing state on the backend.' },
  { id: 'doc-react-hooks', text: 'React hooks like useState and useEffect let function components hold local state and run side effects after render without writing a class.' },
  { id: 'doc-docker-compose', text: 'Docker Compose defines multi-container applications in a YAML file, wiring services, networks, and volumes so the whole stack starts with one command.' },
  { id: 'doc-redis-cache', text: 'Redis is an in-memory key-value store commonly used as a cache to speed up reads and to hold ephemeral session data with optional expiry.' },
  { id: 'doc-rest-pagination', text: 'REST API pagination returns large collections in pages using limit and offset or cursor parameters so clients fetch results in manageable batches.' },
  { id: 'doc-css-flexbox', text: 'CSS Flexbox arranges items along a single axis with flexible sizing, letting you align and distribute space between elements in a responsive row or column.' },
  { id: 'doc-git-rebase', text: 'Git rebase replays your commits on top of another branch to keep a linear history, rewriting commit hashes instead of creating a merge commit.' },
  { id: 'doc-graphql-schema', text: 'A GraphQL schema declares types, queries, and mutations so clients ask for exactly the fields they need from a single typed endpoint.' },
  { id: 'doc-kubernetes-pods', text: 'Kubernetes runs containers inside pods, scheduling them across nodes and restarting failed workloads to keep the desired replica count healthy.' },
  { id: 'doc-tls-https', text: 'TLS encrypts HTTPS traffic between browser and server using certificates, protecting data in transit from eavesdropping and tampering.' },
  { id: 'doc-websocket-realtime', text: 'WebSockets keep a persistent full-duplex connection open so the server can push real-time updates to the browser without repeated polling.' },
  { id: 'doc-elasticsearch-index', text: 'Elasticsearch builds an inverted index over documents to power fast full-text search with relevance scoring, filters, and aggregations.' },
  { id: 'doc-oauth-flow', text: 'The OAuth authorization code flow lets a third-party app obtain a scoped access token on a user behalf without ever seeing their password.' },
  { id: 'doc-typescript-generics', text: 'TypeScript generics parameterize types so a function or container can work over many types while preserving compile-time type safety.' },
  { id: 'doc-nginx-reverse-proxy', text: 'Nginx as a reverse proxy forwards incoming HTTP requests to upstream application servers, terminating TLS and load-balancing across backends.' },
  { id: 'doc-sql-join', text: 'A SQL JOIN combines rows from two tables on a matching key, with inner joins keeping only matches and outer joins keeping unmatched rows too.' },
  { id: 'doc-rabbitmq-queue', text: 'RabbitMQ is a message broker that buffers tasks in queues so producers and consumers decouple and work asynchronously at their own pace.' },
  { id: 'doc-s3-object-storage', text: 'Amazon S3 stores files as objects in buckets with durable, scalable cloud storage addressable by key, ideal for backups and static assets.' },
  { id: 'doc-cors-policy', text: 'CORS is a browser policy that uses response headers to decide whether a web page from one origin may call an API hosted on a different origin.' },
]

/**
 * Golden query→expected-chunk pairs (≥20). Queries paraphrase the topic in everyday words,
 * stressing BOTH halves of hybrid retrieval: some lean lexical (shared keywords → BM25),
 * some lean semantic-ish (reworded → the bag-of-words vector still overlaps), and a few
 * are intentionally HARD (sparse keyword overlap) so the gate is meaningful, not trivial.
 */
export const GOLDEN_PAIRS: GoldenPair[] = [
  { query: 'how do I change my database schema with ordered reversible steps', expectedId: 'doc-postgres-migrations' },
  { query: 'verify a user session with a signed token instead of server state', expectedId: 'doc-jwt-auth' },
  { query: 'add local state to a function component without a class', expectedId: 'doc-react-hooks' },
  { query: 'start a multi-container stack from one yaml file', expectedId: 'doc-docker-compose' },
  { query: 'in-memory key value store used for caching and sessions', expectedId: 'doc-redis-cache' },
  { query: 'return a large api collection in pages with limit and offset', expectedId: 'doc-rest-pagination' },
  { query: 'align and distribute items along one axis responsively in css', expectedId: 'doc-css-flexbox' },
  { query: 'replay my commits onto another branch for a linear history', expectedId: 'doc-git-rebase' },
  { query: 'typed endpoint where clients request exactly the fields they need', expectedId: 'doc-graphql-schema' },
  { query: 'schedule containers in pods across nodes and keep replicas healthy', expectedId: 'doc-kubernetes-pods' },
  { query: 'encrypt browser to server traffic with certificates', expectedId: 'doc-tls-https' },
  { query: 'push real-time updates to the browser over a persistent connection', expectedId: 'doc-websocket-realtime' },
  { query: 'inverted index for fast full text search with relevance scoring', expectedId: 'doc-elasticsearch-index' },
  { query: 'let an app get a scoped token without seeing the user password', expectedId: 'doc-oauth-flow' },
  { query: 'parameterize types so a function works over many types safely', expectedId: 'doc-typescript-generics' },
  { query: 'forward http requests to upstream servers and terminate tls', expectedId: 'doc-nginx-reverse-proxy' },
  { query: 'combine rows from two tables on a matching key', expectedId: 'doc-sql-join' },
  { query: 'message broker that buffers tasks so producers and consumers decouple', expectedId: 'doc-rabbitmq-queue' },
  { query: 'durable scalable cloud storage for files addressed by key in buckets', expectedId: 'doc-s3-object-storage' },
  { query: 'browser policy deciding if a page may call an api on another origin', expectedId: 'doc-cors-policy' },
  { query: 'apply alter table column changes through a migration runner', expectedId: 'doc-postgres-migrations' },
  { query: 'third party app authorization code grant for access tokens', expectedId: 'doc-oauth-flow' },
]
