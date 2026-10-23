# Reconcile existing Product Mapping approvals with retention

Continue draft #383. The supplied WW/USD discovery succeeded; do not repeat it or the completed denominator trace. No new relationship is proposed for approval here. The compact Iron Maiden/Motörhead rows omit decision history: `approved_route_present:false` from that diagnostic is not proof that the UI has no saved approval.

## Confirmed shared resolver defects

1. **Family current state:** the UI's `resolveFamilyDecisions` and shared `productFamilyCtes` select the newest non-superseded decision **per source product**. Classification SQL duplicated this logic with `PARTITION BY membership_id`. Legacy null membership IDs collapsed unrelated products; different historical memberships for one source could instead survive together and cause false ambiguity. Classification/reporting now uses `productFamilyCtes` directly, including current status and supersession.
2. **Legacy identity keys:** the UI uses a saved relationship ID or `relationshipId(left_ref,right_ref)`. SQL used a candidate ID as fallback, which could collapse unrelated approved relationships. SQL now derives the same sorted-endpoint SHA-256 key (one NUL byte separator, lowercase first 24 hex characters). Candidate IDs never define identity relationships.

These are verified source/fixture defects. Their causal contribution for the specific production products remains pending the narrow persisted-decision read below. A current UI decision is not written, revoked, changed or reapproved by this fix. Graph approval safeguards are unchanged. A reporting family remains a grouping/classification route, never a canonical identity edge.

## Exact subjects from successful discovery

| Iron Maiden ring | Woo WW | Woo USD | WW recorded / eligible orders | USD recorded / eligible orders |
|---|---:|---:|---:|---:|
| Powerslave Eddie | 11737 | 106660 | 56 / 54 | 4 / 4 |
| Piece of Mind Eddie | 11795 | 106592 | 26 / 25 | 7 / 7 |
| Killers Eddie | 23150 | 106354 | 19 / 19 | 7 / 7 |
| Book of Souls Eddie | 44905 | 106178 | 14 / 14 | 1 / 1 |

| Motörhead listing | Woo WW | Woo USD | WW recorded / eligible orders | USD recorded / eligible orders |
|---|---:|---:|---:|---:|
| Old Warpig Ring | 11549 | 106986 | 91 / 89 | 10 / 10 |
| Warpig Ring | 11593 | 106807 | 71 / 70 | 14 / 14 |
| Ace of Spades Ring | 11594 | 106800 | 29 / 29 | 10 / 9 |
| Warpig Pendant | 92837 | 108048 | 33 / 33 | 4 / 4 |
| Old Warpig Pendant | 11634 | 108303 | 3 / 3 | 1 / 1 |
| Ace of Spades Anniversary T-shirt | 80797 | 108623 | 5 / 3 | 0 / 0 |
| Bomber Anniversary Pendant | 60637 | 108175 | 0 / 0 | 0 / 0 |
| Ace Anniversary Pendant | 80795 | 108052 | 0 / 0 | 0 / 0 |

Counts are supplied discovery evidence, not a fresh order read, customer counts, certified coverage, or proof of no sales outside retained records. Titles describe the review subjects; they never establish a product relationship. Preserve original discovery jobs `a68390f8-1438-4581-ab4b-8c88233a293b` and `cf5bdbdf-15b0-4ce1-b08d-f112861bfe32`.

## Routing contract and remaining evidence

The report constructs Woo refs from **store + order-line parent product ID**. WW and USD never collapse on a numeric ID; persisted variation keys are inspected separately. A saved approval on a variation is not silently promoted to a parent. Shopify numeric product IDs and Product GIDs normalize only when reading classification/reporting routes; ProductVariant GIDs are not parent products. Persisted raw decision keys are resolved before normalization, matching the UI.

Current approved identity edges and active reporting families feed `cr_routes`; governed product/collection classifications feed `cr_resolved`, with conflicts excluded. The actual retention path consumes those classifications in `classified_lines`, then uses `retention_reporting_lines` and `entry_matches`. Family grouping preserves source identity and customer deduplication. No title matching, new transitive relationship, customer link or governance decision is introduced.

For each of the 24 parent refs (and their stored variation keys), the narrow read saves raw decision histories, current UI resolver results, current SQL decisions, normalized routes, resolved/conflicting classifications, and target classification evidence. Raw histories include same-relationship records and superseding pointers, with independent row-bound disclosure. It also reads same numeric keys across namespaces to expose incorrectly stored namespaces rather than conflating them. A second independent SELECT evaluates **deployed** classification SQL. Comparing these with corrected SQL distinguishes persisted approval, status/supersession, representation/namespace mismatch, variation-only approval, classification conflict and resolver consumption.

If a bounded history is truncated, no absence conclusion is supported. An active relationship lacking a consumed classification needs routing/classification investigation, not reapproval. If a route traverses other approved products, inspect those saved endpoints before proposing any change; this fix does not invent a closure. Only complete persisted evidence establishing that no valid relationship exists would justify a new graph-safe review candidate.

Production Google access remains blocked in this development environment (previous OAuth 403). The exact unresolved fact is **which current persisted UI decision and governed classification each supplied source ref resolves to, and how deployed versus corrected SQL consume it**. Discovery titles, age of the range and compact `approved_route_present` flags cannot answer that fact.

## Verification

`test/product-route-resolver.test.js` executes generated identity/family current-state SQL on local SQLite fixtures, compares it with the real UI pure resolvers, and verifies all three linked report shapes consume the shared reader. Fixtures cover all eight Iron Maiden refs, Motörhead in both stores, legacy null keys, replacement, revocation/supersession and preserved namespaces. Mock transport tests cover independent failures and row bounds.

`test/product-route-report-sql.py` executes the actual generated classification/family/entry CTEs and the exact narrow diagnostic against synthetic persisted histories using DuckDB/sqlglot translation. Ten WW/USD fixture products reach the expected collaboration and family/identity key; repeated size lines deduplicate; an unmapped other-store key and variation remain excluded. Run with `PYTHONPATH=/tmp/oracle-sql-tools python3 test/product-route-report-sql.py` after installing `duckdb==1.5.6 sqlglot==30.23.0` into that test dependency directory. This is local translated execution, **not BigQuery compilation or production acceptance**.

Historical live report and compilation successes remain evidence for their original artifacts. Shared resolver SQL intentionally changes all current report shapes, so historical compilation hashes are preserved but not claimed as validation of these new shapes. Rebuilt review/manifests match the new shared reader. Entry dates, snapshot, identity settings, provisional/verified denominator rules, exclusions and execution budgets remain unchanged. No report replay, collection or data/governance writes occur.
