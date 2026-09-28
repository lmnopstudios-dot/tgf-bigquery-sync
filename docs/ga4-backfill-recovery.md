# GA4 historical backfill recovery

The confirmed public launch boundary remains **20 November 2025**: WooCommerce reporting ends on 19 November 2025 and Shopify reporting starts on 20 November 2025.

First run this bounded, read-only command in a Render Shell. It reads one day from the GA4 Data API and does not read or mutate BigQuery:

```sh
npm run diagnose:ga4-session-reconciliation -- --date 2022-08-18
```

The diagnostic labels the exact sources of every total. It probes date, date × device, date × device × channel, and date × device × channel × source × medium with separate fresh GA4 API requests—not an old `ga4.daily` BigQuery row. Fresh production results for 18 August are 364 at date and 363 at device, device × channel, and device × channel × source × medium. The first non-reconciling grain is therefore **device**, and the highest reconciling grain is **date**. The missing session must never be assigned to a device or source. It also reports row counts, unknown dimensions, the property reporting timezone, thresholding/data-loss metadata, quota metadata, and whether the 100,000-row bound was reached.

The sync obtains session denominators from sessions-only reports and ecommerce purchases and purchasers separately. It records observed and expected totals, a reason, and `reportable`/`incomplete` status for device, device × channel, and source detail. On 18 August all three dimensional grains are incomplete, so neither device conversion nor source rows are persisted. No unknown session is invented and no equality check is relaxed.

Before a full backfill, run `npm run diagnose:ga4-device-coverage`. This bounded read-only probe samples 10 seasonally spread Woo-era dates, emphasizing 2023–2025, and reports the device reconciliation rate and excluded dates. Sample evidence never makes an unvalidated date reportable.

Because the failed first chunk did not reach the coordinated BigQuery promotion transaction, resume safely from the day before coverage begins:

```sh
npm run backfill:ga4 -- --start 2022-08-18 --end 2025-11-19 --resume-after 2022-08-17 --chunk-days 31 --max-chunks 3
```

An incomplete date is successfully **processed with incomplete coverage**, not fully reportable. Its daily and coverage evidence is promoted atomically, unsupported conversion rows are absent, later dates continue, and the resume cursor advances past it. On any later operational failure, use the emitted `next_command`; it does not repeatedly stop on 18 August. The failure JSON explicitly lists `committed_chunks` and `earlier_chunks_committed`; the failed chunk itself is never partially promoted.
