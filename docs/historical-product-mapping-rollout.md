# Historical product mapping rollout

## Read-only production coverage check

Run the queue validator before enabling a review session:

```bash
npm run validate:product-mapping-review-queue-production
```

On the first Render production check, open the service **Shell** and run exactly the command above. It is the first command because it uses only four bounded `SELECT` queries and does not call schema setup or any append path. Do not run a sync, setup, bulk-review, or mapping command first.

The command is read-only. Its grain is one stable `(source_platform, source_store, source_product_id)` product. `by_source[*].products` and `total` both count the complete historical source set. `completed` is a disjoint count of active identity, active reporting-family, and latest `no_equivalent` states. `remaining` is a disjoint count of `needs_review` plus `needs_investigation`; rows do not need a Shopify suggestion to be in this queue. Deterministic cross-source matches and classified shipping, service, gift-voucher, custom, or unresolved rows are reported separately and are neither completed nor remaining. The validator fails unless these categories reconcile exactly to `total`, with zero missing or overlapping products.

The UI queue is exactly the `remaining` state set before search. `counts.ui_queue_eligible` must equal `coverage.remaining`; `ui_matching` is the number matching the current search and `ui_returned` is its bounded first page (maximum 1,000). Search is applied before that bound, so a historical product without a Shopify suggestion remains findable, selectable, and reviewable as `no_equivalent` or `needs_investigation`; identity/family actions stay disabled until every selected row has a parent suggestion.

This explains the earlier production output: the per-source `products` values were actually *unresolved-by-governance* counts, so their 3,550 sum omitted the 42 completed products while `total` included them. Subtracting those same 42 again produced the apparent 1,096 gap. The correct remainder under those observed counts is 1,138 (`3,592 − 42 − 2,412`), to be divided by the validator between deterministic matches and intentional classification exclusions. It was a labeling/counting bug, not evidence of missing source rows; the new reconciliation makes that conclusion testable rather than assumed.

Sales impact is source-native operational evidence, not comparable revenue. Woo `total` and Shopify `discounted_total_presentment` are persisted major-unit amounts with their persisted currency. Square `retail_order_items.total_amount` is selected with its paired `currency` and is explicitly retained as a Square `Money.amount` **minor-unit** value; it is never divided without currency-exponent evidence. Coverage and rows therefore expose `sales_by_currency` entries labelled with both currency and monetary unit. Impact order is meaningful only inside a source/currency bucket and must never be read as a ranking between GBP, USD, or Square minor-unit values.

Record the per-source product, reviewable order-line and currency/unit-separated sales totals; identity and reporting-family resolution counts; review outcomes; intentional exclusions; and completed/remaining totals. Investigate unexpected source gaps or a large `unresolved` classification before writing decisions. Also run `npm run validate:product-mapping-production` to verify the append-only decision schemas and graph health.

## Small manual acceptance batch

Before broad bulk use, review 10–20 high-impact rows across WooCommerce WW, WooCommerce US and Square:

1. Include one exact SKU/title identity, multiple size-specific historical variants that should share one Shopify parent reporting family, an ambiguous suggestion, and products with no current equivalent.
2. Confirm that every suggestion shows supporting and conflicting evidence. Search for/correct the proposed parent and ensure Shopify variants cannot be selected.
3. Compare the **identity allowed / family allowed / blocked** preview. Choose the action explicitly; never use family as a fallback for blocked identity.
4. Submit a mixed batch and verify successful rows complete while failed rows remain visible with per-row errors.
5. Retry the same request IDs and confirm no duplicate events. Refresh a preview before submitting and verify an intentionally stale preview is rejected.
6. Verify reviewer identity, notes and separate identity, family and outcome histories in BigQuery, then reconcile completed/remaining coverage.

Expand batch size gradually only after the sample is reconciled. Title similarity is candidate evidence, not approval, and canonical identity semantics must not be changed to improve coverage.
