# Governed product reports and contextual charts

This extends the existing product-priority export service, catalogue pagination, validated joins, immutable artifact storage, authenticated downloads and recovery. The branch started at merged main `de99288234b43411334de96f40f04cebf3242445`, including PRs #292 and #293. It does not add collection, backfill, inventory queries, mutations or schedules.

## Supported boundary

The shared registry in `oracle/product-report-config.js` drives configuration, executable provider fields, definitions, joins and disclosures. This is governed reporting, not arbitrary querying.

| Metric | Definition and provider |
| --- | --- |
| Units sold | Original persisted Shopify line quantity, summed across variants at parent product. Not net of returns; no extra payment/cancellation eligibility filter. |
| Product orders | Distinct Shopify order IDs containing the parent product, deduplicated across lines and variants. |
| Product sales | Discounted line presentment totals before refund allocation; excludes order shipping/taxes. Never total value of orders containing the product. |
| Landing-page sessions | GA4 sessions whose landing URL joins uniquely to a catalogue product. Not page views. |
| Organic clicks / impressions | Search Console page/day evidence from the selected governed property, joined to canonical product URLs. |

Net/gross sales, net units, refunds, product conversion rates, page views, profit and containing-order value are unavailable report metrics. Unknown metric requests require clarification; recognized unsupported metrics are disclosed with blank cells. Historical catalogue reconstruction, in-store product exports, arbitrary dimensions, alternative file formats and currency conversion are unsupported. Analytical conversion routes retain their existing governed native definitions; they do not create a product conversion metric.

Population is the complete **current online-published catalogue**, optionally selected by stable product IDs. It includes unmatched products; it does not claim every historical/deleted/offline product. Catalogue pagination completeness is recorded independently from unverified upstream source coverage. Top-N is applied after ranking. Commerce uses the governed online exclusion rules; website traffic retains its native scope and cannot be treated as in-store traffic.

Configuration separately records population, exact London-calendar dates, channel, ordered metrics, currency, sort metric/direction, XLSX output and optional photography/content preset. Default period is 90 completed days. Follow-ups preserve compatible dates/channel/population. Monetary columns retain source currencies separately; monetary ranking requires a named currency. No exchange-rate conversion or mixed raw currency ranking occurs.

The worksheet has one filterable tab, numeric metric cells, clickable URLs and a frozen header. Missing/failed/unsupported metrics stay blank; verified zero stays numeric zero. Missing sort evidence follows available values in either direction; stable product IDs break ties. If the requested ranking metric has no usable evidence, Oracle discloses ranking unavailable and does not substitute a blended score. The explicit photography/content preset retains its original five-column sheet.

## Automatic charts

A shared evidence-driven selector is used by direct, interactive and durable analytical delivery. Structured specifications include labels, units, periods, definitions and supporting tables, and survive artifact/job recovery. Supported adapters cover governed sales, country rankings, product reports/sales, native device conversion, compatible period comparisons, selected customer-journey rankings and native Shopify session stages. Time series use lines; rankings use sorted horizontal bars; compatible comparisons use grouped bars; same-population stages use stage bars. The composition contract renders stacked percentages only when categories are explicitly mutually exclusive and the population complete.

Unavailable facts are never plotted as zero. Mixed currencies and incompatible definitions/populations are separated. Bounded rankings never imply whole-population shares. Overlapping customer classifications are not charted as complete composition. Simple priority sheets, inadequate evidence and unsupported shapes do not receive forced charts. This does not promise automatic charts for every Oracle tool or arbitrary reporting.

## Requirement ledger

“Implemented” means verified through local real shared implementations with controlled provider fixtures; it does not assert successful production retrieval.

| Requirement | Status / evidence |
| --- | --- |
| 1. Reuse pagination, joins, storage, owner downloads and recovery | Implemented; production-factory and authenticated HTTP tests. |
| 2–3. Selectable metrics and explicit units/orders/sales/landing definitions | Implemented for the six registry metrics above; other measures unsupported. |
| 4. One numeric sortable worksheet, URLs and frozen header | Implemented; generated workbook assertions. |
| 5. Explicit five-column priority preset | Implemented; existing preset regression tests retained. |
| 6–7. Top-selling clarification, applied sort and preserved currencies | Implemented; units and GBP/USD-specific ranking tests. |
| 8–10. Missing vs zero, stable ties, IDs, all catalogue and post-ranking top-N | Implemented; null/zero, conflicting totals, 600-product unavailable traffic and top-20 tests. |
| 11. Configuration-preserving follow-ups | Implemented; add landings / sort units / refresh continuation tests inspect actual provider arguments. |
| 12–13. Independent failures, availability, methodology and provenance | Implemented; successful metrics retained and staff sheet remains uncluttered. |
| 14. Full-configuration retry/delivery/recovery validation | Implemented; config/order/dates/channel/currency/sort/population/preset mismatch checks and HTTP 409 tests. |
| Automatic charts without graph instructions | Implemented for adapters above; natural sales/country/product/conversion/comparison tests, guard tests and durable chart recovery. |
| Traffic-only live acceptance | Implemented locally; zero matched out of 600 explicitly yields ranking unavailable, with no blended fallback. Live match rate still unverified. |
| Selected product “last year” | Implemented locally; read-only governed family decisions, source coverage and successful-empty/missing-mapping/provider-failure outcomes tested. No guessed Woo identity. Live historical mapping unverified. |
| Mobile/desktop failure correlation | Safe scoped failure-stage persistence and read-only correlation diagnostic implemented. Exact deployed resolved context, executable binding and failure stage still unverified. |
| Explicit August/September after failed switch | Implemented; both shared HTTP modes clarify conversion vs product sales, resolve actual month windows and inspect provider arguments. |
| Online inheritance | Implemented; selected product, last-year and export follow-ups retain online scope in shared context/provider tests. |

The read-only diagnostic for `6395298a-d087-4ed6-aa3a-b2aeb7eb4106` stopped at `job_dataset_metadata`: HTTP 403, `EGRESS_FORBIDDEN`. This is an environment access limitation, not a finding about the original conversion failure. No production root cause is inferred from the generic UI message. Production GA4/Search Console coverage, catalogue URL match rates and deployed incident details remain unverified.

## Acceptance prompts

- “Export all products ranked by online units sold this year.”
- “Export product sales amounts, units sold and orders for January–September 2026.”
- “Sort by product sales in GBP instead.”
- “Show product landing-page sessions and sales, sorted by landings.”
- “Export product sales and organic clicks for the last 90 days.” → “Add landing-page sessions to that.” → “Sort by units sold instead.”
- “Export all products in order of landing traffic only.”
- “Make a simple photography priority list.”
- “How are sales this year?”; “Which countries have the highest sales?”; “How are mobile and desktop conversion rates this year?”
- Select a product in an online conversation → “What about last year?” → failed conversion switch → “What changed between August and September?” → choose conversion or product sales.

Tests are in `test/oracle-product-priority-production.test.js`, `test/oracle-product-report-config.test.js` and `test/oracle-evidence-charts.test.js`, plus existing context, routing, selection, chart and storage suites. Real shared services/dispatch/HTTP/storage adapters are exercised; remote providers are controlled fixtures.

Final validation: `env -u SHOPIFY_INVENTORY_LOCATION_ID npm test -- --test-reporter=tap` — 882 tests, 879 passed, 0 failed, 3 existing skips (83.5 seconds). The scoped environment removal keeps unrelated inventory fixtures isolated; no inventory query was performed. `git diff --check` and browser chart module syntax validation passed.
