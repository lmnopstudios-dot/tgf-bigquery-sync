# Targeted SQL follow-up after #377

Merged #377 is `8ad4f23`. The supplied live validation reports eleven successful full SELECT compilations, with combined collaboration failing `Unclosed raw string literal` at 201:108 and synthetic execution failing WHERE-without-FROM at 4:97. Those eleven successes remain supplied production evidence, not newly executed checks here.

## Confirmed causes and changes

The exact merged combined collaboration SQL reproduces this corrupt expression at line 201:

```sql
REGEXP_EXTRACT(CAST(pc.product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)(p.second_order_products,[])
```

`combinedRetentionSql` inserted source-specific catalogue SQL through the string form of JavaScript `replace`. Its raw regex contains `$'`, which JavaScript substitutes with the unmatched suffix of the original SQL. This is SQL-text corruption before submission, not a coverage or identity failure. Use a replacement callback so the catalogue is inserted literally. Regressions assert that every source-specific catalogue SQL block survives intact, including regex end anchors.

The synthetic empty `cr_identity` relation at line 4 was:

```sql
SELECT CAST(NULL AS STRING) source_ref,CAST(NULL AS STRING) classification_ref WHERE FALSE
```

BigQuery rejects WHERE without FROM. Use the same typed columns over `FROM UNNEST(ARRAY<INT64>[])`, an empty relation with an explicit FROM. All twelve source/combined synthetic shapes share this fixture, so all twelve synthetic executions need revalidation. This is test input SQL, not a production transaction population change.

A manifest freezes hashes of the eleven successful full SELECT query texts from merged #377. Tests compare current generated SQL against every hash: all eleven remain byte-for-byte unchanged. Their successful compilation evidence is preserved; the targeted checker does not resubmit them.

No aggregation, output schema, identity configuration/snapshot, classification, eligibility, imported-order exclusion or follow-up coverage rule changes. No production data changes or automatic report replay.

## Verification

The exact regressions and targeted-check transport tests pass locally. The transport tests are mocked and are not BigQuery validation. A real dry-run attempt for the corrected generated combined linked SELECT was blocked before compilation by OAuth 403, `Could not refresh access token: Domain forbidden`. No corrected live compilation or execution is claimed yet.

The required acceptance and desktop/mobile browser gates are recorded below when complete.

## Targeted revalidation after deployment

Run this single command from the Render service's `project/src` directory after this fix is deployed. It uses deployed BigQuery dependencies and an immutable, hash-checked SQL artifact. It performs exactly one full linked SELECT dry run (the failed combined collaboration shape) and twelve table-free synthetic executions/result validations. Production population SELECTs and scripts are never executed. No report/provider invocation, retained-error retrieval, mapping inventory, collection or data writes occur.

Planning has one diagnostic allowance of 180 seconds; each synthetic execution has 15 seconds and the shared diagnostic deadline is 390 seconds. Production time/byte limits are unchanged. Independent results are emitted as they complete. A timeout remains unresolved and requires planning-complexity investigation, not a further automatic timeout extension.

Pass criteria: one `compiled` planning result, twelve `executed_and_validated` synthetic results, and `other_full_selects_resubmitted: 0`. Compilation is not production execution; synthetic success does not certify production coverage. Do not replay the report as part of this check.

<!-- PINNED_COMMAND -->
