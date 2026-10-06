# November online sales explanation correction

Base: latest merged `main`, `4c1f88d71877efc51f636468a8fefa1234acba24` (#289).

## Findings

The exact question resolves both calendar months, but the independent-month parser branch subsequently overwrote its comparison type and added unrelated calendar-month state. General sales also inherited the finance parser's default GBP selection without an explicit currency request.

The sales report queried both periods but omitted `comparison_rows` from its return. General analytics consumed that absent field as an empty list and summed it to zero. It also summed GBP and USD current rows into one number. The currency disclaimer did not constrain arithmetic. Production canonical finance returns `source`; the explanation expected `source_platform`, resulting in “Unknown Online” labels. Existing fixtures supplied the expected fields and concealed this mismatch.

Knowledge retrieval used an empty topic selection and a 14-day look-behind. Confirmed facts and timeless definitions remained eligible and the explanation displayed them as events without dates or provenance. `Promise.all` could discard successful sales evidence when a period or context retrieval failed.

## Corrected contract

- Independently query 1–30 November 2025 and 1–30 November 2024, with `channel=Online` for the exact request. Retain all native currencies unless explicitly restricted.
- Return both result populations and independent retrieval outcomes. Empty, malformed, failed and unqueried evidence remain unavailable. A returned numeric zero remains zero; percentage change from zero is unavailable.
- Preserve raw ledger `source`, source platform derived from the source label, and the source/store label. Legacy store labels remain the raw ledger identifiers, not guessed canonical Woo store codes. Retain provenance and observed dates; collection completeness remains unknown.
- Show both periods' sale transaction counts, canonical gross sales, signed refunds and net sales. Compare only identical source/store, channel and currency populations. Display net, gross, signed-refund and transaction-count changes where supported. Do not bridge Woo and Shopify into a like-for-like population or calculate a combined currency total.
- Keep existing canonical migration governance: exclude all legacy Shopify ledger rows and Matrixify Shopify representations; retain legitimate residual Woo and native Shopify overlap. No new date cutoff or source mutation is introduced.
- Query confirmed `event` records for each exact period using relevant sales topics, including Black Friday. Require dates, ID and provenance; exclude definitions, working records, out-of-period records and unrelated context, including explicitly retail-tagged campaigns from online-only explanations. Timing is context, not causal proof.
- Use the same deterministic dispatcher for direct, interactive and durable delivery, without agent fallback for an unavailable general-sales binding.

## Aggregation audit

| Path | Finding / action |
|---|---|
| General sales and product charts | Null/empty values coerced to zero; fixed null-aware aggregation. Preserve source/store metadata and source/currency series. |
| Report sales KPIs | Missing values coerced to zero; fixed shared strict summation. Currency totals remain separate. |
| Canonical finance / refund summaries | A caller could omit currency grouping with an unrestricted currency filter; currency is now always a grouping dimension. Empty refund summaries are unavailable, and unrestricted summaries preserve each currency. |
| Baseline country source coverage, Klaviyo summaries, platform-period totals and AOV | Removed missing-as-zero coercion and suppress derived AOV when sales are missing. Existing currency/source partitions retained. |
| Report browser trend renderer | Null points drew at zero, and metadata could mix source/currency series; fixed separate populations and gaps. |
| Inline country and monthly charts | Null values accepted as zero; rejected. Calendar-month gaps remain gaps even when all series lack that month. |
| Historical campaign explanation | Already preserves source/currency populations, independent failures and null-safe money; retained. |
| Annual location reconciliation | Already partitions by currency and suppresses differences when any component is null; retained. |
| Evidence summaries | Render source-native scalar facts; no cross-currency total computed; retained. |

## Validation and remaining live acceptance

`test/november-sales-explanation.test.js` exercises the real parser → dispatcher → report → canonical provider boundary, plus actual authenticated interactive HTTP and durable jobs. Fixtures use canonical production-shaped `source`, transaction type, amount and count fields. Regressions cover exact provider dates, mixed currencies, null/absent/failed comparison, supported zero, source provenance, unrelated knowledge, and independent sales/context failures.

The full suite passed with `env -u SHOPIFY_INVENTORY_LOCATION_ID node --test`: 817 passed, 3 skipped. The inherited production location binding causes three unrelated existing inventory mock tests to fail; no inventory provider or source was accessed. Final focused checks exercise the subsequent explanation/context refinements.

Run `node diagnostics/november-sales-explanation.js` with working configured provider access. It is read-only and executes the exact shared explanation path, followed by an aggregate November 2025 Matrixify/native overlap inspection. In this workspace both sales retrievals failed, and the overlap query also failed. No live totals, campaign effects, coverage completeness or migration counts were established.

After deployment, verify the exact prompt through direct delivery, authenticated interactive chat and durable jobs against live evidence. Confirm both periods, source-native currencies, overlap exclusions, dated event IDs/provenance, supported changes and explicit unexplained components. No deployment, collection, backfill, inventory query, source/knowledge mutation or scheduling is performed by this change.
