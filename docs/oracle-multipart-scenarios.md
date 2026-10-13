# Oracle multi-part analyses and scenario assumptions

## History and demonstrated failure paths

Work started from `7344dbf959c0b8b0b801f04789cc4a57494d721a`, the merge of
PR #318. GitHub's `main` reference was checked independently because the initial
sandboxed shell fetch could not reach its configured proxy. Existing PRs #304,
#306 and #308–#318 already contain shared planning, clarification consumption,
catalogue execution, terminal delivery, order-value selection, population SQL,
read failures, empty coverage, date binding and shipping diagnostics. Those
implementations were inspected and retained; the population SQL, snapshot
selection, finance definitions and source eligibility predicates are unchanged.

The supplied acceptance clauses are preserved in `FULL` in
`test/oracle-multipart-scenarios.test.js`. They were traced through:

1. `transitionAnalysisContext` / `orderValueContextPatch`: the original parser
   selected the first `from` clause, interpreting the £100–£350 **band range** as
   the baseline and scenario thresholds. The request resolved to baseline £100
   and thresholds £100/£350. Fresh current-main context nevertheless selected
   Shopify online with GB, GBP and 2026-01-01 through 2026-10-12.
2. `resolveExecutionPlan`: the supplied failure sentence appears in the shared
   order-value scope guard. A validated plan with `platform: null` or a wider
   platform scope was rejected here, before the dispatcher or provider ran.
   The rejection returned only that generic sentence. Both direct and UI
   dispatchers used this guard. Tests reproduce the submitted unspecified-plan
   case and verify that it now reaches the production provider factory.
3. Production composition: `server.js` creates `orderValues` and `productPrices`
   with `createOracleProviderDependencies`. `/agent` invokes
   `executeGovernedAgentAnalysis` before model tooling; the baseline dispatcher
   routes order values to `answerOrderValues`. Authenticated chat and durable
   jobs use `dispatchAnalysisRequest`, the same plan and evidence validators.
4. Provider evidence: the factory performs the governed histogram and coverage
   queries, independently of promotion and published-price reads. The real SQL
   preserves direct GB destination, exact GBP presentment currency, the online
   proxy, status/cancellation predicates, London dates and snapshot boundaries.
5. Presentation: ordinary successful current-main evidence already retained
   numeric sections. A separate recovery gap was demonstrated: missing prose
   plus a valid artifact caused delivery to return only “Your analysis download
   is ready.” Recovery now rebuilds visible sections from validated evidence.
6. Knowledge preflight: `suppressAnalyticalProposals` depended on an initial
   instruction verb. Noun-led acceptance wording and “Assess…” could propose a
   confirmed shipping policy. `/propose` did not apply the shared analytical
   suppression at all. Also, the early explicit-save branch replaced a combined
   analytical/save request with knowledge-only context, preventing calculations.

**Production attribution remains bounded.** No correlated original production
request/job ID, submitted context, deployed revision or provider trace was
supplied. Fresh current-main context did not reproduce the population-only
rejection. The exact rejection branch proves that this branch skips retrieval,
calculations and presentation, but does not prove which scope value entered the
original production request. No claim is made that the original incident queried
Shopify, failed retrieval, returned zero rows or discarded populated sections.
Those outcomes are separately tested and now separately observable.

## Shared changes

- Store validated operation declarations in the shared analytical plan. The
  capability planner distinguishes supported bands, conditional observed-basis
  threshold/price operations, and unsupported profit, behavioural forecasts and
  secondary period comparisons. Unsupported optional conclusions receive their
  own blocker and next action while the primary analytical sections execute.
- An unspecified platform can use the governed Shopify source. Explicit wider
  Shopify/Woo or all-platform requests receive a Shopify partial result without
  combining stores, narrowing dates or relaxing eligibility. Explicit Woo-only,
  non-Shopify store, incompatible channel/currency or unresolved required
  population filters remain blocked before reads, with actionable explanations.
- Parse band ranges, baselines, threshold comparisons and charges independently.
  “Currently £12 below £225” and separate illustrative fees remain request-scoped
  assumptions. No knowledge record is needed to calculate them. Explicit save
  commands stay available separately, including alongside an analysis.
- Preserve requested operations, source intent and scenario parameters across
  chart/export refinements. Include shipping destination in plan validation.
  Legacy envelopes may supply the destination only from their already recorded
  country, checked against the requested country; no new destination is inferred.
- Longer history uses at most four disjoint 366-day provider reads (eight SQL
  reads maximum), preserving the original window, the existing per-query 1 GB
  cap, deadlines, the combined 50,000 aggregate-row bound and per-window coverage.
  Beyond 1,464 days, planning gives a specific bound and next action before reads.
  Collection completeness remains unverified; no history is backfilled.
- Keep population failure, empty unverified coverage, promotion failure and
  incomplete/failed published-price evidence distinct. Optional failures preserve
  available numeric sections and expose the component's actual failure. Empty
  unverified coverage produces unavailable financial effects, not zero effects.
- Recovered delivery and presentation fallback reuse validated order-value
  business sections, without another provider call. Tables, charts, persisted
  workbooks and authenticated recovery consume the same plan and evidence.
- Suppress inferred analytical knowledge proposals in preflight, interactive
  responses and durable results. Proposal generation failures cannot replace an
  analytical answer. No approval/write endpoint is called by these changes.

The £8 scenario is never confirmed as business policy. Recorded shipping charges
remain partial sums of known original charges, independent of the fee assumption.
Observed subtotal does not verify shipping eligibility. Neither arithmetic fees
nor price-compatible products establish forecast revenue, conversion uplift,
fulfilment cost, profit or proven basket affinity. Add-on language now counts
baskets whose extra spend actually exceeds the supplied fee rather than assuming
this for every fee size.

## Validation

The new acceptance file covers the full supplied clauses, noun-led/Assess/Analyse
variants, the short September request, explicit and unspecified Shopify plans,
wider historical multi-source scope, unsupported profit/period/behaviour
components, non-default bands/charges/thresholds, optional knowledge proposals,
population retrieval failure, empty coverage, optional promotion/price failures,
plan tampering, legacy recovery, workbooks and sanitized diagnostics.

The tests use actual shared context and dispatchers, real production dependency
factories, BigQuery argument/SQL inspection and the native published-product
parser through an injected transport. Only external I/O is replaced by fixtures.
They assert provider calls, filters, typed dates, billing/time bounds, calculations,
visible sections and charts. Authenticated HTTP tests cover direct agent bridging,
interactive latest-result recovery, lease-owned durable persistence and repeated
polling. Export and failed-presentation recovery perform no rendering repair reads.
The fixture's £200 threshold affects three orders: £16 recorded known charges,
one unknown charge and a separate £24 illustrative fee. These are **test figures**.

Test totals and final commit/PR are recorded in the PR description and task report.
No live financial figures or deployed-browser verification are claimed.

## Bounded live checks remaining

Use the existing `diagnostics/oracle-analysis-incident.js` with the original
request ID and (if durable) job ID in the configured production read environment.
It reads at most one matching job with a 100 MB billing cap, 15-second query
limit, bounded metadata wait and the existing CLI deadline. Additional output
contains platform/store, destination/currency, population-attempt flag, retrieval
statuses, safe failure stage/code/reason and eligible-population status. It does
not print prompts, query text, customer identities, rows or financial amounts.
Interactive incidents still require correlated deployed provider-stage logs.

Check the deployed revision, actual submitted platform/store scope, whether the
population provider was attempted, histogram versus coverage status, empty versus
failed population, and persisted/visible section counts. Then run the exact full
and September requests in the authenticated production UI and confirm browser
rendering, reload/poll recovery and authenticated workbook download. The existing
bounded order-value and shipping-evidence diagnostics can verify deployed SQL,
component coverage and financial ambiguity without changing eligibility.

Live BigQuery schemas, SQL dry-run acceptance, current Shopify population and
promotion context, current published UK prices and deployed browser delivery
remain unverified here. No collection, backfill, inventory calls, source/knowledge
mutation, schedules, deployment or merge is part of this work.
