# Governed device conversion rollout

WooCommerce device evidence is taken directly from one compatible GA4 Data API report containing `date × deviceCategory × sessions × ecommercePurchases × totalPurchasers`. The published measure is **purchases per session** (`ecommercePurchases / sessions`), never “session conversion rate”. Sessions are HLL++ approximate distinct counts: an independently queried date total can differ after dimensions are added. Its total and signed difference remain a diagnostic; equality is not a gate and no balancing session is allocated or invented.

The device × channel × source × medium report is separately validated on its own grain. Pagination must reach the API `rowCount`, requested dimensions and metrics must pass GA4 compatibility, keys/dates/values must be valid, and metadata is inspected for thresholding and `(other)` data loss. `(other)`, missing dimension values, thresholds, or a row limit make source attribution `limited`; those rows are not published as complete attribution. A difference from the independent HLL++ date total alone does not.

## Production gate and commands

Run this **first on Render**. It is a read-only GA4 Data API pilot (at most 24 dates and 100,000 rows per report) and performs no BigQuery writes:

```sh
npm run diagnose:ga4-device-coverage
```

The ten production-shaped probe dates are 2022-08-18, 2023-02-15, 2023-08-17, 2023-11-24, 2024-02-15, 2024-08-15, 2024-11-29, 2025-02-13, 2025-08-14, and 2025-11-19. Review signed differences in both directions as diagnostics, plus pagination and API limitation metadata; do not require an exact match.

The governed public launch remains **20 November 2025**: Woo reporting ends 19 November and the existing Shopify-native pilot begins 20 November. The first native order on 16 November is pre-launch source evidence, not a public-launch session. Run the existing Shopify pilot unchanged:

```sh
npm run diagnose:conversion-evidence
npm run diagnose:ga4-shopify-transition
npm run backfill:shopify-conversion -- --start 2025-11-20 --end 2025-11-26 --chunk-days 7 --max-chunks 1 --max-sources 40 --timezone Europe/London
npm run validate:conversion-history -- --start 2025-11-20 --end 2025-11-26
```

Then run the bounded GA4 backfill:

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
