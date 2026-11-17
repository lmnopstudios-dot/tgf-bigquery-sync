# Oracle KPI tracking

## What this change delivers

A dedicated **KPI tracking** navigation view and registered `get_kpi_dashboard`
capability. `KPI dashboard`, `KPI dashboard for October 2026`, and explicit
inclusive ISO date ranges use the same scope and retained workbook flow through
direct agent execution, interactive chat and durable jobs. The dashboard submits
an explicit durable job and reconnects to that job after refresh; it never
repeats provider reads as a rendering repair. No campaign lookup, general-sales
fallback, knowledge proposal or source collection is involved.

This is a complete first reporting slice with explicit unavailable components,
not a claim that all six desired business measures already have compatible
source bindings. The UI shows selected-period cards, separate MTD, previous and
prior-year changes, 12 completed months, accessible vector trend charts, monthly
figures, retention, freshness and definitions. The workbook contains **KPI
summary**, **Monthly trends**, **Customer retention**, and **Definitions and
coverage**. Missing source results do not erase successful components.

## Audited bindings and limits

| Measure | Binding / status |
| --- | --- |
| Observed gross AOV | Latest retained Shopify `order_financials`, `order_customers`, `order_locations`; original discounted presentment gross including tax and shipping, before refunds / unique qualifying orders. Explicitly not merchandise-only AOV. Customerless qualifying orders stay in the order population. |
| Orders per purchasing customer | Qualifying identified-customer orders / distinct native purchasing customers in the exact period and selected channel/currency. |
| Mean / median order gap | Consecutive native qualifying orders in the selected channel/currency; elapsed seconds / 86,400, attributed to later order date. Require coverage back to the actual prior order. Interval-weighted mean and median; same-timestamp distinct orders have zero gap. Non-returners have no interval. |
| 30 / 60 / 90-day repeat | First qualifying order per customer in each period and currency, not necessarily first-ever order. Fully mature customers only; full index-period and mature follow-up coverage required. Immature customers remain explicit. |
| Returning customer rate / verified new customers | Withheld without complete prior purchase history, including earlier platforms. Observed returning and first-observed counts stay visible as diagnostics, not verified acquisition. Customerless orders are separate. |
| Conversion: combined / UK / international | Native Shopify human completed-checkout sessions / human sessions, using the existing governed country reader. Independent native coverage and measurement-era checks apply. GA4 purchase-event ratios are not blended. See [conversion binding](oracle-kpi-conversion.md). |
| Turnover | Withheld. Compatible merchandise, tax and refund-event-date components are not established together by this binding. Retained lifetime refunds are not period refunds. |
| CAC / targets | Unset. Compatible governed acquisition attribution/spend and business targets have not been supplied. |

The order eligibility contract is reused from `performanceOrderSources` and
`qualifyingCustomerOrderPredicate`: latest native paid / partially paid /
partially refunded Shopify orders with retained positive value, excluding
cancelled orders and known Matrixify copies. Native Order and Customer GID
namespaces are checked. Invalid customer IDs become customerless; invalid order
IDs do not become qualifying orders. Fully refunded orders are excluded under
this existing contract: this is an observed qualifying-order AOV, not an
alternative official Shopify AOV definition.

There are two read-only aggregate BigQuery queries, each capped at 1 GB billed,
45 seconds and 1,000 / 3,000 aggregate rows respectively. No raw customer rows
are returned. Dataset location comes from metadata. An overflow rejects the
component rather than truncating. Caller cancellation and query deadlines use
the existing bounded-query cancellation mechanism. Diagnostics contain only
phase, source, aggregate row counts and allowlisted failure codes.

The SQL is executed against synthetic fixtures through the existing BigQuery to
DuckDB SQL test adapter. This verifies arithmetic and population behaviour; it
does not certify live BigQuery schemas, access, freshness or production coverage.

## Dates, comparisons and baseline

- London calendar boundaries; no host-timezone assumptions.
- Default latest completed calendar month, plus current MTD through yesterday.
- A full calendar month compares with the preceding full calendar month; other
  selected ranges compare with immediately preceding equal calendar-day counts.
- Prior-year dates retain month/day, clamping leap day to 28 February.
- MTD comparisons retain start-of-month and elapsed-day endpoint, clamped to
  shorter month lengths. The actual comparison dates and day counts are in the
  workbook and definitions panel. Unequal calendar months are not disguised as
  identical durations.
- 12 completed months remain visible even if evidence is missing. No zero fill.
- Monetary series stay in presentment currency. Combined includes online, POS
  and Unknown channel without summing separately calculated distinct customers.
- Reviewed `performance_coverage` intervals from the existing private
  `LOYALTYLION_CONFIG_PATH` account configuration are reused read-only. Missing or
  invalid coverage yields unavailable metrics, never automatic certification.
  These intervals certify retained finance/customer/channel completeness, not
  a complete lifetime customer acquisition history.

The first three consecutive verified full months are **proposed** as a baseline.
A proposal is labelled and is not silently applied to comparison cards. After
review, `ORACLE_KPI_BASELINE_START=YYYY-MM-01` freezes that starting month. It
must cover three complete consecutive months for the selected channel. The
baseline is queried as one population: AOV pools total gross / total orders;
frequency deduplicates customers across all three months; median uses all
underlying intervals, not monthly medians. An invalid pinned interval yields
unavailable baseline rather than moving to a different period. No baseline or
target is automatically written or advanced. Adding older coverage does not
move a configured baseline.

## Geography and unsupported filters

Commerce destination filters are shown as unavailable until a compatible
retained shipping-geography binding and coverage contract are connected. A UK,
international or Unknown destination request preserves that scope and returns
unavailable commerce values; it does not run an all-country substitute. GA4
session geography is a separate role and must not be inferred from currency,
market or shipping destination. The UI offers supported channel/currency/date
filters, with unavailable destination choices explicitly marked. Promotions,
product filters, mixed explicit currencies and unsupported natural-language
periods are rejected rather than silently ignored.

## Review and rollout (not performed by this PR)

1. Run `npm run test:oracle:acceptance` and `npm run test:oracle:browser`.
   CI installs `test/requirements-loyalty-sql.txt` for executable SQL tests.
2. Review the source definitions and existing coverage intervals. No extra
   permissions are needed beyond existing read access to the three retained
   Shopify tables and the existing authenticated export store. The current
   private configuration file is read only; do not paste it in logs or chat.
3. Optional bounded SQL dry run on the deployed revision, after approval:

   ```bash
   LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
   timeout --signal=TERM --kill-after=5s 75s \
     node diagnostics/oracle-kpi-preview.mjs 'KPI dashboard for October 2026'
   ```

4. Optional aggregate-only retained warehouse preview, separately explicit:

   ```bash
   LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
   timeout --signal=TERM --kill-after=5s 75s \
     node diagnostics/oracle-kpi-preview.mjs \
     'KPI dashboard for October 2026' --execute-read-only
   ```

   This does not create an export, change data, collect source history or
   approve coverage. It reports source status, dates and supported/unavailable
   value counts. The two queries have a combined 2 GB maximum billed cap.
5. Review the proposed first three verified months and configure a pinned
   `ORACLE_KPI_BASELINE_START` only when agreed. No deployment/configuration
   changes are made by the implementation task.
6. After an authorised deployment, sign in, open **KPI tracking**, run a period,
   verify scope and unavailable states, download XLSX, refresh and confirm saved
   job recovery without new provider calls. Also test both short and month
   commands through chat. Verify anonymous export access remains denied.

## Remaining integrations

Shopify session conversion is now bound as described in [conversion binding](oracle-kpi-conversion.md). GA4 converted-session history remains unavailable and is not used as a substitute. Native shop access and returned-day coverage still need live validation.
Bind governed merchandise/tax/shipping and refund-occurrence measures before
turnover or merchandise-only AOV is enabled. Audit longer cross-platform customer
history before verified first-time acquisition and primary returning-customer
rates are enabled. No missing source is backfilled or inferred by this report.

## Validation status

See the PR for exact test counts. Desktop/mobile browser regressions cover the
KPI panel, durable composer, download, anonymous denial and refresh recovery.
Live warehouse and GA4 reads remain unverified; no production collection,
backfill, schedule activation or deployment was performed.
