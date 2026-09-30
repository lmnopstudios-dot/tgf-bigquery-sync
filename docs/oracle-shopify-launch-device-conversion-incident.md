# Oracle Shopify launch device conversion incident

## Reconcile storage before changing normalization

Do not infer another normalization defect from a filtered query. The diagnostic first inventories both physical Shopify tables without a date or device filter, reports monthly row/date counts, and then runs the exact launch window three ways: the validator's string-plus-declared-`DATE` binding, Oracle's `BigQueryDate`-plus-declared-`DATE` binding, and independently validated SQL `DATE` literals. It reports the runtime representation and value of every parameter as well as the configured project, dataset, tables, and metadata-derived location. Every query is read-only, dry-run first, and capped at 1 GB.

The validator now uses the same `BigQueryDate` runtime values as Oracle and fails closed if any required physical-integrity result is absent or nonnumeric. Acceptance is valid only when validation is complete, both physical tables contain every date in the 56-day window, and all three reads agree. The existing normalized Oracle projection remains in place, but normalization must not be changed again until this inventory identifies the failing layer.

The governed exact-question route fixes the two inclusive windows at 25 September–19 November 2025 and 20 November 2025–14 January 2026. Its deterministic response requires desktop and mobile rows with all 56 covered days in both periods. It labels the two different measures `ecommerce purchases per session` and `completed-checkout sessions per session`, and refuses to emit a cross-platform percentage-point change because comparability is not established.

## Confirmed NULL-date root cause and first read-only Render command

The collection path was correct through ShopifyQL (`GROUP BY day`), GraphQL `tableData.columns/rows` decoding, and normalization to the ISO `date` string. The loss occurred at the final BigQuery array-parameter boundary: rows supplied a JavaScript string while the nested struct field was declared `DATE`. Unlike the project's proven scalar date path, the writer did not wrap each row value with `BigQuery.date(...)`. Production consequently contains 1,125 device rows and 4,085 device/source rows whose physical `date` is NULL.

The writer now validates the raw ShopifyQL day as a real calendar date, validates its requested range, and binds every staged row date as `BigQueryDate`. Promotion assertions run inside the same transaction as both table replacements. New tables declare `date DATE NOT NULL`; every application promotion also rejects a staged or destination NULL date.

Run this first in a Render Shell after deployment:

```sh
timeout 120s npm run backfill:shopify-conversion -- --mode probe --start 2025-11-20 --end 2025-11-26 --chunk-days 7 --max-chunks 1 --max-sources 40 --timezone Europe/London
```

This performs one bounded device-grain ShopifyQL read and creates no BigQuery client, schema, staging table, or write. Its JSON must say `read_only: true`, show range `2025-11-20`–`2025-11-26`, a nonzero `row_count`, and seven distinct entries whose `shopifyql_day` equals `normalized_date`. It emits no customer field and never queries or prints `referrer_source`. Stop if any date is missing, invalid, or outside the chunk.

After deploying, run the rollback diagnostic over the same seven-day scope:

```sh
timeout 180s npm run backfill:shopify-conversion -- --mode diagnose --start 2025-11-20 --end 2025-11-26 --chunk-days 7 --max-chunks 1 --max-sources 40 --expected-null-device 1125 --expected-null-source 4085 --timezone Europe/London
```

Both its schema query and diagnostic script are capped at 100 MiB (104,857,600 bytes). The script exercises the replacement and captures bounded aggregate/difference evidence, but explicitly rolls back before returning it. This diagnostic does not repair the tables, and a successful run does not establish that the underlying stored-total mismatch is fixed.

## Transactional pilot and bounded resume

Only after the probe passes, run the one-chunk pilot. The two expected counts are deliberate guards: the transaction aborts rather than deleting anything if the physical NULL population has changed. In the same transaction it removes exactly the known NULL-date contamination, replaces both tables for the pilot, rejects duplicate keys or any remaining NULL, and compares the ShopifyQL device session/funnel totals with the stored pilot totals.

```sh
timeout 180s npm run backfill:shopify-conversion -- --mode repair --start 2025-11-20 --end 2025-11-26 --chunk-days 7 --max-chunks 1 --max-sources 40 --expected-null-device 1125 --expected-null-source 4085 --timezone Europe/London
timeout 120s npm run validate:conversion-history -- --start 2025-11-20 --end 2025-11-26
```

The pilot is accepted only when it commits one chunk, the validator reports zero NULL dates and duplicate keys, seven independently counted physical dates in each table, nonempty filtered populations, zero device/source funnel mismatch, and `acceptance.valid: true`. The first exact resume invocation is:

```sh
timeout 300s npm run backfill:shopify-conversion -- --mode repair --start 2025-11-20 --end 2026-09-27 --resume-after 2025-11-26 --chunk-days 7 --max-chunks 4 --max-sources 40 --timezone Europe/London
```

Each invocation is capped at four seven-day chunks. Run only the exact `next_command` printed by a successful invocation (optionally retaining the shell `timeout 300s` prefix); this advances `--resume-after` without overlap and ends with the shorter final chunk. Never restore the NULL rows or use an unscoped delete.

Completion may be claimed only after the final whole-range, read-only validation:

```sh
timeout 120s npm run validate:conversion-history -- --start 2025-11-20 --end 2026-09-27
```

It must report whole-table `null_device_dates: 0` and `null_source_dates: 0`, 312 physical days and nonempty populations in both tables, no duplicate keys, no funnel/source mismatch, `decision: REPORTABLE`, and `acceptance.valid: true`.

## Production acceptance criteria

The command must exit zero and report all of the following:

* `read_only: true`; the before range is `2025-09-25`–`2025-11-19`, the after range is `2025-11-20`–`2026-01-14`, and `expected_days_per_period` is 56.
* `storage` identifies the production project, `shopify_data` and its metadata-derived location, plus the configured GA4 dataset and its independently derived location.
* `storage_inventory.unfiltered` gives `first_date`, `last_date`, `row_count`, and `distinct_date_count` for both physical tables, while `monthly` identifies the month in which a gap or alternate write range occurred.
* The three `storage_inventory.exact_56_day_window` result sets agree: each table has 56 distinct dates, its minimum is `2025-11-20`, and its maximum is `2026-01-14`. The corresponding determination is `RECONCILED`.
* The reconciliation's validator parameters are declared `DATE` runtime strings, Oracle's are declared `DATE` values with runtime constructor `BigQueryDate`, and both contain the intended values; the independent query has no parameters and displays its typed `DATE` literals.
* `physical_rows` groups by the actual, case-preserved `persisted_device_label`; its normalized desktop and mobile groups each cover 56 distinct days and show sessions and completed-checkout sessions.
* `history_validation` has zero missing device days, duplicate device keys, impossible device funnels, missing source days, duplicate source keys, and device/source reconciliation failures.
* `comparison_helper.rows` contains desktop and mobile for the `after` period, each with 56 covered days and the same sessions and completed-checkout-session numerator as the corresponding normalized physical group.
* The before rows remain desktop `55,131 / 276` and mobile `140,465 / 846`, each covering 56 days.
* The helper's definitions are exactly `ecommerce purchases per session` before and `completed-checkout sessions per session` after; `cross_platform_percentage_point_difference` remains `null` and comparability remains `not_established`.
* If validation or either normalized physical device group establishes coverage while the exact helper returns no corresponding row, the command preserves the complete inventory, reports `ORACLE_FILTER_CONTRADICTION` and the affected devices, and exits nonzero instead of substituting an all-device result.

If the expected reconciliation is not obtained, stop without writing data. `PHYSICAL_GAP_OR_DIFFERENT_BACKFILL_TARGET` means the configured physical tables genuinely do not contain all 56 dates (the unfiltered/monthly inventory distinguishes an incomplete range from a likely different target); `DATE_BINDING_CONTRADICTION` means the validator and Oracle parameter representations disagree with literal dates; and `ORACLE_FILTER_CONTRADICTION` means physical and binding reads agree but the helper filters the rows out. Only the first result, corroborated against the intended backfill target, can justify planning another backfill.

The repair does not read or write Woo GA4 history or mappings.
