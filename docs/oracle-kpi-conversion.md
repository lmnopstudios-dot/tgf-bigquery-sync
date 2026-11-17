# KPI online conversion: native Shopify session evidence

## Definition and scope

KPI tracking now uses the existing governed ShopifyQL country-conversion reader:
**human Online Store sessions that completed at least one checkout / human
Online Store sessions**. Both counts come from the same native daily report.
This is labelled Shopify conversion, not GA4 purchase events per session. The
retained GA4 aggregates cannot establish this converted-session numerator and
are not blended into the series.

Official references:
- [ShopifyQL sessions schema, API 2026-07](https://shopify.dev/docs/api/shopifyql/2026-07/schemas/sessions_and_behavior/sessions)
- [GraphQL ShopifyQL access](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api)
- [Shopify session measurement changes](https://help.shopify.com/en/manual/reports-and-analytics/discrepancies/session-measurement-update)

| Population | Native report |
| --- | --- |
| Combined | Unrestricted visitor-country total; includes UK and unknown geography. |
| UK | `session_country_code = 'GB'`. |
| International | Direct non-GB query excluding null, blank and `ZZ`. This is not global minus UK. |
| Unknown | Reconciled global minus UK minus direct international, only when all populations and measurement eras are compatible. Displayed separately, not included in international. |

Geography means the visitor/session country, not shipping destination. Conversion
is Online Store only. A POS-only or Unknown-channel dashboard makes no conversion
read. Currency and commerce shipping-destination filters do not apply to the
session population and are explicitly labelled. No country assignment is inferred
from currency, language or storefront market.

## Dates and comparability

All report dates use the shop's authoritative Europe/London timezone; a different
shop timezone produces an explicit unavailable result. Current days are excluded.
The governed source starts on 20 November 2025. Earlier requested periods remain
unavailable for this definition; Woo/GA4 event-based ratios do not fill them.

The source reader retains the existing 21-23 September 2026 rollout exclusions
until the shop-specific change date is verified. Measurement eras are never
pooled into one KPI or compared as a change. September 2026 remains a gap at the
whole-month grain. Compatible observed segments and their dates/counts are shown
separately in the workbook. A first-three-month commerce baseline does not
establish a comparable conversion baseline: native day coverage and matching
eras are also required, for both fixed and proposed references.

For every complete compatible period, sum sessions and converted sessions before
dividing. Never average daily or country rates. A missing native row is not a
zero. Explicit zero sessions preserve zero counts but leave the rate unavailable.
Full requested native-report coverage is required for a headline KPI. Observed
partial segments do not become full-month estimates.

These native-report observations have their own coverage and retrieval timestamp.
They do not require or extend finance/customer/channel reconciliation certificates.
Upstream tracking completeness remains unverified and is disclosed. This is not
a claim that every real-world visit or purchase has been measured.

## Execution, partial results and recovery

`oracle/kpi-conversion.js` adapts the existing country report reader, without
changing its source validation or history/measurement boundaries. Global, UK and
international scopes are validated independently. A failed international query
therefore leaves successful global/UK conversion and commerce results intact.
Their overlapping daily global counts and shop metadata must agree.

The adapter shares identical query promises, so metadata and repeated global/UK
reads are not charged three times. Bounds: at most 1,464 days, 20 actual GraphQL
attempts, 60 seconds total, and 4 MB of retained conversion evidence. The existing
per-reader operation/page bounds remain. A typical one-year report needs four
actual GraphQL calls; four synthetic chunks require thirteen. Failed attempts
count; there are no automatic throttling retries. Authentication uses the existing
Shopify connection and no access grant is changed.

The read requires the existing `read_reports` scope and Shopify's applicable
protected-customer-data approval. Missing permissions, parse failures, invalid
counts, deadlines, cancellation or unexpected timezone remain explicit source
limitations, with no shipping-order/device/GA4 substitute. No bulk export job,
collector, new warehouse table, backfill or schedule is introduced.

Raw aggregate native reports, validated source metadata and the population
requests are retained in the authenticated Oracle result. Download and recovery
replay the source evidence to recompute rates, monthly figures, population counts,
unknown geography and comparison compatibility. Tampered native counts, summary
rates or chart/monthly data fail validation. Refresh and download do not reread
Shopify. The four existing workbook sheets remain; new conversion-enabled reports
also have **Conversion coverage**, containing period counts, coverage, compatible
measurement segments and unknown-geography reconciliation. Legacy four-sheet
exports remain supported.

## Read-only validation (not run against production by this PR)

First inspect a bounded plan without source reads:

```bash
node diagnostics/oracle-kpi-conversion.mjs 2026-10-12 2026-10-13
```

Then, explicitly, read that narrow native window:

```bash
timeout --signal=TERM --kill-after=5s 75s \
  node diagnostics/oracle-kpi-conversion.mjs \
  2026-10-12 2026-10-13 --execute-read-only
```

This prints only aggregate populations, numerators, denominators, retrieval time,
coverage and safe failure codes. It does not persist an export, query/write the
warehouse, certify finance history, change inventory or collect historical data.
Check the source totals against Shopify's human-session report for the same
London dates and country predicates. This verifies only the requested dates.

After an authorised merge/deployment, explicitly request a new **KPI dashboard**
report to obtain conversion evidence. A previously saved report is immutable and
will not acquire new conversion values on refresh. Check the source label,
all-currency applicability, UK/international/unknown distinction, gaps and
measurement-era comparison notes before interpreting trends. No production
report, deployment, source validation or permission change was performed by the
implementation task.
