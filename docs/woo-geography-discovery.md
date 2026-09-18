# Historical Woo geography recoverability audit

This diagnostic is read-only. It does not enrich a record, change BigQuery,
write to Woo/Metorik, or infer a country from currency, billing geography, or a
postcode. The production evidence supplied before this audit establishes
38,831 Woo snapshot orders, 6,622 populated shipping countries, and a complete
numeric-ID match for those Woo rows to the 39,176 canonical Metorik orders.

## What the diagnostic measures

The JSON output has the requested `temporal_coverage`, `yearly_coverage`,
`missingness_patterns`, `raw_json_coverage`, `live_woo_probe`,
`repository_evidence`, `recoverability_buckets`,
`maximum_recoverable_coverage`, `recommended_recovery_strategy`,
`privacy_notes`, and `unresolved` sections.

Monthly and yearly coverage make a date boundary or intermittent gap visible.
Bounded currency, year/currency, and first shipping-method aggregates test
whether missingness is associated with GBP, international orders, a period, or
a fulfilment mode. They are descriptive only: in particular, GBP is never
treated as evidence that an order shipped to the UK.

`raw_json` is parsed only inside BigQuery `COUNTIF` expressions. The query
counts availability at these paths without selecting their values:

* `shipping.country`, `shipping.state`, `shipping.postcode`
* `billing.country`, `billing.state`, `billing.postcode`

The postcode counts establish evidence availability only. No postcode value is
returned to Node, printed, or persisted.

## Live Woo sample

With `--live-apis`, BigQuery deterministically chooses at most 12 order IDs:
up to two populated and two blank snapshot rows from each of early, middle, and
recent history. The program performs one read-only `GET` per selected ID. It
prints only order ID/date, sample stratum, country/state, and postcode-presence
booleans. Names, company, street, city, email, phone, and postcode values are
discarded before output.

This sample can demonstrate that current Woo sometimes contains direct shipping
evidence absent from the snapshot. It cannot defensibly estimate all-history
recoverability. The diagnostic therefore does not extrapolate the sample or
perform the prohibited 38,831-order sweep.

## Mutually exclusive evidence buckets

Orders are classified in authority order:

1. `A_shipping_country_direct_normalized`
2. `B_shipping_country_direct_raw_json`
3. `C_billing_country_only_not_shipping`
4. `D_shipping_postcode_only`
5. `E_billing_postcode_only`
6. `F_no_geography_evidence`

Only A and B count toward directly observed shipping-country recoverability.
Billing and postcode-only buckets deliberately remain separate and must not be
presented as recovered shipping country. A full live-Woo recovery percentage
remains unresolved until a separately approved, rate-limited extraction has
actually observed it.

## Repository evidence and limitation

The importer in `server.js` requests `wc/v3/orders` with `status=any`, ascending
IDs, and 100 rows per page. It truncates and rebuilds `orders_api`, mapping
`order.shipping.country` directly to `shipping_country` while retaining the
same response in `raw_json`. Git history shows that mapping was present when
the Woo importer was introduced; this checkout contains no evidence of an
older endpoint/version or an earlier transform that dropped country.

Consequently, if normalized and raw country counts agree, the repository
supports “Woo returned/stored blanks at snapshot time,” not a normalization
failure. It cannot distinguish an originally blank checkout address from later
editing, erasure, or anonymisation inside Woo. The bounded live comparison is
the safe test for whether the current resource has changed.

## Exact Render command

Run this in the existing Render service shell, where the read credentials are
already configured:

```bash
npm run diagnose:woo-geography -- --project gf-full-data --live-apis --sample-limit 12
```

The command issues aggregate BigQuery `SELECT`s and no more than 12 Woo order
`GET`s. Review the structured output before approving any recovery build.
