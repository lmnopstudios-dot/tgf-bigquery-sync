# Clarified product export scope and delivery

Request: `39063ced-8872-48d5-9a0c-3016eb4bcb04`. Deployed revision and implementation base: `775a0882037ec0aac8a0a76c01fef9009d6f4932`, latest merged main including PR #308.

The supplied production log establishes complete catalogue retrieval (600 products, seven pages), enrichment, ranking, workbook generation, persistence and verification. Delivery reported persisted; scope validation failed after 59,148 ms. The catalogue retrieval is not the demonstrated failure. The retrieval count does not establish the workbook's selected population.

## Demonstrated defects

The deployed `assertCatalogueSelection` compares `JSON.stringify(selection.filter)` with `JSON.stringify(config.catalogue_filter)`. Configuration validation emits `{term, source}`; persisted JSON objects can return `{source, term}`. An isolated execution of the **deployed** validator using identical product IDs and collection membership produces `EVIDENCE_SCOPE_MISMATCH` solely from that key reordering. The exact field is `catalogue_selection.filter`. The fixed validator accepts it. This reproduces a defect consistent with the persistence-then-validation sequence; the actual production artifact's field ordering has not been read.

The browser chooses delivery using only the newest message. The initial export matches the job heuristic added by #308, but “Use collection pendants” does not. A completed prior job also directs short replies to chat. The retained server plan still requests the export route and XLSX. The clarified execution consequently receives the 60-second interactive budget. This is a demonstrated routing defect independent of catalogue availability.

Source selection previously reparsed an offered collection by its display term. It did not retain the offered stable identity. A numbered native-classification choice had no retained candidates to resolve. Reinterpreting an already-consumed numbered choice during job submission also changed context and rejected an otherwise idempotent retry.

## Shared changes

- Retain bounded offered native-classification choices in validated report context. Resolve unique named or numbered choices to the offered collection GID. Preserve metrics, period, ranking, channel, format and ready-to-ship intersections. Repeating the same named selection retains its identity.
- Use the same normalized filter scope in report configuration keys, analytical plan hashes, selection validation, saved artifact agreement and request recovery. Normalize case, whitespace, existing singular/plural category equivalences and absent/false ready-to-ship flags. Source, collection identity, additional intersection and product population remain strict.
- Add bounded `scope_field` diagnostics, including `catalogue_selection.filter` and specific `report_config` fields. No raw evidence, ownership keys, credentials, workbook bytes or catalogue dumps appear in those diagnostics.
- Resolve browser transport through authenticated `/analysis/route` against the retained execution context before submission. This performs no provider reads or job creation. Short metric, selection, sorting and date replies retain export delivery. Existing job submission and explicit correlation-ID recovery remain in place; ambiguous enqueue outcomes are not automatically resubmitted.
- Validate selected scope before workbook generation/persistence and validate actual workbook bytes before publishing and on recovery/download. Check checksum, worksheet and row count, ordered product links against stable-ID envelope rows, metric cells and native collection membership. Ordinary workbooks expose product links rather than ID cells; the check maps each link to its stable product-ID envelope row.
- After current scope agreement, reuse the original immutable submitted job for an owner-scoped correlation-ID replay before interpreting the already-consumed reply. A reused ID with genuinely changed scope remains a conflict. Completed artifacts remain stored if later delivery fails. Failed-job, manifest and same-request service recovery validate scope and bytes before returning existing downloads.

## Actual fixtures and acceptance coverage

`test/oracle-product-category-export.test.js` uses the real Express UI router, shared dispatcher, product service, pagination, ranking, XLSX writer/reader, memory job store/worker and artifact store. Its storage adapter recursively reorders object keys to model the persisted JSON boundary.

The production-shaped fixture contains 600 published parent products across seven pages. Product type Pendants is IDs 1–75; collection `gid://shopify/Collection/658285396295` is IDs 26–100; tag Pendants is IDs 126–200. All three counts are 75 but their actual ID sets differ. Collection export contains exactly IDs 26–100, descending units 100–26, retaining 2026-01-01 through 2026-10-09 from the initial fixture request. Both direct interactive compatibility and durable implementations execute the full ambiguity → named/numbered selection → export sequence. The browser's resolved transport is asserted as durable.

Tests verify downloaded workbook hyperlinks/cells, evidence and artifact agreement, owner denial, same-request retries, manifest refresh, failed-job recovery without repeated provider calls, later ascending ranking and prior-year refinement. Product-type/tag choices and metric-only replies retain scope. Corrupt bytes, wrong workbook links, missing native membership, changed collection IDs, source changes, unfiltered selection and changed dates remain rejected. A separate fixture with identical **actual ID sets** skips unnecessary clarification while retaining both native bindings; equality of counts is never used for merging.

## Live checks and artifact recovery outcome

Two read-only checks were attempted using the configured runtime credentials:

1. Existing incident diagnostic: one dataset metadata lookup before its bounded job lookup. Returned `403`, `EGRESS_FORBIDDEN` at `job_dataset_metadata` in approximately 0.21 seconds.
2. `diagnostics/oracle-clarified-export-incident.js`: one parameterized owner-scoped SELECT of the existing Oracle export artifact, using the configured admin identity and session secret to derive the existing ownership key and request artifact ID. LIMIT 1, 100 MB billing cap, 10-second BigQuery job cap and 15-second process cap. Returned `403`, `EGRESS_FORBIDDEN` in approximately 0.18 seconds. No table setup/create was invoked.

No production artifact was obtained, altered, downloaded or regenerated. Its exact mismatched field, actual workbook IDs, membership, and safe recoverability remain **unverified live**. Local failed-job recovery succeeds with the original persisted bytes and no repeated provider calls. From an authorized environment with permitted BigQuery egress, run the bounded export diagnostic for the supplied request to inspect scope/bytes before any recovery. Compare complete native populations only from existing evidence that contains their actual ID sets; the selected workbook alone does not prove both full populations identical.

No live catalogue/collection retrieval, backfill, inventory calls, source/knowledge writes, schedules, deployment or merge were performed. The fixes require normal deployment before production behavior changes; deployment is outside this request.

## Final validation

Final combined run: **213 passed, 0 failed, 0 cancelled, 0 skipped**, approximately 80.73 seconds. Includes all 19 category-export tests and shared priority/report, catalogue budget, job lifecycle, clarification, analytical plan, dispatcher, UI, conversation, relative-date and general analytics regressions. Earlier intermediate runs exposed test-expectation errors and a changed-scope idempotency regression; those were corrected, and are not represented as successful final runs.

```sh
node --test test/oracle-product-priority.test.js \
  test/oracle-product-priority-production.test.js \
  test/oracle-product-report-config.test.js test/oracle-catalogue-budget.test.js \
  test/oracle-analysis-jobs.test.js test/oracle-clarification-consumption.test.js \
  test/oracle-shared-analytical-plan.test.js test/oracle-analysis-route-dispatcher.test.js \
  test/oracle-ui.test.js test/oracle-product-category-export.test.js \
  test/oracle-conversation-continuity.test.js test/oracle-relative-date-continuity.test.js \
  test/oracle-general-analytics.test.js
node diagnostics/oracle-tool-schema-validation.js
```

Strict tool validation: **46 schemas across 61 tools**. Changed JavaScript syntax checks and `git diff --check` passed. Production service and browser behavior after deployment remain live acceptance checks; deployment was not performed.
