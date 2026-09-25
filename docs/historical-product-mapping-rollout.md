# Historical product mapping rollout

## Read-only production coverage check

Run the queue validator before enabling a review session:

```bash
npm run validate:product-mapping-review-queue-production
```

The command is read-only. Record the per-source unresolved product, order-line and sales totals; identity and reporting-family resolution counts; review outcomes; classification impact; and completed/remaining totals. Investigate unexpected source gaps or a large `unresolved` classification before writing decisions. Also run `npm run validate:product-mapping-production` to verify the append-only decision schemas and graph health.

## Small manual acceptance batch

Before broad bulk use, review 10–20 high-impact rows across WooCommerce WW, WooCommerce US and Square:

1. Include one exact SKU/title identity, multiple size-specific historical variants that should share one Shopify parent reporting family, an ambiguous suggestion, and products with no current equivalent.
2. Confirm that every suggestion shows supporting and conflicting evidence. Search for/correct the proposed parent and ensure Shopify variants cannot be selected.
3. Compare the **identity allowed / family allowed / blocked** preview. Choose the action explicitly; never use family as a fallback for blocked identity.
4. Submit a mixed batch and verify successful rows complete while failed rows remain visible with per-row errors.
5. Retry the same request IDs and confirm no duplicate events. Refresh a preview before submitting and verify an intentionally stale preview is rejected.
6. Verify reviewer identity, notes and separate identity, family and outcome histories in BigQuery, then reconcile completed/remaining coverage.

Expand batch size gradually only after the sample is reconciled. Title similarity is candidate evidence, not approval, and canonical identity semantics must not be changed to improve coverage.
