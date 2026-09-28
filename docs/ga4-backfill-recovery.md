# GA4 historical backfill recovery

The confirmed public launch boundary remains **20 November 2025**: WooCommerce reporting ends on 19 November 2025 and Shopify reporting starts on 20 November 2025.

First run this bounded, read-only command in a Render Shell. It reads one day from the GA4 Data API and does not read or mutate BigQuery:

```sh
npm run diagnose:ga4-session-reconciliation -- --date 2022-08-18
```

The diagnostic labels the exact sources of every total. It probes date, date × device, date × device × channel, and date × device × channel × source × medium with separate fresh GA4 API requests—not an old `ga4.daily` BigQuery row. For the production-shaped 18 August case, 364 sessions reconcile through device × channel and the detailed source/medium grain returns 363: the session disappears when source and medium are added. It also reports row counts, unknown dimensions, the property reporting timezone, thresholding/data-loss metadata, quota metadata, and whether the 100,000-row bound was reached.

The sync obtains session denominators from sessions-only reports and ecommerce purchases and purchasers separately. It records observed and expected totals plus `reportable`/`incomplete` status for device, device × channel, and source detail. A reconciled device aggregate is persisted for Woo desktop-versus-mobile answers; a non-reconciling source breakdown is not persisted or exposed. No unknown session is invented and no equality check is relaxed.

Because the failed first chunk did not reach the coordinated BigQuery promotion transaction, resume safely from the day before coverage begins:

```sh
npm run backfill:ga4 -- --start 2022-08-18 --end 2025-11-19 --resume-after 2022-08-17 --chunk-days 31 --max-chunks 3
```

On any later failure, use the emitted `next_command`. The failure JSON explicitly lists `committed_chunks` and `earlier_chunks_committed`; the failed chunk itself is never partially promoted.
