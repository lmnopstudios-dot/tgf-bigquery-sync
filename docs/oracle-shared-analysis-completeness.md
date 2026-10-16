# Shared analytical execution and answer completeness

This change extends the existing context → analytical plan → capability decision →
production provider → evidence validation → delivery pipeline. It does not supply
an arbitrary analytical compiler. Live warehouse readiness is **unverified**.

## Starting point and demonstrated causes

Branch starts at origin/main `785db9d` (PR #328). Connected GitHub issue search
returned no open PRs at task start. Recent merged dependencies preserved: #328
visitor-country conversion; #327 BigQuery basket aliases/read diagnostics; #326
basket operation; #325 latest campaign discovery; #324 shared scope/release gate;
#323 entity-relative scope; #322 document boundary; #321 follow-up operations.
CLI GraphQL PR inspection was forbidden; connected GitHub inspection succeeded.

1. `analysis-context.js` identified purchase journeys but left generic customer
   and sales routes/subjects in place. `baseline-dispatcher.js` scans current
   stock, product exports, general analytics, historical events, ecommerce
   baseline and product evidence in order when no authoritative route matches.
   This permits an earlier related report to win. Collaboration retention now
   gets an authoritative journey route before broad report recognizers.
2. `assertOperationDelivery` checked evidence presence for numeric requests,
   rather than proof that its producer executed the requested operation. The
   saved plan stamp was assigned after execution; agreement with a copied intent
   plan alone cannot prove execution. `answer-completeness.js` now independently
   checks operation/evidence compatibility; retention additionally checks periods,
   observation cutoff, entry classification, channel, required windows and exact
   mature denominators/rates. Existing provider-specific assertions remain.
3. Native model synthesis and partial tool fallbacks did not retain resolved
   analytical context at delivery. They now pass it through the same terminal
   contract; nonempty prose and unrelated successful tools do not complete a
   declared operation. Generic journey tool envelopes need a successful journey
   definition with matching entry scope/grouping. Not every model tool family has
   this complete proof adapter yet; see readiness gaps.
4. Inline proofreading without a quotation delimiter could acquire analytical
   scope from topic words. Editing-only instructions now stay behind the document
   authority boundary; model editing receives `toolsAllowed:false`.
5. Journey SQL previously treated a NULL Shopify app ID as NULL migration status,
   excluding normal orders under `NOT migrated`. COALESCE preserves these orders.
   Active human-approved product mappings were declared but not used to propagate
   classifications; the existing mapping CTE now supplies those links.

## Production paths audited

| Path | Execution and validation | Terminal behavior |
|---|---|---|
| Direct `/agent` | `server.js` → `executeGovernedAgentAnalysis`; resolved context and shared capability decision precede baseline/model execution | `deliverOracleResult`, including native synthesis and admission/synthesis partial fallbacks |
| Interactive `/api/oracle/chat` | `ui-router.js` → scope/pending state → `resolveAnalysisDecision` → `dispatchAnalysisRequest` | Shared provider scope checks, presentation, delivery; evidence cache accepts only agreeing evidence |
| Durable jobs | Same dispatcher; `analysis-jobs.js` worker bounds runtime and cancellation | Delivery checked before lease-owned checkpoint/finish; ownership/lease guards unchanged |
| Authenticated polling/latest | `ui-router.js` validates persisted context/evidence before presentation/delivery | Reuses saved evidence, never reruns providers to repair presentation |
| Exports/recovery | Existing persisted artifact validation plus submitted/resolved plan agreement | Existing currency, owner and recovered-export guards remain; cohort XLSX/chart unsupported |
| Clarification | Pending fields consumed before scope decisions; invalid replies retain pending state | Invalid promotion replies now explicitly identify clarification fields, avoiding false completeness failures |
| General/native tooling | `tool-registry.js`, strict schemas and per-tool governed validation | Declared supported operation checked against successful evidence; no new unrestricted SQL/model arithmetic path |

## Implementation-grounded capability inventory

These are conditional read capabilities, not assertions that historical collection
is complete. `analytical-capabilities.js`, `tool-registry.js` and each named module
are the executable sources of truth.

| Governed implementation | Metrics / operations / grouping | Grain and binding | Population/history/combination constraints |
|---|---|---|---|
| `cohort-retention.js`, `customer-journey.js` | First-observed collaboration cohorts; 90/180 mature repeat counts/rates; exact conditional median days to next eligible purchase; rank by source/window | Identified eligible order history + active classifications + human-approved mapping links; one BigQuery aggregate | Woo UK/US and non-Matrixify Shopify; source-qualified customers kept separate; online/in-store channel applied to entry and subsequent purchases; prior coverage unverified; overlapping multi-collaboration cohorts; no PII, money or causal claim |
| `customer-journey.js` existing native tool | Buy-next, nth order, within-days, downstream products/units/value, entry product/cohort-year grouping | First observed history, later orders, product lines | Existing model tool remains for other journeys; no persisted Woo/Shopify identity bridge; source-native values by currency |
| `population-conversion.js`, `shopify-country-conversion.js` | Weighted completed-checkout-session/session rate; selected country versus inclusive global or exclusive rest of world | Same-row ShopifyQL sessions by day and visitor country | Human online sessions; no shipping/billing/currency proxy; at most 366 days/5 GraphQL calls; launch and rollout boundaries retained; no extra dimensions/period comparison |
| `order-value-analysis.js`, `basket-composition.js`, `basket-provider.js` | Bands, exact merchandise mean/median, gaps, conditional threshold scenarios; unit/product combinations and threshold crossing | Unique Shopify orders; reconciled discounted lines and deterministic unit allocation | One shipping country and currency, online; batch bound 366 days/20,000 baskets; no historical cross-source basket union, inferred shipping eligibility, profit costs or behavioral forecast |
| `daily-sales-provider.js`, `weekday-sales.js` | Net sales/orders; weekday totals and average per eligible day; confirmed promotion exclusions | Native Shopify daily sales, London calendar | Online only; no arbitrary product/geographic/period filters; excluded calendar days change denominators; currencies remain separate |
| `baseline-overview.js`, `platform-sales.js`, `general-analytics.js`, `finance.js` | Native sales/orders/refunds/discounts/AOV, monthly and period/channel comparisons; canonical finance through existing separate service | ShopifyQL period aggregates and governed warehouse/source finance | Period evidence cannot establish baskets or retention; canonical versus operational finance kept distinct; explicit source/currency/coverage constraints remain |
| `category-sales.js`, `product-history.js`, `product-report-config.js`, `product-priority-production.js` | Governed family/category sales; product sales/units/orders; catalogue rankings, traffic/search enrichment and exports | Persisted product/order lines, approved identities, catalogue; keyed landing/search evidence | Complete catalogue selection before ranking; product_sales is not net sales after refunds; arbitrary attribution/conversion unsupported; current catalogue does not establish historical availability |
| `online-country-sales.js`, `shopify-country-products.js` | Orders/sales and product rankings by direct shipping country | Source order/line + direct geography | Source eligibility/migration and currency guards; shipping destination never establishes visitor-session geography |
| `device-source-conversion.js` and request modules | Native device/referrer conversion and period trends | Compatible numerator/denominator by source and measurement era | Woo GA4 versus Shopify source definitions remain separate; pre-launch periods are missing, never Shopify zero history |
| `klaviyo-email.js`, `campaign-context.js`, `campaign-set-analysis.js` | Discover latest/named/previous sent campaigns; delivered/clicks; credited conversions/revenue and comparisons | Entity metadata; persisted message reports and window coverage | Latest by actual send time; bounded entity count; calendar-month attribution and metric/currency/account identities; no campaign→product join or causal lift |
| `meta-instagram.js`, `tiktok.js`, `google-ads.js`, `ecommerce-report-v2.js` | Source-native spend/performance, reach/engagement and governed acquisition/organic evidence | Provider-specific persisted reports/coverage | Source/attribution/date grain stays native; no invented cross-source causal denominator |
| `customer-query.js`, `customer-order-interval.js`, `product-view-purchase.js`, `pageviews-per-session.js` | Population customer metrics, eligible consecutive-order intervals, aggregate traffic ratios | Existing controlled warehouse/native contracts | Population summaries are not cohorts; aggregate views do not establish person-level purchase journeys |
| `historical-event-comparison.js`, `promotion-context.js` | Verified event calendars and supported sales comparisons/exclusions | Governed knowledge dates + compatible daily/source evidence | Unverified promotion dates require resolution; contextual mentions never silently become exclusions or causal evidence |

Current stock, inventory opportunity, knowledge-write, collector/backfill and
schedule capabilities were not executed. No deployment, merge or source mutation
was performed.

## Added operation and limits

Retention reuses the existing first-observed history CTE before cohort-entry
filtering, eligible statuses/refunds, Matrixify exclusion and source identities.
Each collaboration on the first eligible order gets one membership. Each source
and collaboration is counted separately. It joins the earliest subsequent
eligible-channel order, uses full 90/180 calendar-day maturity at observation_end,
and computes exact PERCENTILE_CONT among returning mature customers. Counts and
rates are validated deterministically; null denominator/median is not zero.

Execution is one batch, maximum 20 GB billed and 45 seconds waiting, with a server
job timeout and cancellation/deadline boundary. The output selects at most 50
source/collaboration groups (100 window rows); reaching the bound is disclosed
as incomplete ranking. No per-order retrieval loop exists. Small samples under
30 mature entries are marked. All retention results are partial because company
identity/history/classification completeness is unverified. Empty cohorts are an
explicit unavailable result, not a successful zero-retention analysis.

The overall winning collaboration across Woo and Shopify is **not added**.
Neither are arbitrary windows, cohort exports/charts, arbitrary exclusions,
campaign-product attribution, counterfactual profit or causal effects. Unsupported
filters/output combinations are rejected before provider calls. Existing broader
journey tools remain available with their own contracts.

## Adding capabilities through this architecture

1. Extend validated context and its `resolveAnalyticalPlan` projection with the
   operation's independent entry/observation/report dates, population, metrics,
   grouping and definitions. Do not attach a new exact-sentence router.
2. Register the capability/limitations and executable dispatcher. Add its provider
   to `createOracleProviderDependencies`; hydrate identities without changing
   submitted scope. Keep strict model tool schemas and governed argument checks.
3. Implement bounded batch calculations over evidence at the required grain;
   keep deterministic identity reconciliation and arithmetic outside synthesis.
4. Add an evidence producer adapter in `answer-completeness.js` and provider-owned
   deep checks in `assertEvidenceAgreement`. A copied plan is intent, not proof.
   Declare precise partial/unavailable components; choose a supported alternative
   only if it preserves the request. No alternative exists for an absent customer
   bridge, so retries must not manufacture one.
5. Extend the persistent matrix/provider tests and desktop/mobile browser gate.
   Exercise real factory arguments, wrong-report negatives, pending replies,
   subject switches, owner/lease persistence and recovery without provider repeats.

## Evaluation and validation

Frozen fixture SHA-256:
`d4fab847caffc8e38d7f7b90984862f761728c4e34f61ef608632219b0b9c399`.
It was authored by this implementation agent before edits, and is not a blind or
independently authored holdout. It contains 12 questions/conversations exercised
through direct, interactive and durable transports (36 evaluations). Its execution
informed retention export continuity, operation detection without explicit
first-purchase wording and editing-only boundary fixes. Questions were unchanged.

Final machine-readable results are `oracle-independent-evaluation-results.json`.
They distinguish supported answers, supported partial answers, correct
limitations, necessary/unnecessary clarifications, wrong answers and failures.
Initial evaluation had 3 wrong-answer classifications from a fixed-January
country fixture and 2 failures from a stub that prohibited safe editing. The
harness now uses actual query dates and permits only a tools-disabled editing
fallback; this correction is not counted as a newly added product capability.

Coverage is deliberately limited: the frozen set tests export limitations and
recovery, but does not independently prove a successful new product export or
live model interpretation. Existing matrix/provider suites cover successful
basket/product exports and recovery. Warehouse-shaped cohort aggregates are
hand-counted fixtures, not a local execution of BigQuery SQL.

Live dry run attempted: `node diagnostics/oracle-cohort-retention-read.js`.
Result: HTTP 403 at `oauth2.googleapis.com` during service-account token acquisition, before a warehouse SQL/schema dry run could execute. This host is absent from the enforced restricted network allowlist. Runtime readiness indicated
configured variables, but did not establish API authorization. No live SQL/schema
or collection completeness success is claimed.

## Exact bounded Render verification

Run in the existing Render checkout with its existing service identity; do not
change permissions or deploy as part of these commands:

```sh
node diagnostics/oracle-cohort-retention-read.js
npm run validate:oracle-tool-schemas
npm run test:oracle:acceptance
npm run test:oracle:browser
npm run test:oracle:independent
```

The first command makes one dry-run query with 30-second job timeout/20 GB cap;
it never collects data, queries inventory or returns customer rows. The test
commands use fixture providers/localhost. Browser driver configuration must point to already
installed Render browser tooling. If absent, record the browser check blocked;
do not install browser tooling or interpret fixture results as deployed delivery.

Remaining production checks: successful BigQuery dry run against deployed schema;
verified source/classification/prior-history coverage; a governed customer bridge
for company-wide retention; real model-assisted interpretation and authenticated
browser delivery against the deployed revision. The current completeness registry
covers declared cohort/numeric/basket/weekday/population operations, not every
arbitrary request/output component in the native tool registry. No general
reliability claim follows from these fixture results.

## Recorded local check results

- Full repository `npm test`: 1,434 tests, 1,431 passed, 0 failed, 3 skipped.
  Skips are the opt-in annual, generated-statement and reconciliation BigQuery
  dry-run tests. This is not live warehouse verification.
- Persistent acceptance gate: 398 passed, 0 failed/cancelled/skipped; 14 central
  conversations plus 20 suites. Later retention integrity guards were rechecked
  with the focused cohort suite (7 passed).
- Browser acceptance: 14 conversations on desktop/mobile; durable refresh passed.
  Used existing `/usr/bin/chromium` and
  `ORACLE_BROWSER_DRIVER=/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs`.
  The first browser attempt failed because the default module lookup could not
  find playwright-core; no package was installed.
- Strict schema diagnostic: 46 schemas across 61 registered tools validated.
- Frozen evaluation: 36 transport evaluations: 9 supported answers, 6 supported
  partial answers, 9 correct limitations, 9 necessary clarifications, 3 document
  boundary checks; 0 wrong answers, unnecessary clarifications or execution
  failures. Clarification rate 25%; unnecessary clarification and wrong-answer
  rates 0%. Three unrelated-report negative controls rejected. These are fixture
  rates, not measured production reliability.
- Initial strict sandbox gate attempt failed without a completed TAP report;
  subsequent network-enabled localhost runs completed. The first completed gate
  had 383 passes/5 failures; the failures and corrections are described in the PR.
- Live SQL dry run blocked before execution by HTTP 403 at `oauth2.googleapis.com`. No deployment or production readiness
  approval is implied by the local checks.
