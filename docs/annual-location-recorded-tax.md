# Annual sales by location and recorded tax

## Incident finding and reporting contract

Oracle previously answered location questions through `get_sales_by_location`. That query selected
`sales_gross`, `refunds_gross`, and `net_gross` from
`finance.accountant_transactions`, but **did not project `tax` or `net_ex_tax`**. The same ledger's
summary, monthly, channel, and ecommerce-report paths did project both columns. The “VAT
unavailable everywhere” result was therefore a projection/tool-contract failure, not evidence that
tax ingestion was absent. The word VAT also exceeded the evidence: this repository establishes a
recorded-tax field, not VAT-return liability.

`get_annual_sales_by_location` now reads that governed accountant ledger once and groups the same
population into location rows and all-location totals. Its headline columns are:

* `net_sales_excluding_recorded_tax`: stored tax-exclusive sales plus stored, negative
  tax-exclusive refunds. These are the after-discount values recorded by the governed ledger;
  discounts are not recalculated. It is null if any contributing stored tax-exclusive amount is absent.
* `net_recorded_tax_after_refunds`: recorded sale tax plus negative recorded refund tax. It is null
  if any contributing transaction has no tax evidence. `observed_net_recorded_tax_after_refunds`
  remains available as a clearly partial observed sum.
* `net_amount_including_recorded_tax`: the signed ledger gross. It must not be called
  tax-exclusive “net sales”.

Supporting fields retain sales, refund, sale-tax, and refund-tax components. Refund signs are not
flipped for presentation. A recorded zero is counted as evidence; a SQL null is unknown. Oracle
does not apply a rate, correct a source amount, or call recorded tax VAT payable.

The ledger's `location` is the source-recorded selling/POS location and remains separate from
`channel`. Blank locations are visible as `Unknown / unallocated`; labels such as Draft, Wedding,
Gold, Event, WooCommerce UK / Worldwide, and Online Ready to Ship are not remapped. In particular,
`SHOPIFY_INVENTORY_LOCATION_ID=gid://shopify/Location/105063874887` is not read by this finance
path and cannot attribute a sale. The accountant view does not separately project fulfilment or
inventory location.

Currencies are grouped and returned source-native, with no FX. Passing `currency: "GBP"` excludes
USD/JPY and must be disclosed in the answer. The existing governed ledger owns migration and
Matrixify deduplication; this report does not rejoin native systems and recreate overlapping orders.

Shipping and shipping tax are not separately projected by `finance.accountant_transactions`.
Consequently, the report preserves the stored gross/tax/net-exclusive definition and explicitly
marks separate shipping evidence unavailable. It does not assert that a measure excludes shipping.
The production schema inventory in the diagnostic identifies native shipping/tax fields that exist,
but they must be reconciled before extending the governed ledger contract.

## Dates, rounding, and coverage

Sales and refunds use their ledger `date`; refunds therefore remain in the recorded refund period,
not the original sale year. Dates are typed BigQuery `DATE` parameters. The current incident window
is **1 January 2022 through 30 September 2026**. Years 2022–2025 are displayed as observed
calendar-year evidence. Until collection is repaired and verified, the accountant tool deliberately
ends and labels 2026 **YTD through the verified coverage date, 24 September 2026**. The requested
30 September end remains visible in the incident diagnostic and is not misrepresented as coverage.

Earliest/latest evidence is reported for every year/location/currency. Its presence is not a claim
that 2022 is complete. `tax_evidence_records`, `missing_tax_records`, and `missing_ex_tax_records`
make coverage explicit.

The service sums stored fields independently. `stored_component_difference` is:

```text
stored net_ex_tax + stored recorded tax - stored gross
```

This exposes source rounding or definition differences without changing stored values. For the
reported Online figures, £1,280,423.63 − £151,627.16 = £1,128,796.47; a stored
£1,128,796.49 therefore produces a £0.02 component difference for investigation rather than an
automatic correction.

Each all-location year/currency is compared with the sum of every location row, including unknown.
Reconciliation reports differences for tax-exclusive, recorded-tax, and tax-inclusive amounts.
Null/incomplete components remain unreconciled rather than being coerced to zero.

## Exact first Render command

Run the production diagnostic first on Render. It performs metadata reads, dry-runs **every exact
statement before the first data read**, and then bounded SELECTs; every statement has a 5 GB billing
cap. The JSON includes the exact SQL, typed bindings, and metadata-derived dataset location under
`statement_manifest`.

The first command is the bounded, read-only missing-window check (not a write):

```bash
npm run diagnose:annual-location-finance -- --start=2026-09-25 --end=2026-09-30 --currency=GBP
```

Then run the full incident comparison if required:

```bash
npm run diagnose:annual-location-finance -- --start=2022-01-01 --end=2026-09-30 --currency=GBP --location='Online Ready to Ship'
```

These are local regression checks, not production findings:

```bash
npm test -- --test-name-pattern='annual location|recorded tax|finance incident'
npm test
```

The diagnostic:

1. inventories tax, refund, shipping, currency, and location columns in finance, Shopify, Woo WW,
   Woo US, and Square datasets using each dataset's metadata-derived location;
2. compares the annual-overall, annual-location, and Online-channel reads under identical bounds;
3. reconciles location sums to overall totals;
4. cross-tabulates source, sales channel, and sales location to isolate the reported £515
   channel/location population difference;
5. calculates the stored-vs-derived tax-exclusive difference;
6. shows aggregate evidence for 2025 Online Ready to Ship, with at most 20 non-customer transaction
   IDs and explicit location mapping provenance; and
7. distinguishes missing tax, observed zero tax, and source coverage;
8. breaks the stored-component difference down by year, source, transaction type, sales location,
   selling channel, and currency, then returns at most five non-customer examples per group;
9. lists exact Online-location-versus-Online-channel population rows and bounded transaction IDs,
   rather than attributing the £515 merely because an amount happens to match;
10. checks repeated ledger transaction IDs without deleting or deduplicating anything;
11. extracts the disputed Shopify transaction from the persisted source JSON and reports its order
    sales/POS location fields separately from its order source; and
12. compares native Shopify order/refund dates and collection timestamps with ledger evidence after
    24 September, while exposing source table/view definitions and partition modification times.

## Demonstrated incident findings

The two exact Square ledger rows now have a dedicated bounded query:

* `yqgPELNp1FBCGPmDIB0FVy5eV`, Shoreditch, 3 January 2022 records £434 gross,
  £0 recorded tax and £0 stored tax-exclusive;
* `bnuYSZ4hgC559kktkj74LvneV`, Soho, 21 June 2022 records £520 gross, £20 recorded
  tax and £100 stored tax-exclusive.

Those fields cannot all be additive components: their stored component differences are -£434 and
-£400 respectively. This is a demonstrated transformation/component-contract defect in the finance
output, not rounding. The evidence does **not** establish that source-recorded zero tax is wrong, so
it remains zero and no VAT rate is estimated. `square_gbp_affected` quantifies every positive-gross
affected GBP row by calendar year and source-recorded location, separately counting SQL null
(missing) and observed zero for both tax and tax-exclusive evidence. View DDL in the metadata output
is the authoritative transformation trace; the diagnostic does not guess a raw Square join when no
governed source-to-ledger identity contract exists.

WooCommerce UK refund `108377` is also selected exactly. Its -£60 gross, -£9.38 recorded tax and
-£50.63 stored tax-exclusive produce a -£0.01 stored component difference. It is disclosed as a
component discrepancy, separately from the material Square defects, rather than automatically
being labelled rounding.

The £515 Online location/channel difference is explained by three WooCommerce Online records
totalling -£515 gross and -£54.61 recorded tax. The diagnostic retains their source, signs, dates,
location, channel and bounded IDs; it does not treat a matching aggregate alone as provenance.

The disputed £175 item is successful Shopify Draft Order #1008 on 16 November 2025. Its persisted
source-recorded retail location is `Online Ready to Ship`. That label is preserved: fulfilment and
inventory configuration are neither read nor substituted.

The other supplied production figures establish component differences but not necessarily the
intended business definition of every upstream field. In particular, 2025 GBP POS (-£12,779.99) and
2026 GBP POS (-£1,099.88) are too large to be silently labelled rounding. Stored amounts remain
unchanged while source definitions are resolved. Internal reconciliation is not accountant
acceptance.

## Coverage and retirement

Requested end, native evidence bounds, collection timestamps, ledger evidence bounds, and source
storage modification times are separate fields. A maximum transaction date alone is never called a
sync watermark. The supplied evidence dates (Shopify through 24 September 2026, Square through 6
September 2026, Woo UK GBP through 9 January 2026, and Woo US USD through 19 November 2025) remain
observed bounds until compared with these outputs and provider-native reports.

No governed record in this repository confirms an exact Square operational end date. The export
notes only describe a staggered Square-to-Shopify POS migration through early 2026. The diagnostic
therefore reports Square as operationally retired with `confirmed_operational_end: null` and
`end_date_unconfirmed`; it must not trigger Square collection. Historical completeness through a
later confirmed end still requires an owner-approved end date and a source-native Square report.
Woo retirement dates are likewise unconfirmed, and legitimate trailing refunds stay in their
recorded refund period.

The application exposes authenticated Shopify and Woo sync routes, while the finance report reads
BigQuery views. This repository does not contain a Render schedule definition or a separate finance
materialization refresh job. The only supported order/refund collector is authenticated `POST
/sync-shopify`. It has no date arguments or persisted watermark: it fetches all orders, truncates,
then replaces the location, line, customer, financial and refund tables sequentially. A failure can
therefore leave a partial multi-table refresh. Invoking it would be the prohibited broad backfill,
not a bounded 25–30 September refresh.

There is consequently **no safe exact write command to run yet**. After the first diagnostic above,
inspect `shopify_collection_freshness`, table/view DDL, partition modification times and the Render
external schedule history. If native rows are still absent, restore or implement an owner-approved,
atomic bounded collector that selects orders updated in the half-open UTC interval
`[2026-09-25, 2026-10-01)`, replaces all rows for those stable order IDs (including updated refunds),
and retains the downstream Matrixify exclusion. Dry-run and reconcile that implementation before
executing it. Do not invent flags for `/sync-shopify`, run its full replacement, rebuild finance
first, or reactivate Square collection.

Do not publish the supplied £547,600.56 / £598,406.21 / £561,246.78 annual tax figures or the
£175 disputed location amount as validated targets. Compare diagnostic output to matching
source-native sales, tax, refund, and shipping reports using the same currency, refund-date policy,
location meaning, and inclusive dates. The diagnostic establishes query behavior locally, but only
production output plus those source reports can establish the £515 classification rows, the 2p
source-rounding rows, actual source-field coverage, full-year completeness, and accountant
acceptance. No historical backfill or remapping is part of this change.
