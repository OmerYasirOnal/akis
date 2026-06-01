---
name: data-pipeline-spec
description: How to write a spec for a data-pipeline / ETL job
appliesToRole: scribe
triggers: [data pipeline, etl, elt, ingest data, transform data, batch job, data ingestion, sync data, data warehouse]
status: draft
version: 0.1.0
---

Turn a data-movement idea into a spec an engineer can implement and operate. Produce:

1. Goal & scope — what data moves from where to where and why; batch vs streaming; cadence.
2. Sources — each input (system, format, location, access), expected volume, source schema.
3. Extraction — how data is pulled, incremental vs full load, watermark/cursor strategy.
4. Transformations — ordered steps (clean, join, dedupe, cast, derive, business rules); input + output schema per stage.
5. Destination — target store, table/schema, write mode (append/upsert/overwrite), partitioning.
6. Orchestration — schedule/trigger, dependencies, retries, backfill.
7. Data quality — row counts, null/uniqueness checks, schema-drift handling.
8. Acceptance criteria — a sample input-to-output example and quality thresholds.

Name fields and tables concretely; flag unknown source schemas as open questions.
