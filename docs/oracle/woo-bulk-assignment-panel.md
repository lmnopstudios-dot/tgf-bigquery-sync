# Woo → Shopify bulk assignment

Open **Product Mapping → Woo → Shopify · Bulk assign** after deployment.

1. Choose WW + USD or one store. The default **Unlinked products only** excludes saved assignments and unique automatic Shopify matches. Search a title, SKU or Woo product ID.
2. Select up to eight historical product rows. Source store and full Woo reference remain visible.
3. Choose a Shopify target on each row. Use **Choose Shopify target for selected** when several listings belong under the same Shopify product, such as its WW/USD versions or old size listings. For different products, choose separate targets per row.
4. Under **Action**, keep **Reporting family** for grouping distinct historical listings under a current Shopify parent. **Same product identity** is a separate, explicit choice with its own graph validation.
   For products with no current Shopify counterpart, choose **No current Shopify equivalent**. For uncertainty, choose **Needs investigation**. Both actions save the selected Woo references without a Shopify target or a mapping preview; any earlier target choice is omitted from the submitted decision.
5. Review the current allowed/blocked preview for a mapping action, then **Review & save selected**. The confirmation lists every source and target.
6. Inspect each saved, blocked or failed outcome. Successful rows remain saved if another is blocked. Refresh the queue to load current assignments or the next batch.

Suggestions never save themselves. Unique direct Woo-to-Shopify title/SKU matches have a separate **Automatic matches · not approved** filter; they remain reachable for review and are not counted as saved approvals or certified report-ready classifications. A Woo-to-Woo or Woo-to-Square match alone never removes a product from the unlinked queue. Ambiguous Shopify titles remain unlinked. **All Woo products** shows the full inventory. Saved rows disappear from Unlinked/Automatic matches immediately after a completed save; individual results remain in the batch receipt. No-equivalent outcomes are preserved; they remain read-only in this panel. Historical transactions are not deleted or excluded by a no-equivalent decision. Investigation decisions remain unresolved and available through the investigation filter. Saved assignments can be inspected using the status filter; their change/revoke controls remain in the existing history tabs.

If the response is interrupted, **Check saved batch** reads the same operation. The pending operation also survives browser refresh. It never automatically resubmits a POST. An unresolved operation blocks another save until its outcome is known.

## Scope and safeguards

The inventory uses the existing product-mapping service and historical order-line-backed product inventory. It is not an exhaustive archive of unsold deleted Woo listings. List pagination remains 25 rows; assignments remain bounded to eight per batch. Search and filters run before pagination. Square cannot enter this panel or its generated bulk payload; existing Square decisions remain separate.

Each save uses the existing authenticated, CSRF-protected bulk-review endpoint. It revalidates each row against current graph/family rules immediately before writing append-only decisions and operation receipts. The new panel does not carry global preview tokens across a batch, since the earlier row's decision changes that global state; server-side current validation is unchanged. Relationships that become blocked after preview remain blocked at save time.

No reporting SQL, resolver chronology, warehouse schema, collection, identity snapshot or production identity configuration changes are included. New assignments affect reporting only once explicitly saved by the reviewer. Merely opening the panel creates no approvals.

## Validation

Unit/service regressions cover inclusion of unsaved heuristic matches, WW/USD and status filters, pagination counts, exclusion of Square, explicit reviewed Shopify parent targets, duplicate/oversized batch rejection, and separate family/identity preview decisions.

The browser gate also covers target-free outcome selection, no-equivalent confirmation/save, removal from the default queue and read-only outcome history. It exercises desktop and mobile selection, Shopify-only search, shared target selection, blocked identity versus allowed family assignment, confirmed bulk submission, partial success, editable blocked rows, and same-operation recovery after refresh. Browser transport is mocked: this verifies UI behavior, not live production approval or warehouse execution.

Post-deployment check: open the panel, search an actual Woo product, confirm the source store/reference and Shopify suggestions, then preview a chosen target. Saving a mapping is a separate explicit review action; no production approvals were made while developing this feature.
