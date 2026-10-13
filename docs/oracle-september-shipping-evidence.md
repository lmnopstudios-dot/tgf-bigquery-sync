# September 2026 UK shipping evidence investigation

## Evidence and limits

The supplied live diagnostic after PR #317 reports population retrieved: £275 has
28 affected orders with 28 unknown charges; £300 has 52 affected orders with 50
unknown charges and two positive charges totalling £16. These are supplied live
results, not reproduced in this investigation's workspace. Financial evidence
completeness remains false. The objective is reliable uncertainty, not nonzero
estimates.

Source inspection against the new branch created from latest main confirms:

- `server.js` moneyAmount converts undefined, null and empty strings to zero;
  `shopify/finance-refresh.js` amount converts null/undefined to zero and Number
  also converts the empty string to zero. Both write the same numeric financial
  columns without an original-money presence flag or raw totalShippingPriceSet.
- `order_financials` retains shop and presentment shipping separately and payment
  transactions JSON. Transactions describe payments, not original shipping lines.
  Positive shop-side shipping is a discrepancy signal, never a replacement GBP
  presentment charge; no FX conversion is justified.
- `order_refunds` retains shipping-refund amounts and refund shipping-line JSON.
  A positive same-currency shipping refund can challenge a free-shipping claim;
  neither zero refunds nor absent refund rows prove original free shipping. Raw
  refund JSON preserves refund money presence, not original shipping-price presence.
- `order_locations` records app and retailLocation; `order_shipping_geography`
  independently records these plus direct shippingAddress.countryCodeV2, provenance
  and validity. `order_customers` supplies financial status and cancellation.
  Customer geography is not shipping evidence. Snapshots may be collected at
  different times and do not prove historical status at order creation.

There is no supported way to recover whether a particular stored original zero
was an explicit zero or an absent monetary field from these retained payloads.
A matching shop-side zero or total minus subtotal residual is insufficient because
those fields also lose presence and tax/duty/edit semantics are not established.
The code provides no proven-free class for the current evidence. Do not invent
charges or mark collector zeros free; a future independently preserved original
shipping payload could support a different classification, with separate review.

## Population and reconciliation

Oracle explicitly requires valid direct country GB, exact presentment currency
GBP, a matched financial and customer row, null retail_location_id, non-Matrixify
app, null finance and customer cancellation, and paid/partially_paid/partially_refunded
status. International shipping in GBP is excluded by country; UK shipping in
another presentment currency is excluded by currency. UK is GB, not GG/JE/IM.
GBP shop currency alone never qualifies a non-GBP presentment order. Markets are
not collected as a population field and cannot override direct shipping country.

Null retailLocation is the existing governed online proxy, not positive Online
Store attribution. It can admit other non-retail apps or omit orders attributed
to retail locations. The read-only audit reports actual represented country/currency
cohorts and location/geography attribution disagreements, without reclassifying
orders or asserting that those disagreements establish incorrect inclusion.

The existing online-country reporting logic has these material differences:

| Definition | Oracle order values | Shopify online-country sales |
| --- | --- | --- |
| Population anchor | Latest locations, finance left joined | Latest finance, locations joined |
| Period | Location created_at in Europe/London | Finance created_at in UTC |
| Currency comparison | Exact GBP | Uppercase GBP |
| Cancellation | Finance and customer must both be null | Customer must be null |
| Unknown country | Excluded from GB | Included in coverage, excluded from named countries |
| Value | Observed discounted subtotal distribution | Original total less refunds |

Both use the same status list, retail proxy and Matrixify exclusion. Neither uses
processed_at for September membership. The audit reports processed/created date
differences as context rather than substituting processed_at. September London
boundaries are 2026-08-31 23:00Z through 2026-09-30 23:00Z exclusive; UTC reporting
uses September 1 00:00Z through October 1 00:00Z exclusive.

The audit full-outer-joins deduplicated finance and locations, then partitions
orders into both, Oracle-only and reporting-only with exact rule/date flags.
`oracle_orders = both + oracle_only` and
`online_country_uk_gbp_orders = both + reporting_only`. Counts precede the
reporting top-ten country ranking. The shared snapshot helper resolves governed
ties deterministically; legacy reporting lacks that final tie-breaker. Equal
snapshot timestamp conflicts remain a limitation. Reconciliation proves agreement
of stored populations only, not complete Shopify order capture. Earlier repository
September counts are dated evidence and must not substitute for this live read.

## Bounded read-only verification

`diagnostics/oracle-shipping-evidence.js` accepts only start/end, at most 366 days.
It queries schema evidence (including refunds), shipping classification and
country/currency/retail cohorts, plus an optional refund contradiction check.
Each query has a 1 GB billing cap and 30-second job timeout; execution queries
are preceded by dry runs. Audit output is capped at 2,000 aggregate groups plus
one overflow sentinel; overflow rejects reconciliation. Output has no order IDs,
customer names, retail location IDs or raw transaction/refund payloads. Missing
refund columns are explicit, never interpreted as no refunds. A failed audit
cannot yield reconciliation. Financial completeness remains false throughout.

Run the diagnostic from the PR branch in a Render Shell using the service's
existing BigQuery configuration. This command loads only the diagnostic into a
temporary sibling file so its relative imports use the deployed PR #317 runtime;
it does not deploy or execute a collector:

```sh
git fetch --no-tags origin codex/oracle-shipping-evidence
diagnostic_path="$(mktemp ./diagnostics/oracle-shipping-evidence.XXXXXX.mjs)"
trap 'rm -f "$diagnostic_path"' EXIT
git show FETCH_HEAD:diagnostics/oracle-shipping-evidence.js > "$diagnostic_path"
node "$diagnostic_path" --start 2026-09-01 --end 2026-09-30
```

Check all required stages fulfilled, then compare shipping threshold 275/300
against the supplied 28/52 affected orders. Sum missing_stored_value,
ambiguous_collector_zero and invalid_stored_value separately, and retain unknowns.
Inspect positive shop-side amounts and positive shipping refunds among unknown
originals as contradictions needing further evidence. Review the reconciliation
partition and all country/currency/retail cohorts. A read-only classification fix
cannot recreate erased original presence information.

## Validation performed

Seven new regression cases pass, covering charge ambiguity, scope bounds,
reconciliation partitions, preserved eligibility/date definitions, typed parameters
and billing/time limits, partial failures/overflow, and optional refund reads.
Existing online-country and order-value test files also pass. JavaScript syntax
checks pass. The local live diagnostic fails at access/connection setup; no live
BigQuery schemas, current counts, SQL dry-run acceptance or Render verification
are claimed. Git shell fetch is unavailable because the configured proxy cannot
be reached; GitHub connector access created the branch directly from latest main.
Only the new diagnostic, tests and this evidence document belong in the PR.
Collectors, production providers and eligibility rules are unchanged. No data
backfill, deployment or merge was performed.
