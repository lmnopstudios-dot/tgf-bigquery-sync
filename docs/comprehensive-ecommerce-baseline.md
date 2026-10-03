# Comprehensive ecommerce baseline

## Governed route

Oracle deterministically recognizes both a comprehensive ecommerce baseline and
an explicit WooCommerce-versus-Shopify comparison. The direct `/agent`,
interactive `/api/oracle/chat`, and durable analysis worker all use the same
service. This route cannot select an inventory tool. It executes at most two
evidence calls concurrently and lets each source fail independently.

The default period is the latest complete calendar month in `Europe/London`,
the preceding calendar month, and the same calendar month one year earlier.
For a request on 2 October 2026 those windows are September 2026, August 2026,
and September 2025. Explicit named months are preserved. Calendar completeness
is not collection completeness and is not attribution maturity.

Supported examples:

* `Build a comprehensive ecommerce baseline for the latest complete calendar month, with the previous month and the same month last year as comparisons.`
* `Compare September 2026 native Shopify online sales with September 2025 WooCommerce online sales.`

## Evidence and definitions

* **Company-wide finance** uses the existing management report over Oracle's
  canonical finance path. It reports each currency independently: sale and
  refund transaction counts, gross sales, refunds, net gross, recorded tax, and
  net sales excluding recorded tax. A missing comparison remains unavailable;
  an explicit zero remains zero; percentage change from zero is undefined.
* **Channels and locations** use the governed Report v2 finance section and
  location finance service. These remain distinct from Shopify Online Store
  operational metrics. The canonical finance aggregate does not expose units,
  discounts, or ecommerce AOV, so Oracle does not relabel another field.
* **Woo and native Shopify online sales/geography** use the governed online
  country service. It deduplicates orders, excludes Matrixify migrated Shopify
  representations, retains direct-shipping unknowns, and keeps currencies and
  source coverage separate. Its source-native order-total-less-refunds measure
  is directional and is not canonical accounting revenue. Native Shopify
  persisted history begins 16 November 2025; mixed transition windows are
  partial. Woo remains retired and reportable and is never recollected.
* **Shopify funnel** uses controlled ShopifyQL human-session definitions for
  sessions, cart additions, reached checkout, completed checkout, and compatible
  rates. Device/acquisition evidence comes from the governed persisted Shopify
  conversion service. Order counts are never substituted for completed-checkout
  sessions. GA4 definitions are not spliced into Shopify-native definitions.
* **Customers and products** use source-native Shopify evidence plus the
  management report's historical Woo evidence and limitations. There is no
  governed Woo-to-Shopify person identity bridge. A customer is not called new
  merely because Shopify history begins at migration. Products are not aligned
  across platforms by display title. Collection/collaboration performance is
  unavailable when the bounded route has no governed classification rows.
* **Klaviyo** reports campaign and flow rows separately, by currency, including
  delivered email, message-level unique clicks, attributed events, attributed
  value, exact collected months, missing months, and the persisted retrieval
  timestamp. Attribution is non-incremental and is never added to sales.
* **Search Console** uses Report v2's canonical property-selection contract.
  The current report supplies canonical daily clicks and impressions. CTR,
  position, leading pages, and leading queries are stated unavailable rather
  than derived by averaging incompatible daily values or inventing a top-N
  aggregate.

Every section distinguishes a source collection/retrieval timestamp from query
execution time. Where the underlying service does not expose a persisted source
timestamp, the answer says `unknown`; it never presents execution time as source
freshness.

## Failure handling and persistence

The deterministic response and its structured evidence envelope are returned
together. Interactive responses expose the envelope directly; durable jobs save
it in `result_json`; direct `/agent` responses expose the same envelope. Thus a
later renderer can reproduce completed sections without model synthesis. A
failed optional source is recorded with a bounded error code, while successful
sections remain visible.

The generic synthesis fallback previously treated almost any nominally
successful tool object as proof that validated figures existed, even when its
row/summary renderer produced no section. That explains the demonstrated local
failure mode behind “figures ... are shown below” followed by no figures. The
fallback now makes that claim only if it actually rendered at least one evidence
section. Production job rows and logs were not accessible in the implementation
environment, so whether the reported production request retrieved useful rows,
lost them before persistence, or never produced them remains unproven. The new
structured envelope makes that distinction inspectable after deployment.

## Preserved limitations

Historical Square component discrepancies remain unresolved. Legacy
`finance.accountant_transactions` is not automatically equivalent to every
canonical Oracle finance view, and a bounded Shopify refresh/reconciliation does
not establish universal finance acceptance. GA4 ecommerce instrumentation was
incomplete after launch and corrected during September, but the exact boundary
requires evidence; unrecorded events cannot be recovered. Google Ads and Meta
remain unavailable until collected and verified. Klaviyo aggregate reports do
not establish product-specific attributed purchases. Cross-platform conversion,
customer, and product comparisons remain unsupported without compatible traffic
or governed identity evidence, and observed changes are not attributed causally
to the migration.

## Read-only post-deployment verification

Set `ORACLE_DIAGNOSTIC_URL` to the deployed read-only `/agent` endpoint and, if
required, set `ORACLE_DIAGNOSTIC_TOKEN`. The diagnostic prints only bounded
scope/status/row-count metadata and sanitized failure codes; it does not print
provider payloads, PII or credentials:

```sh
npm run diagnose:oracle-ecommerce-baseline
npm run diagnose:oracle-platform-comparison
npm run diagnose:oracle-products
npm run diagnose:oracle-product-comparison
```

These commands perform reads only. They do not collect, refresh, backfill,
change schedules or watermarks, reactivate retired sources, or request
inventory. Shopify product evidence uses the exact ShopifyQL date bindings and
an authoritative shop-currency lookup. BigQuery-backed constituent services
retain typed date parameters, metadata-derived dataset locations, row limits
and maximum-bytes-billed controls where their service contracts expose them.
Production access was unavailable during implementation, so live evidence and
dry-run acceptance remain pending after deployment.

1. Submit each supported example to direct `/agent`, interactive chat, and an
   enabled durable job using the normal authenticated interfaces and a fixed
   request ID. Do not invoke sync, refresh, backfill, watermark, or schedule
   endpoints.
2. Confirm the response periods, `evidence.kind`, per-call status, and actual
   Klaviyo `latest_retrieved_at`. Confirm query timestamps are not described as
   source collection timestamps.
3. Temporarily exercise a non-production injected source failure (or use the
   existing test harness); verify finance remains visible and the failed source
   says unavailable, not zero.
4. Inspect the durable job read endpoint and confirm completed `result_json`
   includes both `answer` and the structured `evidence` envelope.
5. Compare September 2026 with September 2025 and confirm Matrixify exclusion,
   Shopify's known native-history boundary, separate currencies, and the
   cross-platform compatibility warning. Do not use this verification to rerun
   retired Woo collection or mutate source data.
