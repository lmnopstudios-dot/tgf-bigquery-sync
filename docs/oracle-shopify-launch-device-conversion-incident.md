# Oracle Shopify launch device conversion incident

## Demonstrated cause and repair

The completed Shopify conversion history stores the ShopifyQL `session_device_type` label without changing its case. Oracle's comparison helper previously filtered `device_type IN ('desktop','mobile')`, so persisted labels such as `Desktop` and `Mobile` were excluded even though the structural history validator correctly found every device day. The helper now applies `LOWER(TRIM(device_type))` in both its projection and filter. It reads only the physical device table and never allocates or infers device values from an all-device total.

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
* Every entry in both binding groups is declared `DATE`, has runtime constructor `BigQueryDate`, and contains the intended date value.
* `physical_rows` groups by the actual, case-preserved `persisted_device_label`; its normalized desktop and mobile groups each cover 56 distinct days and show sessions and completed-checkout sessions.
* `history_validation` has zero missing device days, duplicate device keys, impossible device funnels, missing source days, duplicate source keys, and device/source reconciliation failures.
* `comparison_helper.rows` contains desktop and mobile for the `after` period, each with 56 covered days and the same sessions and completed-checkout-session numerator as the corresponding normalized physical group.
* The before rows remain desktop `55,131 / 276` and mobile `140,465 / 846`, each covering 56 days.
* The helper's definitions are exactly `ecommerce purchases per session` before and `completed-checkout sessions per session` after; `cross_platform_percentage_point_difference` remains `null` and comparability remains `not_established`.
* If validation or either normalized physical device group establishes coverage while the exact helper returns no corresponding row, the command exits nonzero with `SHOPIFY_DEVICE_ORACLE_CONTRADICTION` instead of substituting an all-device result.

No acceptance step invokes `backfill:shopify-conversion`.
