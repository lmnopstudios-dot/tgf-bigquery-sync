# Order-value distributions and conditional threshold scenarios

Oracle now executes numeric bands, retrieved-population counts/shares, parameterized
threshold comparisons and optional UK destination-price candidates through the
shared context, analytical plan, capability registry, dispatcher and production
provider factory. The UK question is an acceptance example. The calculator also
supports other band edges, baselines, hypothetical fees, direct destination codes,
single currencies and an explicitly selected observed-total alternative.

The branch starts at b6bf9bf, the merge of PR #310. No delivery fix was recreated
or cherry-picked. Shared promotion retrieval, request-scoped calendar clarification,
plan validation, owner-scoped artifacts, job leases and terminal recovery remain
in use. There is no collection, backfill, inventory query, deployment or merge.

## Evidence established by source inspection

The production factory is wired in server.js for both ordinary and durable
execution. The following contracts were inspected, rather than inferred from
period totals:

| Evidence | Available stored contract / limitation |
|---|---|
| Identity | `shopify/shopify/order_id`, one latest deterministic snapshot of each component before joining. Other stores are not combined. |
| Channel | Existing governed proxy: matched `order_locations` and `retail_location_id IS NULL`; Matrixify excluded. This is not positive attribution to the Online Store sales channel. |
| Destination | `order_shipping_geography.shipping_country_code`, only with `geography_status='valid'`; collected from `shippingAddress.countryCodeV2`. No postcode inference. |
| Currency | Presentment currency and matching presentment money fields, kept separate from shop money. |
| Merchandise | `subtotalPriceSet.presentmentMoney` stored as `original_subtotal_presentment`. Observed discounted subtotal; shipping excluded. Tax inclusion is unverified because `taxesIncluded` is not collected. It is not an undiscounted merchandise field. |
| Alternatives | `original_total_presentment` is available only as explicitly named `observed_total`; it includes tax/shipping under source semantics and is not silently used as shipping eligibility. |
| Discounts | Total discounts stored separately. Order/line allocations and shipping-discount allocations are not established. Adding total discounts to subtotal cannot reconstruct original merchandise reliably. |
| Tax/shipping | Separate total tax and original recorded shipping amounts. No tax subtraction/addition or discount subtraction is guessed. Shipping refunds are not allocated in these scenarios. |
| Status | Governed online-country rules: uncancelled `paid`, `partially_paid`, `partially_refunded`; unpaid/fully refunded excluded. Partial refunds stay in the population; values describe collected original order amounts, not net refund-adjusted shipping eligibility. |
| Exceptions | Positive recorded charges differing from the assumed fee are counted. Stored zeros cannot distinguish free shipping from missing collection. Historical exception reasons and historical policy compliance remain unverified. |
| Collection | Component timestamps, represented dates, missing matches and duplicate component counts can be queried; none proves complete order collection. Missing geography/currency/status can prevent population classification and are disclosed separately. |
| Catalogue | Shared native published-product resolver; optional `contextualPricing(context:{country:GB})` variant prices, GBP only, product classification and publication evidence. No inventory or availability query. |
| Shipping rule | Actual rule eligibility amount, gift-card exclusions, VAT treatment and discount exceptions are unverified. Scenarios are explicitly conditional on a named observed amount. |

Important collection limitation: finance-refresh.js coerces absent source money
fields to zero. The provider consequently converts stored zero subtotals and
charges to unknown. The reusable calculator supports genuine zero when independently
established, but the current stored adapter cannot distinguish it. The collector
and its watermarks have not been changed.

## Calculation and delivery contract

Default UK parameters are baseline 250, hypothetical fee 8, thresholds
175/200/225/250/275/300, and edges 0/100/125/.../350. Edges are lower-inclusive,
upper-exclusive; the last band is unbounded. An amount equal to a threshold
qualifies. Unknown amounts stay separately in the full retrieved denominator.
Shares describe the complete retrieved eligible population, not a verified
complete source population. No top-N sample is used.

Money is rounded to integer minor units before comparisons and accumulation;
unsafe monetary/count precision is rejected. Recorded charges on affected orders
are a known subtotal with unknown-charge counts, not an assumed charge for every
order. The hypothetical fee is supplied fee × affected count. Raising a threshold
does not imply customers accept a new charge; lowering it does not imply all
recorded charges would disappear. Existing orders and behaviour are held fixed.
Fees are not delivery cost, contribution margin or profit.

Price candidates bridge observed 10–75 gaps below the baseline. Extra spend versus
the assumed shipping saving is stated. Candidates are neither proven cross-sells
nor verified qualifying items. Gift cards are not silently excluded without rule
evidence. Publication does not establish availability. A complete catalogue is
required before price enrichment is accepted; its reads are bounded to seven root
pages and 25 calls, and incomplete variants fail that optional section independently.

Promotion comparisons retain full-period and sale-excluded sections with separately
recalculated denominators. The existing resolver retains event provenance and
validated inclusive user-selected days without changing stored knowledge or
reopening resolved midnight interpretation. Failed/unresolved promotion reads
leave full-period figures visible and request-scoped clarification available.

`Try £225 instead`, `Exclude the May sale`, `Just September`, `Show the order-value
bands`, and `Export that` retain compatible scope. Explicit source/currency filters
remain independent of operation and output. Incompatible subjects clear this
operation. Current-year defaults and completed-day cutoffs use runtime
Europe/London dates; no reporting year is hard-coded.

Charts, compact tables, XLSX and recovery use the same validated plan and numeric
evidence. Recovery checks operation, source/currency/date scope, definitions,
promotion resolution, recalculated sections, catalogue candidates and chart facts.
Artifacts retain owner scoping, checksums, workbook/evidence agreement and explicit
request-ID idempotency. Existing worker lease and refresh semantics are reused.
Required failures produce a visible limitation; optional failures do not erase
successful calculations.

## Bounded read-only Render commands

Run from the repository directory with existing configured project/credential
helpers. These commands require this branch's diagnostic modules to be available;
they are not instructions to deploy, collect, change schedules or merge.

```sh
# One month: schemas, actual dataset location, unique joins, required components,
# UK/governed-online/GBP counts, collection ranges and recorded charge evidence.
timeout 90s node diagnostics/oracle-order-values.js --start 2026-09-01 --end 2026-09-30

# Acceptance year-to-date at the 13 October 2026 London runtime cutoff.
timeout 90s node diagnostics/oracle-order-values.js --start 2026-01-01 --end 2026-10-12

# Runtime London year-to-date, latest completed day, still bounded to 366 days.
oracle_start=$(TZ=Europe/London date +%Y)-01-01
oracle_end=$(TZ=Europe/London date -d yesterday +%F)
timeout 90s node diagnostics/oracle-order-values.js --start "$oracle_start" --end "$oracle_end"
```

The diagnostic prints aggregate-only evidence and schema metadata. It creates no
control tables or artifacts and imports no collector/server/inventory service.
The histogram read caps at 50,001 groups and rejects more than 50,000 rather than
publishing a truncated denominator. Each analytical read has a 1 GB billing ceiling
and 60-second job timeout; the schema query is capped at 200 columns/10 MB/30 seconds.
Dataset metadata supplies the actual BigQuery job location. Invalid dates,
windows over 366 days and write options are rejected before dependencies execute.

Production SQL syntax, returned column semantics and completeness still need the
permitted live read. A September inspection in this workspace failed before schema
retrieval with HTTP 403 `EGRESS_FORBIDDEN`; no production counts or private records
were returned. This is not live acceptance. Actual shipping-rule configuration,
positive online-channel attribution, missing-versus-zero source provenance, tax
inclusion, shipping-discount allocation and historical exceptions still require
independent evidence. A profit decision additionally needs compatible product cost,
fulfilment cost, margin allocation and behavioural evidence.

## Offline verification

Focused tests use real shared context, production dependency factories, dispatcher,
calculation, presentation and XLSX storage with production-shaped aggregate fixtures.
They exercise boundaries/equality, genuine zero versus missing, unknown charges,
non-standard charges, population filters and deduplication SQL, scope tampering,
promotion denominators, published price retrieval, independent failures, follow-ups,
owner isolation, checksums and artifact idempotency. SQL predicate tests are not
proof of live query execution or source completeness.

The offline browser harness uses the actual UI, authenticated API and durable worker
with the same production factory and aggregate fixtures. It verifies compact tables,
charts, closed details, scenario/date/promotion follow-ups, authenticated downloads,
refresh and viewport overflow at 1280×900 and 390×844:

```sh
ORACLE_BROWSER_DRIVER=/path/to/playwright-core/index.mjs node diagnostics/oracle-order-values-browser.mjs
node --test test/oracle-order-values.test.js
npm test
node diagnostics/oracle-tool-schema-validation.js
```

Completed validation in this workspace:

- Full repository suite: 1,118 passed, zero failed, three opt-in live SQL checks skipped (1,121 total). The preceding full run had one unavailable-delivery assertion failure; the limitation flag was corrected before the passing run.
- After the final artifact/filename/recovery fixes: 60 focused calculation, shared-context, dispatcher, provider, delivery and product-report checks passed, zero failed.
- New order-value tests: nine passed, zero failed.
- Final browser acceptance: desktop 1280×900 and mobile 390×844 passed tables, charts, closed details, promotion/date/scenario follow-ups, owner-authenticated XLSX filename/content, refresh and page-overflow checks. Early harness assertions were corrected to match chart placement, formatted dates and absolute download URLs; only the completed final run is reported as passed.
- 46 strict tool schemas across 61 registered tools validated; changed JavaScript syntax and `git diff --check` passed.
- The live September aggregate diagnostic failed with HTTP 403 `EGRESS_FORBIDDEN` at dataset access. Production SQL, fields, counts, rule eligibility and complete collection remain unverified.
