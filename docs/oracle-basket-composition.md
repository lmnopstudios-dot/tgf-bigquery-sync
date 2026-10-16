# Oracle operation transitions and basket composition

## Demonstrated causes and remaining uncertainty

Base: latest fetched `origin/main` `0be88bf` (merged #325). The only open PR
returned by the GitHub connector was #123, unrelated product-mapping diagnostics.
The initial sandboxed fetch failed at the proxy; the approved fetch succeeded.
The GitHub CLI API returned Forbidden; the connected GitHub search worked.
The latest campaign discovery factory and its credential/fetch wiring are retained.

On the base revision, `requested-operations.js` recognizes the unchanged basket
question as threshold scenarios plus optional product enrichment. There is no
basket-composition capability. `mergeRequestedOperations` retains previous
operations unless replacement wording appears. `order-value-context.js` retains
numeric settings on the same subject/route. Its provider returns order-value
histograms, which cannot establish composition. The presenter faithfully renders
shipping scenarios from that evidence. Both cases were executed against detached unchanged base `0be88bf`, with the
unchanged question and the real dependency/baseline/direct factories (remote
warehouse rows supplied by a fixture):

| Base reproduction | Selected thresholds | Line population read | Visible answer |
|---|---|---|---|
| Fresh | 175, 200, 225, 250, 275, 300 | No | Shipping scenario table; no composition table |
| After threshold simulation | 250, 175, 200, 225, 275, 300 | No | Shipping scenario table; no composition table |

Both selected `threshold_scenarios` and `optional_product_enrichment`, with
`governed_order_values` evidence. The fresh case also demonstrates that the
old default thresholds can introduce unrequested settings without retained context.
This is a demonstrated local planning/capability defect, not evidence that every
production layer or the live cache caused the incident.

The cross-capability audit also demonstrated that asking which products were
purchased from a campaign retained campaign performance. That request now has an
explicit unavailable product-attribution operation. It requires linked campaign,
order and product identities with compatible attribution windows. Campaign totals
cannot supply those relationships. Existing sales-to-product breakdown and
conversion-trend-to-supported-period-comparison paths retain their providers and
are covered alongside this new unsupported boundary.

No live incident job ID, source query, collector audit or deployed revision was
verified. Identical figures with advancing requested dates cannot distinguish
unchanged source orders, stale collection, cached evidence, wrong project or
incorrect coverage labelling. The result now separates requested end date,
latest observed eligible order date and unverified collection coverage.

## Shared execution and delivery

`resolveAnalyticalPlan` projects an operation independently of subject, population,
metrics, grouping, dates, exclusions and presentation. That operation participates
in evidence agreement and recovery. Legacy plans acquire the equivalent operation
only while all existing plan fields must still match. Basket envelopes additionally
recompute their scope, definitions, sections, comparison rows and exclusion dates.

Explicit operation-family changes replace incompatible operation lists and numeric
settings while compatible UK/GBP/online scope and dates remain. A prose-only answer
cannot complete a declared operation without evidence or an explicit limitation.
The same shared decisions and validation apply to direct `/agent`, interactive
chat, lease-owned jobs, authenticated polling and stored artifact recovery.
Presentation repair consumes validated evidence without provider rereads.

The production dependency factory binds the basket batch reader through the
existing order-analysis route. Server composition passes that binding; GET `/`
reports `oracle_capabilities.order_values.basket_provider_bound`. No individual
order-detail loop, catalogue, inventory or model inference supplies composition.

Multipart basket requests retain supported basket evidence and identify additional
unavailable metrics. The basket binding does not calculate a newly requested AOV,
median or profit forecast from its reconciled subset and pretend it is the whole
order population. Existing aggregate/order-value metric bindings remain separate.

## Basket evidence contract

* Shopify collected history only, with direct shipping country, presentment
  currency, Europe/London order dates and the existing governed online proxy
  `retail_location_id IS NULL`. It is not positive Online Store attribution.
  Matrixify, cancelled, unpaid and fully refunded orders retain existing exclusions.
* Latest snapshots of order components and order/line identities are selected
  before joins. Lines aggregate to one bounded array per order before the join.
  Monetary NUMERIC values cross the SDK as decimal strings. Arithmetic uses exact
  pennies; unsupported precision is excluded rather than rounded across bands.
* Original units, current units, lines and distinct root products are separate.
  Partially refunded/changed-unit orders are excluded because refund-to-unit
  allocation is unverified. Missing/custom product identities, gift cards,
  incomplete/overbound lines, unknown money and reconciliation failures exclude
  the whole basket with explicit counts.
* Each line must reconcile original unit price × quantity, original total,
  discounted total, total discount and actual presentment discount allocations.
  Discounted lines must sum exactly to the order's observed merchandise subtotal.
  Stored ambiguous zero prices are excluded. For identical units, the allocation
  convention divides the verified line value equally only when it is exact in
  pennies; otherwise the basket is excluded. This is disclosed accounting
  allocation, not an observed sequence of cart actions.
* Main item is one chosen highest allocated-value unit. Equal-value ties sort by
  root product ID then line ID. Remaining quantities include other units of that
  same product. Mixed-product and repeated-single-product baskets are separate.
* Threshold equality qualifies. £200/£225/£250 compare baskets requiring other
  units against those qualifying on the chosen highest unit alone. £250 qualifying
  baskets use [250,275), [275,300), [300,infinity). The £250 relationship is an
  explicitly named supporting slice; it is not an unrequested shipping scenario.
* Up to 20 common anonymous product/actual-price/quantity combinations and 20
  smaller-product/price groups are shown, with counts, remaining value and basket
  overshoot. Strictly cheaper remaining units and tied-highest units are separate.
* Shipping is excluded. VAT inclusion and the actual shipping-policy VAT basis
  remain unverified in the stored contract. All threshold statements are
  conditional on the observed discounted merchandise basis. Composition cannot
  establish what was added last, buying intent or behaviour at another threshold.

The reader allows 1–366 days, at most 20,000 eligible orders and 100 lines/order,
1 GB/query and 15 seconds/query within the request deadline. Overbound populations
fail rather than return a silently truncated report. Schema preflight precedes
population reads. Optional coverage failure preserves validated composition;
missing population/schema produces a specific limitation. Explicit calendar
exclusions work even without promotion knowledge retrieval. No schema creation,
collection, backfill or source mutation is introduced.

Summary finding and comparison tables lead. Combinations, bands, allocation,
coverage and exclusions are in Show details. Currency values use two decimals.
XLSX includes comparisons, basket coverage, combinations, smaller products, bands
and definitions. Recovery checks the saved plan, recomputed evidence, workbook
cell contents and byte hash, including owner-scoped manifests/downloads.

## Exact bounded read-only Render diagnostics

Run in the existing Render service shell, from the repository root, with the
service's existing project/credential helpers. Do not print credentials or run
server startup, setup, collectors, backfills or inventory diagnostics.

```sh
# No network: validates bounds and prints the required configuration and limits.
node diagnostics/oracle-basket-composition.js --start 2026-01-01 --end 2026-10-15

# Stored evidence only: <=6 SQL jobs, <=1 GB/query, <=15s/query, 60s total.
# Prints schema gaps, aggregated anonymous combinations, reconciliation counts,
# requested end, latest observed order date and per-component collection timestamps.
node diagnostics/oracle-basket-composition.js --start 2026-01-01 --end 2026-10-15 --execute-read-only

# Compare the two previously displayed cutoffs using the same stored snapshots.
node diagnostics/oracle-basket-composition.js --start 2026-01-01 --end 2026-10-12 --execute-read-only

# One already-existing incident job; do not create a job for incident inspection.
# Substitute the actual known UUID. LIMIT 1, SELECT-only, <=500 MB.
node diagnostics/oracle-shared-plan-readonly.js --mode job --job-id EXISTING_INCIDENT_UUID
```

Also GET `/` on the known Render service and record `revision` and basket binding.
Using the existing authenticated owner session, GET the incident
`/api/oracle/jobs/<UUID>` and any `/api/oracle/exports/<artifact-id>/manifest` and
download. Compare the current instruction, submitted/resolved operation and scope,
provider binding, requested period, saved evidence coverage, answer and workbook.
Do not POST a refresh/collection job as a read-only diagnostic. Repeating a read
against today's stored snapshots does not reconstruct the state of collection at
an earlier report time. An increasing synced timestamp does not prove complete
source coverage. No changed figures are assumed or fabricated.

The code verifies required deployed field names/types before execution; repository
collector code is evidence that the fields are defined, not proof that they are
present or complete in Render's bound dataset. Setup dependencies are existing
BigQuery read/query permissions, correct `GOOGLE_PROJECT_ID`, dataset location and
`GOOGLE_SERVICE_ACCOUNT_JSON` or the established default credentials. Runtime
readiness did not establish live credentials here, so live schema/coverage checks
remain outstanding. No missing fields should be invented or populated by this PR.

## Acceptance conversation

Use the unchanged production question below, in both a fresh chat and after the
shipping-threshold request. The canonical fixture is
`test/fixtures/oracle-basket-question.txt`; tests use those exact bytes.

1. “Assess UK online GBP free shipping for this year. Compare £250 with £175,
   £200, £225, £275 and £300. Show order-value bands.”
2. Paste the unchanged question below. Expect basket evidence and only the
   requested £200/£225/£250 comparison, not the prior shipping scenario tables.
3. “Export that.” Check matching comparisons, combinations, definitions and
   coverage; refresh the owned result and manifest without new provider reads.
4. “Try £225.” Verify only that comparison threshold, with compatible retained
   scope and exclusions. Request a new period/currency and verify new provider
   arguments. An unsupported source or unavailable schema must be explicit.

Fixture example (not a live business finding): 7 of 10 orders reconcile, with
2 single-unit and 5 multi-unit orders. Additional-item-required counts are
2/3/5 at £200/£225/£250; highest-unit-alone counts are 4/3/1. Excluding 1–4 May
leaves 4 additional-item-required baskets at £250. Anonymous examples include
Product 1 at GBP 240.00 plus Product 2 at GBP 20.00, basket GBP 260.00,
GBP 10.00 above £250. These are synthetic acceptance values.

Do UK online baskets show evidence of customers adding a smaller item to reach our £250 free-shipping threshold?

Use this year through the latest completed day, GBP orders shipped to the UK, online only. Show the full period and separately exclude 1–4 May inclusive.

Use order-line evidence to identify:
- Orders containing one item versus multiple items.
- Multi-item orders where the highest-value individual item was below £250, but the merchandise basket reached £250.
- Within those orders, the highest-value item, remaining items, their combined value and how far the basket finished above £250.
- Common main-product/add-on combinations, with order counts and actual discounted prices.
- Smaller items most often present in these qualifying baskets.

Separate baskets ending at £250–£274.99, £275–£299.99 and £300+. Include examples as anonymous product combinations, without customer information.

Compare £200, £225 and £250: how many observed baskets required additional items to reach each threshold, and how many already qualified on their highest-value item alone? Distinguish one expensive item plus cheaper items from multiple units of the same product.

Use consistent discount allocation and disclose VAT treatment, unknown values and coverage. Do not duplicate orders through line-item joins or infer basket composition from aggregate order totals.

Important: this establishes basket composition, not buying intent. Do not claim the smaller item was added last or bought to unlock free shipping unless compatible cart-event evidence establishes that.

Lead with a short finding and compact comparison table. Put supporting combinations and definitions in Show details. No inventory queries, collection, backfill or mutation.

## Completed verification for this change

* Focused basket suite in the release gate: 12 tests, all pass; the gate also
  covers existing order scenarios, campaigns, product clarification, conversion,
  provider calls and shared recovery.
* `npm run test:oracle:acceptance`: 344 passed; zero failures, cancellations or
  skips. Eleven central conversations and sixteen registered provider/delivery
  suites, including the unchanged basket question on all three delivery paths.
* `node --test --test-reporter=tap`: 1,379 tests; 1,376 passed, zero failed or
  cancelled, three opt-in live BigQuery validations skipped. The final semantic
  operation-name projection was additionally verified by the release gate.
* `ORACLE_BROWSER_DRIVER=/opt/codex/runtimes/cua/lib/node_modules/playwright-core/index.mjs npm run test:oracle:browser`:
  passed, eleven conversations, desktop/mobile, visible basket summary/details
  and durable refresh without provider rereads. Artifacts:
  `/tmp/oracle-acceptance-browser/desktop.png` and `mobile.png`.
* Diagnostic plan-only run, JavaScript syntax checks and `git diff --check` pass.
  Live Render/warehouse acceptance was not run. Browser fixtures do not establish
  deployed delivery or source coverage.

Earlier runs are not counted as passes: the sandboxed transport run failed to
bind localhost; an initial basket fixture used the wrong eligible count for the
preceding histogram, and another expected `conversion_rate` instead of the
existing `device_conversion` subject. These fixture expectations were corrected.
The verified calculations and delivery assertions remain in the gate. No run was
interrupted. No deployment, merge, live collection, backfill, inventory read,
source/knowledge mutation or schedule change was performed.
