# Monthly visitor-country conversion

This work starts at main `805e8e9`, containing merged #328 and #329. It reuses the #328 ShopifyQL reader and #329 shared operation/delivery validation.

## Demonstrated causes and changes

The population transition in `analysis-context.js` unconditionally assigned `grain:null`, overwrote dimensions/channel and cleared other scope fields. The general grain parser recognized “monthly” but not “By month”; a question-shaped follow-up could lose the subject. `populationScopeIntent` interpreted “Global instead” as a single global population. Capability validation imposed the native reader's 366-day bound on the whole report. The aggregation then summed every day in each measurement partition into a period total. Plan stamps could describe a monthly operation without proving any monthly rows.

Grouping-only refinements now update grain independently; country/global/rest-of-world refinements preserve compatible fields. Explicit “Global only” still selects one population. Dates-only changes and oversized limitations retain the pending scope. Shared output preference parsing also carries XLSX requests. The weekday binding checks requested grain as well as its weekday dimension, so a month refinement cannot execute weekday evidence. Country completeness replays actual native query arguments, daily counts, requested population, coverage and monthly calculations; copied plan metadata cannot prove execution. Charts and workbook values are checked against the same evidence on recovery/download.

## Execution and history

Native human sessions and completed-checkout sessions are fetched together by **day**, using the existing reader. Calendar-month reporting sums these counts before dividing. It does not average daily rates or depend on an unverified ShopifyQL `GROUP BY month` response. Monthly outputs coalesce compatible supported days, keep measurement eras separate, and label partial months. One-point series use a comparison chart; longer compatible histories use trend lines, separated by measurement era. Zero denominators are unavailable, not 0%.

Rest of world is fetched directly with a non-UK predicate excluding null, blank and `ZZ` geography. Global remains unrestricted and includes UK and unknown geography. The direct result, UK and global counts must have compatible dates and definitions; count and complement arithmetic must be nonnegative and internally possible. The new predicate's ShopifyQL syntax and actual data coverage still require live verification; parse failures produce an explicit limitation, never a global-minus-UK fallback that includes unknown countries.

The report wrapper allows at most four non-overlapping 366-day windows (1,464 total requested days), 20 GraphQL calls and 60 seconds overall, shortened by the caller's deadline. Individual reader limits remain unchanged. Cancellation and durable lease ownership are checked between chunks; successful chunks checkpoint a validated partial result with later windows marked pending. Failed windows remain explicit coverage gaps. Job polling, refresh, presentation repair and downloads replay retained evidence rather than retrieving source data again. A lease loss stops further work; stale workers cannot checkpoint or publish.

History before the governed Shopify launch (20 November 2025) remains unavailable for **this converted-session definition**. The repository's earlier historical audit identifies GA4/Woo purchase events per session (18 August 2022–19 November 2025), not Shopify sessions completing checkout. Visitor-country history is unverified/uncollected there; the stored device tables cannot establish visitor-country membership. No compatible historical country converted-session evidence is present in the audited bindings. Raw GA4 export existence/history is unverified. These definitions are not blended, and no collector/backfill is invoked. A three-year request returns whatever Shopify history is actually verified and explicitly identifies its unavailable prefix and any missing days.

## Reconciliation

The prior source code already excluded a governed-launch prefix, current/future dates and 21–23 September 2026, but the prose named only the three transition dates. With a 16 October 2026 London cutoff and otherwise complete native reports:

| Request | Requested | Supported | Pre-source history | Transition exclusion | Current day |
|---|---:|---:|---:|---:|---:|
| 2026 YTD | 289 | 285 | 0 | 3 | 1 |
| Last 366 days, inclusive | 366 | 327 | 35 | 3 | 1 |

The 35-day prefix is 16 October–19 November 2025; the current excluded date is 16 October 2026. This reproduces the reported arithmetic from the reader's rules; it does **not** independently verify the production native rows or upstream completeness. Every requested date now has one category: supported, missing, pre-source-history, measurement-transition exclusion, current/incomplete day or another explicit failure/pending reason. Counts and explanations derive from this ledger. Actual evidence cutoff is the last compatible returned day, distinct from the requested end, query time and unverified upstream completeness.

## Bounded Render verification

Run these in a Render shell with this PR revision available in the working checkout and the existing runtime credentials. These commands only read native source reports; they do not deploy, activate schedules, collect, backfill, query inventory or write source/knowledge data. Each command independently enforces the bounds above. Do not run commands that print credentials.

```sh
node diagnostics/oracle-monthly-country-conversion.mjs --start=2026-10-12 --end=2026-10-13 --population=global
node diagnostics/oracle-monthly-country-conversion.mjs --start=2026-10-12 --end=2026-10-13 --population=rest_of_world
node diagnostics/oracle-monthly-country-conversion.mjs --start=2026-08-01 --end=2026-10-15 --population=rest_of_world
node diagnostics/oracle-monthly-country-conversion.mjs --start=2023-10-16 --end=2026-10-15 --population=rest_of_world
```

Check the first probe against the supplied narrow aggregate: UK 1,888 sessions / 17 completed-checkout sessions; global 4,917 / 25. That establishes only those dates. The non-UK result may differ from global minus UK because unknown geography is excluded. The monthly probe must produce August, split September and partial October, with weighted ratios and a reconciled coverage ledger. The historical probe must explicitly classify the pre-launch prefix, never fill it with zeros. These source probes do not prove deployed browser delivery.

In this environment the bounded 12–13 October non-UK probe failed during authentication with `NETWORK_FAILED`. No native monthly/non-UK or historical result was verified here. The previously supplied Render aggregate is not treated as verification of these new queries.

## Oracle acceptance conversation

1. Compare UK visitor conversion with global visitor conversion for 2026.
2. Can we see a monthly report of UK vs rest of the world conversion rates for the last 3 years?
3. Okay for the last 366 days then.
4. Can I see a monthly breakdown of this?
5. Totals instead.
6. By month.
7. Global instead.
8. Rest of world instead.
9. Export that as XLSX.

The date reply must retain monthly/non-UK scope. Totals changes grouping only; Global instead changes comparison membership only. Verify monthly counts/rates in the visible table, chart, authenticated workbook, durable polling and browser refresh; recovery must make no provider calls. Correct answers, partial results, limitations and clarifications remain separate outcomes.

## Local validation

The extended persistent gate passed 412 tests (15 central conversations and 21 provider/delivery suites), with zero failures, cancellations or skips. Browser acceptance passed the same 15 conversations on desktop and mobile with durable refresh. The monthly focused suite passed 11 tests, including authenticated XLSX bytes/manifest, unauthorized download rejection, saved evidence recovery, failed chunks, cancellation, lease rejection, chart tampering and cross-subject grouping changes. These are exposed regression fixtures, not blind evaluation or production certification.

An initial gate run exposed the retained weekday-dimension/month-grain mismatch; it was fixed and the gate rerun passed. Browser setup initially lacked the Playwright driver, and browser download hosts returned 403; a temporary driver plus the existing system Chromium completed the browser checks. The live probe failed at authentication with `NETWORK_FAILED`, as recorded above. Three opt-in BigQuery live/dry-run syntax suites are skipped by the default full repository test command.
