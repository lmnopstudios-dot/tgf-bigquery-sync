# Oracle knowledge and persistent memory

## Architecture and authority

The foundation deliberately separates three layers:

1. Existing governed finance, analytics, order and customer tools remain authoritative for measured numbers.
2. Structured BigQuery records describe governed business facts, temporal events and definitions.
3. Structured memory records preserve analytical findings and decisions with evidence and epistemic status.

Memory is not a metric cache and cannot override live governed data. There are no embeddings in the authority path. BigQuery was selected because it is already the repository's durable, auditable datastore, supports bounded temporal/status/tag queries, requires no new external database, and can later support secondary vector indexes without changing the structured records.

## Persistent objects

The `oracle_knowledge` dataset contains four partitioned tables:

* `facts`: opaque `knowledge_id`, subject, predicate, statement, nullable effective dates, audit/provenance fields, status, supersession links and tags.
* `events`: opaque `event_id`, event type, title/description, nullable start/end, date precision, audit/provenance fields, status, supersession links and tags.
* `definitions`: opaque `definition_id`, term, definition, repository implementation reference, nullable effective dates, audit/provenance fields, status, supersession links and tags.
* `findings`: opaque `memory_id`, title/statement, memory type/status, nullable effective dates, compact JSON evidence references, audit/provenance fields, confidence, supersession links and tags.

Dates may be exact/ranged or unknown; unknown dates stay null and are never inferred. Statuses are `confirmed`, `working`, `rejected`, and `superseded`. Memory types are `finding`, `decision`, `explanation`, `hypothesis`, `rejected_hypothesis`, `data_quality_issue`, and `reporting_convention`. Provenance source types are `human_entered`, `business_document`, `governed_data_analysis`, `system_definition`, and `external_source`.

## Supersession and retrieval

An administrative write may name an existing same-kind record in `supersedes`. The new immutable record is inserted, then the old record is marked `superseded` and linked through `superseded_by`; history is not overwritten. Effective-period overlap uses inclusive boundaries. Unknown-date facts and definitions are eligible context, while event dates must be explicit unless `date_precision` is `unknown`.

Default retrieval ranks current definitions, confirmed facts/events, confirmed findings, then clearly labelled working records. Rejected and superseded records are excluded unless explicitly requested. `get_business_context` returns confirmed structured records overlapping a requested period; it does not claim nearby events were active.

The `/agent` surface exposes only `search_knowledge`, `get_business_context`, `get_knowledge_item`, `search_memory`, and `get_memory_item`. Its prompt requires context retrieval for relevant historical/event analysis, campaign-window disambiguation, and separate presentation of observed data, business context, and hypotheses.

## Write governance and privacy

There is intentionally no `record_memory` tool available to `/agent`. Writes require the separately authenticated Render shell/administrative CLI and a structured JSON file. Every record requires a source type, source reference and creator; memories also require compact evidence references. Validation rejects PII-like fields. Do not place raw tool output, chain-of-thought, secrets, customer data, private employee data, payment details or addresses in records.

Setup and seed the established repository definitions:

```sh
npm run setup:knowledge
```

Validate the local contracts without querying production:

```sh
npm run validate:knowledge
```

To add a human-confirmed event, create `/tmp/black-friday-2025.json` (dates and offer below are illustrative placeholders and must be replaced with established details):

```json
{
  "kind": "event",
  "event_type": "black_friday_campaign",
  "title": "Black Friday 2025 campaign",
  "description": "Replace with the explicitly confirmed offer/context.",
  "date_precision": "range",
  "effective_from": "2025-11-21",
  "effective_to": "2025-12-01",
  "status": "confirmed",
  "source_type": "human_entered",
  "source_reference": "Approved by <business role/reference>; replace this placeholder",
  "created_by": "authenticated-admin",
  "supersedes": null,
  "tags": ["black-friday", "promotion"]
}
```

Then run `npm run knowledge:write -- /tmp/black-friday-2025.json`. The example is documentation only and is not seeded.

## Seed scope

Seeds document only contracts already enforced in this repository: canonical finance authority, source-native order semantics, Metorik historical Woo authority, Matrixify deduplication, direct/incomplete historical geography, Search Console canonical-property selection, and first-observed/repeat-customer semantics. No campaign dates, offers or speculative business history are seeded.
