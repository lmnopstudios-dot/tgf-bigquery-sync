# Named collaboration coverage: diagnosis and acceptance

Baseline: origin/main `11dd04173b4c8c509bfb264aa28d7a1274e21b55`, merged PR #337. Its SQL, typed DATE parameters, completed-day scope and independent providers remain intact. No source, classification, mapping, collection or customer records are mutated.

## Production evidence supplied by the operator

Request `0c42b2a8-b5d3-4973-bc77-fabd02788011`, as of 2026-10-19T12:00:00Z. All providers bound, invoked, SQL-verified and fulfilled.

| Source | First customers | Named | Generic only | Unknown | Identified orders | Anonymous orders | Observed history |
|---|---:|---:|---:|---:|---:|---:|---|
| Woo WW | 3501 | 0 | 0 | 3501 | 14165 | 25011 | 2021-03-25–2025-11-20 |
| Woo USD | 672 | 0 | 0 | 672 | 1547 | 2775 | 2022-04-02–2025-11-19 |
| Shopify | 8365 | 7 | 708 | 7650 | 12230 | 2718 | 2025-11-16–2026-10-18 |

Shopify also returned 2158 migrated and 55 cancelled orders, and four classified retention rows. These establish successful reads and limited classification coverage, not the cause of every unmatched line. Anonymous shares among those observed orders are approximately 63.85%, 64.20% and 18.18%, respectively; these are stored-ID coverage, not a count of real people.

## Demonstrated code defects and shared fixes

The old cohort and category readers consulted only materialized `commerce.product_classifications`. Approved `commerce.collection_classifications` could therefore exist without being consumed until a classification sync materialized them. Running a sync would be a mutation and is not necessary for the repaired reader. The shared read-only resolver now joins current approved collection decisions to persisted `shopify_catalogue.product_collections`, resolves product decisions and approved identity/reporting-family routes, and returns evidence to customer journey, category sales and stock-group resolution. Collection names qualify as explicit named classifications; an `other` group never implies core range. Generic collaboration labels remain separate from named labels.

Collection decisions are append-only: filtering `status='active'` before resolving the latest decision can resurrect revoked names. Product supersession, explicit conflict rows, disagreeing active values and named/core contradictions must also survive resolution. Readers now exclude those ambiguous classifications. Cached collection and canonical propagation rows are re-derived from current collection membership and approved routes rather than trusted after their support is revoked. Other direct governed product classifications remain available.

Only Shopify Product GIDs and numeric parent IDs are equivalent representations. ProductVariant GIDs are rejected as parents. Woo WW and USD numeric IDs remain separate. An approved identity edge followed by an approved reporting-family route can carry classification to historical products; a reporting family does not become customer or product identity. No title, fuzzy match, current publication status or speculative customer linkage is used.

These are demonstrated consumption defects, verified on synthetic relational fixtures. **Their numerical contribution to the supplied production gaps remains unverified.** No new approved classification or mapping has been invented. An absent result is still unknown, never implicitly core.

## Coverage and remaining evidence

The provider returns first-order product-stage counts and customer counts for `product_identity_unmatched`, `classification_absent`, `generic_only`, `named`, `conflicting`, and `core`. Counts of customers can overlap on mixed orders. Missing/invalid source product keys are unmatched; a valid historical source key with no governed label is classification-absent. This does not certify a surviving catalogue record. A separate Shopify catalogue check measures historical lines whose current product is missing. Not attempted/retrieval failed states remain in the independent source outcome contract.

`gaps` returns at most 100 existing source product references, their explicit gap reason, first-customer/product-line impact and presence of an approved route. It contains no customer identifiers or titles. This is the reviewable classification-gap report, not a proposal to classify those products. `keys` returns at most 100 grouped raw product and collection classification values/provenances/statuses and source namespaces, including non-active history. Their bounds are explicit; neither is a complete inventory.

Customer identity inspection traced the existing rules: Metorik orders store `customer_id`; Metorik customer records separately contain `metorik_customer_id`, which must not silently replace Woo IDs. Shopify recovery stores `customer.id` and `is_guest` in `order_customers`; cohort reads join that table by order ID. Null, empty and zero IDs are excluded under existing governance. The new aggregate distinguishes missing joined customer records, stored guest flags and numeric/GID/other representations. Production shares attributable to guests versus missing records remain unresolved; no collection/backfill is performed.

The Shopify start on 2025-11-16 is preserved. The November history check groups observed dates by migration/cancellation/status and reports identified and eligible-status orders. Existing Matrixify app exclusions, cancellations and full-refund rules are retained. No nominal launch date is imposed. Synthetic SQL fixtures verify legitimate 2025-11-16 purchases enter cohorts and known Matrixify orders do not; actual import provenance and continuity still require the production check.

## Exact bounded Render commands

Run on the PR revision in Render with its existing warehouse credentials. Each command is read-only, uses a 20 GB billing cap, and is bounded independently. `--execute` follows a dry run; omit it for SQL/schema verification only. None invokes setup, sync, collections, inventory, source writes or knowledge writes.

```bash
# Existing provider factory: source-specific mature 90/180-day cohort rows,
# ranking, sample sizes and coverage. Source identities remain separate.
timeout 110s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --execute

# Separate supported channels, with source-specific identities.
timeout 110s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --channel=Online --execute
timeout 110s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --channel=In-store --execute

# Per source/store, run each unresolved stage independently.
for pair in woo:ww woo:usd shopify:shopify; do
  source=${pair%:*}
  store=${pair#*:}
  for stage in stages keys gaps identity history; do
    timeout 40s node diagnostics/oracle-classification-coverage.js \
      --as-of=2026-10-19T12:00:00Z --source="$source" --store="$store" \
      --stage="$stage" --execute
  done
done

# Missing current Shopify products among eligible historical order lines.
timeout 40s node diagnostics/oracle-classification-coverage.js \
  --as-of=2026-10-19T12:00:00Z --source=shopify --store=shopify \
  --stage=catalogue --execute
```

Channel-filtered cohorts select customers whose first observed source purchase was in that channel and measure subsequent purchases in that same channel; they are not first-in-channel cohorts for previously observed customers. Woo In-store and Square remain explicitly unsupported.

Provider output now includes actual source-specific retention rows, not just row counts. Named cohorts rank on mature 90-day rates with secondary 180-day results. Generic buckets never compete. First-observed versus first-ever limitations, current versus purchase-time classification, small samples, source currencies, Square exclusion and unsupported combined customer linkage remain explicit. There is no verified production winner in this change.

## Verification

The normal Node regression suite uses the real provider factory and bounded query options. The relational fixture check additionally executes the generated BigQuery SQL after dialect translation to DuckDB. It asserts actual collection/identity/family joins, supersession, namespace separation, invalid variants, conflicts, missing historical keys, customer membership, stage counts and independently specified retention numerators/denominators. Translation does not verify BigQuery execution.

```bash
node --test test/classification-reader.test.js test/category-sales.test.js \
  test/oracle-cohort-retention.test.js test/oracle-cohort-providers.test.js \
  test/product-classification.test.js test/oracle-current-stock.test.js
python -m pip install --target /tmp/oracle-sql-tools duckdb==1.5.6 sqlglot==30.23.0
PYTHONPATH=/tmp/oracle-sql-tools python test/classification-reader-sql.py
npm run test:oracle:acceptance
npm run test:oracle:browser
npm test
```

In this workspace production authentication returned HTTP 403 from `oauth2.googleapis.com` on the bounded retry. This is a local verification limitation, not evidence that the successful production providers are unavailable. Production stage counts, the classification-gap report and named ranking must be read from the Render output above. No merge or deployment was performed.

Acceptance question: **Which named collaborations have the highest mature 90-day repeat-purchase rate, separately for Woo WW, Woo USD and Shopify, and what classification coverage supports each ranking?**

Synthetic relational first-order coverage (nine eligible identified customers): three named product matches, two classification-absent, one generic-only, two conflicting and one unmatched product key. Alpha's 90-day result is 1/1 mature customers (two entries including one immature); beta is 0/1 at 90 days and 1/1 at 180 days. These values are fixture expectations, not production estimates.
