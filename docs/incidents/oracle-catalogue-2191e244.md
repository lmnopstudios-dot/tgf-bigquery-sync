# Oracle catalogue export retrieval

Request: 2191e244-e5b6-4972-8eba-e039d9aa9d23. Deployed/base revision: add222d9f5cbbb0c97382620cd2ed715071fd7e3.

## Demonstrated mechanisms

The browser's product-export heuristic required the word product(s). The supplied pendant export therefore selected chat, including after a completed job. The shared resolver nevertheless creates a product_report with catalogue_filter pendants, units_sold descending, and 2026-01-01 through 2026-10-12. Selecting that subject alone does not prove provider selection. A real production-factory fixture now verifies native metadata, selected pendant IDs across pages, provider arguments, units ranking, unmatched blank spreadsheet cells and requested dates.

The catalogue service ignored deadlineAt supplied by interactive/durable dispatch. Native Shopify transport authenticated for every page and did not retry throttles. Catalogue failure could produce a partial artifact. The fixes preserve shared planning, category selection and owner-scoped persisted export infrastructure, add deadline cancellation through auth, HTTP, pagination and throttle waits, reuse expiring credentials, and fail closed before enrichment/persistence. Enrichment receives the signal and remaining deadline, with BigQuery jobTimeoutMs capped to that budget. BigQuery's query API does not provide immediate client cancellation here; already-submitted queries remain bounded by their job budget. No timeout was increased.

Requests use products(first:100), stable ID sort and cursor progression. Classification includes native product type, tags, and five memberships initially, with 100-membership cursor pages where needed. Ambiguous sources still clarify. SEO description is requested only for the photography/content priority preset. No inventory/variant fields are requested. Throttling retries are bounded to three attempts per GraphQL page, cancellation-aware, with bounded backoff; other API failures are not retried. Product and membership repeated/missing cursors fail closed.

Page diagnostics contain stage, safe code/status, page/item counts, elapsed milliseconds and remaining deadline. Successful logs are sampled at the first page, every 25 pages and completion; failures include final counts. They contain no tokens, prompts, customer values or raw exception messages. Public errors distinguish timeout, cancellation, API rejection, pagination and internal catalogue validation consistently in interactive and failed-job delivery.

The product-report context branch labelled all unchanged defaults as retained, even on continuation:false. These were diagnostic field names, not proof of retained values. The labels now exclude defaults. Cross-subject regression verifies incompatible entity/product context clears. No production contamination is established.

## Snapshot reuse

shopify/catalogue.js persists product type/tags/status and membership sync timestamps but not onlineStoreUrl or publishedAt. It cannot establish this export's Online Store publication contract, nor a complete fresh publication snapshot. No stale substitution or source mutation was introduced. Existing completed artifacts remain owner/request/config scoped; incomplete historical artifacts cannot be recovered as completed exports.

## Incident uncertainty and bounded live reads

The supplied SOURCE_FAILED/unknown after 79,887 ms does not establish an HTTP rejection, throttle, pagination failure or actual provider timeout. Browser misrouting and ignored budget are demonstrated; the exact failing upstream operation remains unknown.

Executed read-only diagnostics:

1. Parameterized SELECT from the configured Oracle job table, WHERE request_id=@request_id for the incident, LIMIT 1. Selected only status, error_code and resolved category term (term was never printed). EU location, maximumBytesBilled 100000000, jobTimeoutMs 10000, process deadline 15000 ms. Result: DIAGNOSTIC_FAILED after 653 ms; no result rows or pendant verification obtained.
2. One configured BigQuery dataset getMetadata call, process deadline 15000 ms. Result: API_ACCESS_FAILED, safe status null, after 656 ms. No metadata obtained.

Runtime readiness reported credential variables and network policy state unknown. API access was not established; the safe diagnostic does not identify a more specific access cause. No live Shopify, collection, inventory, backfill, source/knowledge mutation, scheduling, deployment or merge operation was performed.

## Validation

Focused catalogue/category/report/context suites cover real production bindings, multi-page exports, interactive and durable authenticated delivery, explicit same-ID retry, owner isolation, refresh/recovery, rejected leases, pagination failures, slow HTTP timeout, caller cancellation, HTTP/GraphQL throttling and API rejection, category ambiguity and unmatched spreadsheet values. Shared job regressions also passed. Strict tool-schema validation checks 46 schemas across 61 registered tools. Final combined catalogue/category/report/context run: 94 passed, 0 failed, 0 cancelled (9.81 seconds). Earlier combined shared job/export/context run: 107 passed, 0 failed, 0 cancelled (80.73 seconds). The final production/category/budget subset also passed 44 tests before the final combined run. git diff --check and source syntax checks passed.

Initial sandbox test invocation failed before useful HTTP-fixture results; it is not a passing run. Re-running with local server access exposed the old partial-export expectation, which was updated to require no artifact. No test run was interrupted.
