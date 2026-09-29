# Oracle Shopify launch device conversion incident

## Reconcile storage before changing normalization

Do not infer another normalization defect from a filtered query. The diagnostic first inventories both physical Shopify tables without a date or device filter, reports monthly row/date counts, and then runs the exact launch window three ways: the validator's string-plus-declared-`DATE` binding, Oracle's `BigQueryDate`-plus-declared-`DATE` binding, and independently validated SQL `DATE` literals. It reports the runtime representation and value of every parameter as well as the configured project, dataset, tables, and metadata-derived location. Every query is read-only, dry-run first, and capped at 1 GB.

The validator now uses the same `BigQueryDate` runtime values as Oracle and fails closed if any required physical-integrity result is absent or nonnumeric. Acceptance is valid only when validation is complete, both physical tables contain every date in the 56-day window, and all three reads agree. The existing normalized Oracle projection remains in place, but normalization must not be changed again until this inventory identifies the failing layer.

The governed exact-question route fixes the two inclusive windows at 25 September–19 November 2025 and 20 November 2025–14 January 2026. Its deterministic response requires desktop and mobile rows with all 56 covered days in both periods. It labels the two different measures `ecommerce purchases per session` and `completed-checkout sessions per session`, and refuses to emit a cross-platform percentage-point change because comparability is not established.

## First read-only Render command

Run this first in a Render Shell after deployment:

```sh
timeout 120s npm run diagnose:oracle-shopify-launch-device-conversion
```

The command is bounded to the exact 56-day post-launch interval, uses a 1 GB cap per query, dry-runs every diagnostic and Oracle-helper query before executing it, and performs no writes. **Do not rerun the completed Shopify backfill.**

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

No acceptance step invokes `backfill:shopify-conversion`.
