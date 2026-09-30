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
calendar-year evidence, while 2026 is labelled **YTD through 30 September 2026**.

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

## First read-only Render commands

Run these before changing data or drawing conclusions. They perform metadata reads, dry runs, and
bounded SELECTs only; the billing cap is 5 GB per query.

```bash
npm test -- --test-name-pattern='annual location|recorded tax|finance incident'
npm run diagnose:annual-location-finance -- --start=2022-01-01 --end=2026-09-30
npm run diagnose:annual-location-finance -- --start=2022-01-01 --end=2026-09-30 --currency=GBP --location='Online Ready to Ship'
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
7. distinguishes missing tax, observed zero tax, and source coverage.

Do not publish the supplied £547,600.56 / £598,406.21 / £561,246.78 annual tax figures or the
£175 disputed location amount as validated targets. Compare diagnostic output to matching
source-native sales, tax, refund, and shipping reports using the same currency, refund-date policy,
location meaning, and inclusive dates. The diagnostic establishes query behavior locally, but only
production output plus those source reports can establish the £515 classification rows, the 2p
source-rounding rows, actual source-field coverage, full-year completeness, and accountant
acceptance. No historical backfill or remapping is part of this change.
