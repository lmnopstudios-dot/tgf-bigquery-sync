# Oracle Woo-era device conversion incident

## Production request path

The governed path recognizes a request containing desktop, mobile, GA4, purchases per session, and exactly two dates. It resolves the acceptance question to the inclusive range `2024-11-20`–`2025-11-19` (365 days), selects `get_woocommerce_device_conversion`, and passes `start_date=2024-11-20` and `end_date=2025-11-19`.

The tool uses `GOOGLE_PROJECT_ID` (default `gf-full-data`), `GA4_DATASET` (default `ga4`), and the dataset's metadata-derived location (EU fallback). Its bounded queries use typed `DATE` parameters, a 1 GB maximum-bytes limit, `conversion_coverage` at `grain='device'`, and only `status='reportable'` dates when aggregating `conversion_device`. Device values are trimmed and case-normalized before the desktop/mobile filter. The result validator checks the resolved range, expected day count, coverage bounds, both required devices on a complete range, each device's day count, and finite aggregate values before deterministic answer synthesis.

The incident path had no validation between the aggregate DTO and free-form model synthesis capable of preventing the contradiction “persisted reportable days” → “no covered days.” The aggregate also used an independently correlated status predicate and an exact case-sensitive device filter. The repaired path uses one explicit coverage join with normalized devices, exposes the resolved storage contract, and fails closed if coverage says dates are reportable but the aggregate returns no rows. It never relabels that inconsistency as missing coverage.

## First post-deployment check (read only)

Run this once in a Render Shell. It performs a dry run, bounded read-only persisted-state query, and the same service helper invoked by Oracle; it does not run a backfill or write data.

```sh
npm run diagnose:oracle-woo-device-conversion -- --start=2024-11-20 --end=2025-11-19
```

Expected checks:

* `read_only` is `true`; range is the two requested dates and `expected_days` is 365.
* `storage` shows the intended project, configured GA4 dataset, and metadata-derived location.
* `persisted_by_device_and_coverage_state` safely reports only day counts, sessions, and ecommerce-purchase totals for desktop/mobile crossed with reportable/limited/unavailable; it contains no customer-level data.
* `aggregate.woo_coverage.covered_days` and `validation.reportable_days` are 365, with zero limited/unavailable days if production remains as previously validated.
* `aggregate.rows` contains desktop and mobile totals, each with 365 covered days, and non-null `rate = ecommerce_purchases / sessions` when sessions are non-zero.
* The command exits non-zero rather than saying “uncovered” if reportable coverage and the helper's rows contradict one another.

Exact Oracle acceptance question:

> What were desktop and mobile GA4 ecommerce purchases per session from 20 November 2024 to 19 November 2025? Show sessions, purchases, reportable days and any limited days.

The production facts supplied for the incident establish the completed 1,190-day backfill and its structural validation. This change does not rerun or mutate that backfill. Actual desktop/mobile totals for the acceptance period are deliberately not recorded here: they must be verified by the post-deployment read-only command. Routing, validation, synthesis, complete production-shaped data, and genuinely absent data are covered by automated tests.
