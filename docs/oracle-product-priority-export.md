# Product priority export

Implemented from merged main `51a124856266c856af89ba10c8a2bf8d4461cf6c` (6 October 2026).

## Failure trace and evidence boundary

Replaying the supplied production prompt against that commit's `transitionAnalysisContext` from a fresh context produces `requested_subject=sales`, `analysis_type=finance`, `tool_route=get_shopify_operational_sales_baseline`, null dates, required start/end dates, and `ready_to_execute=false`. This is a demonstrated classification defect: a request for current published products and improvement priorities becomes a historical sales baseline.

The shared dispatcher registers that route as baseline-then-agent. It has no complete-catalogue priority/export binding. Interactive delivery can request dates; durable delivery calls the dispatcher without the interactive clarification gate. The internal agent transport prepends the resolved context and executes `/agent`. Its legacy catalogue search (`searchShopifyProducts`) returns at most 25 products, requests variants/inventory, and does not retrieve Online Store publication. `shopify/catalogue.js` persists ACTIVE status but lacks publication and canonical URL fields and retrieves collections. Neither is an authorised implementation of this request. Existing operational product rankings also use bounded populations. No product-priority XLSX exists on the base commit.

`createAnalysisJobWorker` checkpoints only after `run` returns, then finishes the job. If execution throws before that checkpoint, `fail` stores a bounded error code and stage. `/jobs/:id` emits the exact reported sentence, “The analysis could not be completed; no partial answer was returned.” when a failed job has no persisted answer. The sentence identifies the durable delivery branch, not a particular provider failure.

A read-only production job lookup for photography requests was attempted. OAuth token refresh returned HTTP 403, `Could not refresh access token: Domain forbidden`, under this environment's destination policy. No production job ID/provider call trace was retrieved. The original terminating provider error, retained session context, and deployed revision cannot therefore be claimed as demonstrated. The source replay above establishes a reproducible routing defect on the requested merged base, not the precise historical exception. Do not attribute the incident to Shopify throttling, GA4, model synthesis, or a timeout without the failed job's code/stage and correlated deployment logs.

## Retrieval and ranking

The dedicated route `export_product_priorities` precedes generic sales parsing, resets stale entity/channel/currency context, supplies the last 90 completed Europe/London dates, and executes the priority service without an agent or knowledge proposals. For receipt on 6 October 2026, dates are **8 July–5 October 2026**, inclusive. Persisted submission dates survive a job running after midnight.

A new read-only Shopify Admin GraphQL connection uses the existing authorised token/service and requests only product IDs, titles, status, `publishedAt`, `onlineStoreUrl`, and stored SEO description. ACTIVE status alone does not mean published. Eligibility requires ACTIVE or UNLISTED, Online Store `publishedAt`, and a valid HTTPS `onlineStoreUrl`. The 2026-07 [Product contract](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Product) establishes Online Store URL/publication semantics. The [ProductStatus contract](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductStatus) includes UNLISTED direct-link products (supported since 2025-10); they remain eligible if published. The query has no ACTIVE-only filter. All pages are traversed until `hasNextPage=false`, with cursor-stall checks, stable product-ID deduplication and conflict validation. There are no variants, stock, inventory, collections, collector runs, backfills or source mutations. A failed later page yields an explicitly INCOMPLETE list of retrieved products. A failure before any products yields `CATALOGUE_UNAVAILABLE`, not an empty “all products” export.

Independent BigQuery reads use existing persisted Shopify line items/order locations, GA4 landing pages, and Search Console pages. Online sales exclude retail-location POS, known POS app labels and Matrixify. Order/line IDs are deduplicated before product aggregation. Recent sales and available same-ID Shopify sales history through the end date are kept separately. Historical Woo products are not mapped by title, SKU heuristics, or product-family aggregation. Cross-platform history without an explicitly validated identity is unavailable in this export.

Sales joins accept only numeric Shopify Product IDs or Product GIDs, never Variant GIDs or titles. Page joins use exact canonical HTTPS product URLs, stripping query strings/fragments/trailing slash only; unrelated hosts and ambiguous URLs are excluded. GA4's governed property landing paths are bound to `https://www.thegreatfroglondon.com`. No www/non-www, locale, collection-prefix, redirect or historical-slug guesses are made. Search Console uses the selected governed property per day, avoiding duplicate property totals.

Priority method v1:

- 50%: mean sales percentile across each product's observed currency groups. Within each currency, percentile is the count of observed products with strictly lower sales divided by `N-1` (singleton: 1 for positive sales, otherwise 0). No currencies are added or converted.
- 30%: observed landing-session percentile, using the same tie formula.
- 20%: percentile of `max(impressions-clicks,0)`, an uncaptured search exposure proxy. It is not proof of poor conversion, a CTR benchmark, or purchase attribution.
- Missing/unmatched components contribute zero without reweighting; their evidence values remain null and their availability remains explicit. A genuine recorded zero is observed zero. Absent sales rows are never zero-filled.
- Score descending, numeric Shopify product ID ascending for ties. Products with no usable evidence remain in the export after ranked rows with blank Priority. ID ordering is not presented as an impact ranking.
- Missing evidence, incomplete catalogue, or unverified source coverage makes ranking provisional. No usable ranking evidence makes ranking unavailable.

Current persisted tables do not establish complete collection coverage across every requested date for these product/page reads. Production loader results therefore remain provisional even when all three reads succeed. All exports from this loader are currently provisional (or unavailable if no usable evidence). This is disclosed rather than inferring coverage from an observed max date or filling omitted products with zeros. Last-90-day values are operational evidence, not accounting refunds/net sales. Long-term supporting sales are same-ID Shopify history only, excluded from the primary score.

Every row says “Review photography”: no image quality was assessed. An explicitly empty stored Shopify SEO description adds “Write a meta description (Shopify SEO description is empty)”. Null/unavailable metadata does not create that task. This does not assert that a rendered page lacks a fallback meta tag. Other products receive “Review product-page content”. No traffic-based poor-conversion or subsequent-purchase causal claims are made.

## Workbook, persistence and delivery

One worksheet has exactly:

`Priority | Product | Product link | Work needed | Status`

The worksheet name and filename label provisional, unavailable or incomplete exports so the downloaded file carries that warning. Links are clickable. The sheet has filters, a frozen header, widths/wrapping and status validation: To do, In progress, Done, Blocked. Every status starts To do. Scores, source values, method, dates, completeness and availability live only in the analytical envelope.

Deployment inspection: `docs/oracle-ui.md` describes the Render web service using BigQuery `commerce.oracle_analysis_jobs_v1`, with no durable disk/Redis. `render.yaml` supplies collectors, not a persistent web disk. The implementation reuses BigQuery storage/IAM in `ORACLE_JOB_DATASET` (default commerce) and creates only Oracle artifact table `oracle_exports_v1`. It persists the exact XLSX bytes, hash, analytical envelope and manifest as JSON through owner-scoped, idempotent query MERGE. No local filesystem holds durable exports; no source-data tables are written. The service account needs table creation/read/query/DML on that dataset, as with the existing job store.

Artifact IDs are hashes of owner and request ID. UI owner is an HMAC of the authenticated principal with the session secret: refresh and a new login for the same principal can download the same artifact. An owner/request retry returns the saved bytes; a different prompt using the same owner/request is rejected. Direct `/agent` uses the bearer-authenticated service principal derived with SYNC_SECRET. The direct and UI ownership namespaces differ.

Delivery paths:

- `/agent` returns `artifact`, `evidence`, answer and `/agent/exports/:id`; downloads require the existing bearer authentication.
- `/api/oracle/chat` returns the persisted artifact and `/api/oracle/exports/:id`; download and `/manifest` recovery require the current authenticated owner.
- `/api/oracle/jobs` stores owner in its payload, and completed job result persists the same artifact reference/envelope. Polling returns it unchanged. If an artifact was durably saved but the job checkpoint/finish failed, polling recovers that completed artifact without provider replay. The UI renders the download link and retains completed export recovery metadata, falling back to the owner-authenticated manifest after a new login invalidates an older job's session ownership.

There is an explicit 8 MB serialized artifact limit, below the BigQuery query-request limit. Oversized exports fail with `EXPORT_STORAGE_SIZE_EXCEEDED`; they are never truncated or substituted with top-N. XLSX bytes are immutable server-side. Staff status changes occur in the downloaded workbook only. Storage retention/cleanup is not scheduled by this change.

## Verification and remaining deployment checks

`test/oracle-product-priority.test.js` exercises complete pagination/publication filtering, zero-sales catalogue retention, product-ID/URL joins, wrong host and Variant-ID rejection, product deduplication, within-currency ranking, zero versus missing, source failures, stored metadata tasks, unavailable and incomplete lists, exact one-sheet/five-column XLSX, workbook controls, store MERGE ownership, real authenticated HTTP downloads in interactive/durable/direct handler paths, manifest recovery after reconnect, exact-byte recovery and idempotent/concurrent retries.

Live provider execution, production job lookup and production BigQuery artifact IAM could not be verified because OAuth egress is forbidden in this environment. HTTP delivery tests use the real UI router/worker and download implementation with injected catalogue/source/storage fixtures; they are not a deployed production acceptance run. No deployment is performed.

Oracle acceptance prompt:

> Export all published Shopify products in priority order for photography and product-page improvements.

Confirm catalogue completeness, applied dates and provisional notes; download the workbook; refresh/reconnect and download again. Confirm one worksheet, exactly five columns, all catalogue products, clickable links and To do statuses.

Validation: the full suite passed 841 tests, with 3 existing skips, after clearing the inherited inventory-location selector for mock fixture isolation. Subsequent targeted checks covered checkpoint recovery and explicit export-storage failure.
