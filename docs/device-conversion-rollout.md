# Governed device conversion rollout

WooCommerce sessions and `ecommercePurchases` are requested in separate compatible GA4 Data API reports and joined only when their observed dimension-key sets are identical. The published measure remains **purchases per session** (`ecommercePurchases / sessions`), never “session conversion rate”. Numerator coverage is disclosed in `conversion_coverage`; an omitted purchase key is not inferred to mean zero, and an unavailable device-grain numerator produces no device rate. `totalPurchasers` is probed separately but is not the purchase numerator.

The device × channel × source × medium report is separately validated on its own grain. Pagination must reach the API `rowCount`, requested dimensions and metrics must pass GA4 compatibility, keys/dates/values must be valid, and metadata is inspected for thresholding and `(other)` data loss. `(other)`, missing dimension values, thresholds, or a row limit make source attribution `limited`; those rows are not published as complete attribution. A difference from the independent HLL++ date total alone does not.

## Production gate and commands

Run this **first on Render**. It is a read-only GA4 Data API pilot for one Woo date (at most four 1,000-row reports) and performs no BigQuery writes:

```sh
npm run diagnose:ga4-purchase-compatibility -- --dates 2022-08-18
```

The ten production-shaped probe dates are 2022-08-18, 2023-02-15, 2023-08-17, 2023-11-24, 2024-02-15, 2024-08-15, 2024-11-29, 2025-02-13, 2025-08-14, and 2025-11-19. Review signed differences in both directions as diagnostics, plus pagination and API limitation metadata; do not require an exact match.

The governed public launch remains **20 November 2025**: Woo reporting ends 19 November and the existing Shopify-native pilot begins 20 November. The first native order on 16 November is pre-launch source evidence, not a public-launch session. The two historical aggregate tables must not inherit the dataset's partition retention. This narrowly scoped command changes only those two existing tables (not the dataset and not unrelated tables):

```sh
npm run retention:shopify-conversion -- --project gf-full-data
```

Then run the read-only production verification. It reports `partition_expiration_days` independently from `table_expiration_timestamp`, as well as the oldest and newest surviving partitions. Both rows must say `historical_partitions_retained: true`; table expiration must be reviewed separately and must not be mistaken for partition retention:

```sh
npm run verify:shopify-conversion-retention -- --project gf-full-data
```

Changing retention does **not** restore partitions that already expired. Before any write, use the rollback diagnostic below. It executes the replacement transaction and explicitly rolls it back, while exposing staged-versus-stored totals:

```sh
npm run backfill:shopify-conversion -- --mode diagnose --start 2025-11-20 --end 2025-11-26 --chunk-days 7 --max-chunks 1 --max-sources 40 --timezone Europe/London --project gf-full-data
```

Only when the diagnostic's staged and stored totals reconcile, run the seven-day repair pilot and then its read-only validation:

```sh
npm run backfill:shopify-conversion -- --mode repair --start 2025-11-20 --end 2025-11-26 --chunk-days 7 --max-chunks 1 --max-sources 40 --timezone Europe/London --project gf-full-data
npm run validate:conversion-history -- --start 2025-11-20 --end 2025-11-26 --project gf-full-data
```

The repair readiness gate fails closed when either requested historical partition would immediately expire. Schema creation also explicitly disables partition expiration for these two tables. Strict staged/stored reconciliation, typed `DATE`/`TIMESTAMP` parameters, atomic replacement, and expected-count-guarded NULL cleanup remain mandatory.

Only after a real device-level purchase report succeeds (or GA4 explicitly marks it incompatible), consider the bounded GA4 backfill. Do not resume it while the compatibility response is malformed or ambiguous:

```sh
npm run backfill:ga4 -- --start 2022-08-18 --end 2025-11-19 --chunk-days 31 --max-chunks 3
```

Every invocation prints `resume_after`. The exact safe resume form is:

```sh
npm run backfill:ga4 -- --start 2022-08-18 --end 2025-11-19 --resume-after 2022-11-18 --chunk-days 31 --max-chunks 3
```

The explicit command above is the safe resume after all three documented initial chunks commit (`resume_after: 2022-11-18`). If fewer chunks commit, instead use the exact committed `resume_after` value printed by that invocation; never substitute the failed chunk end. Each chunk transactionally replaces stable date × device or date × device × channel × source × medium keys. `processed_with_limited_attribution` means the valid device-grain data was committed while a finer attribution grain was not represented as complete.

After each completed backfill run:

```sh
npm run validate:ga4 -- --start 2022-08-18 --end 2025-11-19
npm test
```

The Oracle may return Woo device purchases per session when all requested days have a valid device-grain report, regardless of the independently queried date-total difference. Traffic-source results require all requested days to be reportable at that finer grain; otherwise rates are null and limitations are disclosed. Shopify continues to use its native `sessions_that_completed_checkout / sessions` measure, shown side by side without a cross-platform percentage-point claim.
