# GA4 historical backfill recovery

The confirmed public launch boundary remains **20 November 2025**: WooCommerce reporting ends on 19 November 2025 and Shopify reporting starts on 20 November 2025.

First run this bounded, read-only command in a Render Shell. It reads one day from the GA4 Data API and does not read or mutate BigQuery:

```sh
npm run diagnose:ga4-session-reconciliation -- --date 2022-08-18
```

The diagnostic labels the exact sources of both totals. Collection-time reconciliation compares two fresh GA4 API responses—not an old `ga4.daily` BigQuery row. It also reports breakdown row counts, unknown dimensions, the property reporting timezone, thresholding/data-loss metadata, quota metadata, and whether the 100,000-row bound was reached.

The historical discrepancy was caused by requesting session-scoped `sessions` together with ecommerce metrics at a mixed metric scope. The sync now obtains the dimensional session denominator from a sessions-only report and obtains ecommerce purchases and purchasers separately. It unions the dimension keys, so ecommerce-only rows are retained and no sessions are inferred from purchase events.

Because the failed first chunk did not reach the coordinated BigQuery promotion transaction, resume safely from the day before coverage begins:

```sh
npm run backfill:ga4 -- --start 2022-08-18 --end 2025-11-19 --resume-after 2022-08-17 --chunk-days 31 --max-chunks 3
```

On any later failure, use the emitted `next_command`. The failure JSON explicitly lists `committed_chunks` and `earlier_chunks_committed`; the failed chunk itself is never partially promoted.
