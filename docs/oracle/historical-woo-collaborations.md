# Historical Woo collaboration classification

Product Classifications → Historical Woo collaborations assigns Woo WW/USD products directly to a reviewed named collaboration. A Shopify equivalent is not required. This is a product classification, separate from product identity, reporting families and customer identity.

## Use

1. Choose Woo WW, Woo USD or both. The initial list is products marked **No current Shopify equivalent**; choose **All historical Woo products** to classify other products.
2. Search, review the exact source product references and existing direct/inherited evidence, then select up to eight products.
3. Choose a reviewed collaboration and **Assign collaboration**. The confirmation identifies every selected source reference and the existing direct assignment.
4. Read each saved or blocked outcome. Refresh before resolving changed or contradictory evidence. Use **Remove direct assignment** only to remove the displayed direct human collaboration; inherited mappings remain separate.

The generic Collaborations collection is excluded from choices. Names come from active collection governance, never product-title inference. Saving writes both `product_group=collaboration` and the reviewed `collaboration_name` to the existing product classification table. The existing report reader consumes those source-qualified classifications. Thus an old Woo-only collaboration purchase can enter a named cohort, and its linked later Shopify purchase can count as a return under the report's existing eligibility and identity rules.

## Audit and recovery

Changes append new decisions and revocation records, preserving prior history. Each batch has an immutable operation ID, reviewer, exact source references and reviewed collection revision. Classification revisions are checked again before saving; changed rows and contradictory inherited names/core classifications are blocked independently. Distinct simultaneous submissions can still produce conflicting evidence; existing report conflict rules remain in force.

If a response is interrupted, **Check saved batch** reads that operation. Browser refresh also checks its saved operation ID. It never automatically repeats a POST. **Retry original save** explicitly resubmits the same request; stable decision IDs and recorded receipts prevent duplicate application. An operation belongs to its original reviewer. Do not clear pending browser state until its outcome is established.

Listings are paginated at 25 products, saves at eight. Classification reads stop above 1,000 records and fail closed. Warehouse requests have a 15-second server limit and 1 GB billing ceiling. A save uses one catalogue inventory read and batches classification inserts and operation receipts, rather than writing each product separately.

## Validation and limits

Service and authenticated HTTP regressions cover direct assignment without an equivalent, changes/removal, partial conflicts, stale revisions, ownership, lost acknowledgements, explicit retries and preservation of existing mappings/outcomes. Desktop/mobile browser tests exercise the real service against a fixture warehouse through interrupted-save recovery, change and removal.

`PYTHONPATH=/tmp/oracle-collab-sql python3 test/historical-collaboration-sql.py` executes translated generated classification/report CTEs against fixtures: two Woo entries, later Shopify returns, all 90/180/360-day windows, no product-equivalence routes, and no fabricated verified coverage. Its Python dependencies are DuckDB and sqlglot. This is local SQL verification, not native BigQuery execution.

Required release gates: `npm run test:oracle:acceptance` and `npm run test:oracle:browser`. Production BigQuery execution and the deployed UI remain to be verified after release. No saved report, snapshot, collection or production governance data is changed by developing or testing this feature.
