# Oracle stabilisation and acceptance gate

## Implementation map (before changes)

Inspected main `5e41346`, including merged campaign PR #323 (`d31a788`).
That implementation is reused, not replaced. Hosted source history is not proof
of the deployed revision; confirm the deployed revision during acceptance.

| Layer | Shared owner and callers | Divergent or legacy behaviour |
|---|---|---|
| Scope | `analysis-context.js:transitionAnalysisContext`; UI chat and job submission, direct `/agent`, baseline document handling | Product exports override rolling dates locally; general date parser lacks arbitrary completed days. Subject handlers retain some incompatible dates; campaign pending selection can consume a new sales question. |
| Calendar dates | `report-natural-period.js`; context, campaign, social, numeric scenarios, daily sales and product reports | Daily/numeric providers deliberately use completed days; knowledge dates describe assertions rather than analysis. Search-order `after` semantics remain provider specific. |
| Entity scope | `campaign-context.js`, `entity-relative-scope.js`, `campaign-resolution.js`, `campaign-set-analysis.js` | Metadata hydration and account/channel selection happen in provider orchestration. Monthly attribution cannot become exact post-send data. |
| Clarification | `analysis-context.js:clarificationFor`; direct, dispatcher, UI preflight and pending-intent bookkeeping | UI also calls knowledge `campaignDateClarification` before dispatcher. Campaign/product providers ask identity or metric questions. Model fallback has its own natural-language instructions. |
| Capability | `analytical-capabilities.js:resolveExecutionPlan`, `analysis-route-dispatcher.js` | Registry covers only some bindings. `baseline-dispatcher.js` searches legacy message recognizers for unbound routes; server model tools retain supported general analytics and provider-specific conversion/pageview paths. |
| Providers | `provider-dependencies.js`; server composition at `ecommerceBaselineOverview`, `generalAnalytics`, `productPriorityExport`, `historicalEventComparison` | No abandoned-checkout/cart storage reader, governed metric contract or tool exists in this repository. Orders cannot establish abandonment or recovery. No collector is added. |
| Delivery | `result-delivery.js`, strict plan/evidence checks; direct and dispatcher, UI cache/checkpoints, owned job polling and export recovery | Model fallback and native conversion handlers have separate presentation. UI latest-result cache is process-local; durable stored results survive restart. Browser recovery consumes authenticated endpoints. |

These are inspected callers, not a claim that all Oracle behaviour is unified.
The acceptance gate below must verify the paths changed in this task and retain
the existing provider and delivery regressions.

## Demonstrated defects, ownership and inheritance

| Demonstration | Owning change | Callers inheriting it | Boundaries retained |
|---|---|---|---|
| Completed-day scope disappeared on sales/customer/conversion requests, while exports had two local rolling parsers | `report-natural-period.js` now resolves bounded numeric/word day and completed-month windows from the London runtime. Both export overrides are removed. Invalid periods retain a typed issue and cannot silently reuse old dates. | Shared context, direct agent resolution, interactive transitions, durable submitted snapshots; campaign, social, daily/numeric and product-report callers | Daily/numeric providers still intentionally exclude the current day. Orders retain their UTC date binding; knowledge assertion dates and `search_orders` exclusive `after` semantics remain separate. |
| “Sales for the past 30 days” selected a product called “the past 30 days” | Product subject inference consults the same calendar resolver before treating a phrase as an entity. | All shared context callers; both direct and dispatched sales execution | Named-product identity selection remains provider owned. |
| A pending campaign could consume a new sales/country question | Campaign continuation yields to explicit unrelated analytical subjects. | Direct, interactive and durable transitions | Sent entity selection, account/channel ambiguity, cutoff and attribution windows reuse merged #323 unchanged. |
| Checkout instructions containing customer/revenue words became an unrelated analysis or a generic date question | Recognize the analytical population; record the audited absent binding in `UNAVAILABLE_ANALYTICAL_CAPABILITIES`; use one capability-first decision | Direct deterministic entrypoint, dispatcher, interactive preflight, job worker and polling of their persisted results | No checkout/cart metrics, collector, backfill or inference from orders is introduced. If a governed reader is added later, audit its identities/definitions/coverage/recovery linkage and replace the unavailable contract with verified binding tests. |
| UI asked before shared capability checks; generic questions had no field/reason contract | `analysis-decision.js` owns execution/clarification/limitation, bounded fields/reasons/method diagnostics; UI uses it and scopes knowledge-date checks to nonanalytical requests | Direct, shared dispatcher, interactive, durable. New results carry resolved context except existing product artifact contracts | Provider-owned campaign identity and product metric questions remain. The general model still synthesizes supported fallback answers; its reasoning is not proven by local fixtures. Direct model input now receives the resolved context too. |
| Explicit “this month versus last month” used the baseline's default previous month | Shared calendar resolves both periods; named calendar comparisons are ordered consistently | Shared date/context consumers including customer provider calls and rendered comparisons | Calendar month comparison remains full previous month unless matching elapsed periods are requested. No incompatible granularity is fabricated. |
| Category metrics without the word “products” missed the existing report | Existing category/metric recognizers select the same governed report; no separate category parser | Shared context, interactive/durable product report and its provider/workbook binding | Native classifications, selected IDs, complete catalogue and unavailable cells remain mandatory. |
| Consolidated pending questions changed export retry strings or weakened legacy category recovery | Execute governed replies using current message + structured context; preserve `scope_request` independently for recovery integrity validation, with legacy message fallback | Interactive and durable submission, same-ID retries, owned polling/recovered artifacts | General model pending requests can still use their text context. Original provenance is never a replacement parser input for governed execution. |

The declarative registry is still a partial audit of capabilities. All routes
remain registered in `ANALYSIS_ROUTE_DISPATCHERS`; `createOracleBaselineDispatcher`
still selects legacy recognizers for routes without an explicit binding. Native
conversion/pageview fallbacks and model tool execution in `server.js` remain
separate. No claim is made that those implementations were consolidated by this
change. The gate protects their existing regressions where listed.

Existing persisted jobs keep their submitted dates; recovery validates them
rather than re-resolving their relative wording at a later runtime. New jobs
inherit the shared transition and decision. An old generic clarification cannot
be retroactively corrected without an explicit new submission/retry.

## Persistent matrix and release gate

`test/fixtures/oracle-acceptance-matrix.json` contains the central staff
conversations, pinned runtime, expected subjects/dates/fields, provider
assertions and representative conversations owned by related regression suites.
Its suite registry is executable: the gate runs those files, not just a prose
checklist. The registry covers campaigns, conversion, named products, filtered
exports, customers, countries, order-value/shipping scenarios, exclusions,
governed Black Friday comparisons, unsupported requests, failed intervening
requests, document/knowledge boundaries and recovered jobs.

`test/oracle-acceptance-matrix.test.js` executes the central conversations via
localhost HTTP around the actual shared direct entrypoint, authenticated
interactive router and lease-owned durable worker/polling. It does not boot the
credential-dependent monolithic production server. The fixture uses the actual
baseline composition, native Shopify sales-query builder and production
provider dependency factory; only remote rows/metadata are supplied by fixtures.
Assertions cover actual SQL/arguments, split date windows, source-native AOV,
compatible units/orders, country AOV, partial retrieval, missing campaign
metadata, zero calls for unsupported checkout and stored-result recovery.

Related suites provide the more specialised production factories, actual
filtered workbook bytes, entity IDs, conversion numerators/denominators,
shipping scenario arithmetic, exclusions and failure/recovery contracts. These
are fixture executions, not a live source availability audit.

Run from the repository:

```sh
npm install --ignore-scripts --no-package-lock
npm run test:oracle:acceptance
# A Playwright driver and Chromium must already be available in this environment.
ORACLE_BROWSER_DRIVER=/absolute/path/to/playwright-core/index.mjs npm run test:oracle:browser
node --test
```

The gate writes `/tmp/oracle-acceptance-gate.tap` and requires a completed TAP
report with zero failures/cancellations, as well as successful child execution.
Interrupted runs are failures. Browser acceptance uses the actual composer,
rendered summary/details, desktop/mobile viewports and durable refresh without
provider rereads; screenshots go to `/tmp/oracle-acceptance-browser`.
`.github/workflows/oracle-acceptance.yml` runs both gates and uploads their
artifacts for PRs/main. Required-check protection on the hosted branch must be
configured by repository administrators; it is not changed here.

To extend the gate:

1. Add a conversation with a stable semantic ID, runtime, expected scope and
   provider/calculation assertion to the JSON and shared fixture runner. Include
   a paraphrase and a valid/invalid or missing-evidence counterpart.
2. For a specialised population/provider, extend its real factory/HTTP tests and
   register that suite plus representative questions in `regression_suites`.
   Verify IDs, provider dates/predicates, source grain/definitions and actual
   arithmetic/artifacts. Do not substitute a successful result mock for them.
3. Include subject switches, answered clarification, unrelated/failed requests
   and persisted recovery. Add visible browser assertions when delivery changes.
4. Run both gates and relevant full checks. Record any skipped live checks
   separately. Never remove a failing acceptance case just to release a change.

## Deployed acceptance sequence (not executed here)

After normal review and deployment by the separate release process, record the
actual deployed revision and correlation IDs. No deployment/merge is part of
this task.

1. Run “How did the last 3 Klaviyo campaigns go?” through direct `/agent` and
   the staff composer. Confirm actual sent IDs/account/channel, summary/table,
   exclusion of drafts/scheduled campaigns/flows, attribution definitions and
   monthly/immature-window limitations. Follow with “What about the previous
   three?” and “Since it was sent.” Refresh the owned result/export.
2. Ask the supplied UK abandoned-checkout question. Expect the exact missing
   evidence boundary and the resolved last 30 completed London days, no generic
   date question, no order inference and no collection. Repeat after a campaign
   clarification and a failed conversion request.
3. “Show online sales.” → “Last 30 completed days.” → “Which countries bought
   the most this year?” → “Compare Shopify customers this month with last
   month.” Verify provider arguments and the explicit comparison periods. An
   invalid/reversed range must ask specifically for corrected dates and make no
   provider call. A valid reply must advance.
4. “Show pendants by units sold over the last 30 completed days.” → request
   export. Compare catalogue root IDs, provider dates, preview and downloaded
   cells. Then run mobile/desktop conversion this year → “What changed between
   August and September?” Verify same-grain numerators/denominators. Repeat the
   existing governed shipping/exclusion and Black Friday sequences from the
   registered suites; missing evidence must remain unavailable rather than zero.
5. Repeat one job submission with its correlation ID; refresh during and after
   completion. Confirm a visible terminal result, owned polling and recovered
   evidence/artifact agreement without provider replay. Inspect a failed
   intervening request followed by an explicit retry and an unrelated subject.

## Exact bounded read-only live diagnostics

Run only in an authorised diagnostic environment. These inspect existing stored
state; they do not create analysis jobs, collect/backfill, query inventory,
mutate source/knowledge, alter schedules or deploy. Credentials are used normally
and never printed. Runtime credentials in this workspace were not established
as ready, so no live source query was attempted.

```sh
# Print bounds/required configuration without remote reads.
node diagnostics/oracle-campaign-selection.js
# At most 7 SELECTs, 1 GB/query, 15 s/call, 60 s total, three campaigns.
node diagnostics/oracle-campaign-selection.js --execute-read-only
# One existing incident UUID, LIMIT 1, 500 MB; no job creation.
node diagnostics/oracle-shared-plan-readonly.js --mode job --job-id EXISTING_INCIDENT_UUID
# One bounded sent-metadata query, LIMIT 501, at most 10 displayed candidates.
node diagnostics/oracle-shared-plan-readonly.js --mode campaign --cutoff 2026-10-14T12:00:00Z
```

Also GET the existing authenticated owner-scoped `/api/oracle/jobs/<UUID>` and,
where present, `/api/oracle/exports/<artifact-id>/manifest` and download. Compare
persisted plan, selected IDs, periods, evidence/artifact and visible browser
answer. Do not post a new job as part of a read-only incident inspection.

Additional audited entrypoints: `clarification-consumption.js` consumes pending
promotion, product-selection, campaign and report-field replies before ordinary
transitions; `analysis-delivery-state.js` retains failed-subject intent and
explicit retries. `ui-router.js:/analysis/route` and
`public/oracle/request-routing.js` choose transport without provider reads.
`requested-operations.js` retains its audited multi-component/unsupported
operation preflight before the common decision in both shared execution
entrypoints. These specialised contracts have not been replaced by a general
parser. The production `server.js` model-tool path still applies
`applyJourneyAnalysisContext` and `applyOrderDateScope`; the provider registry
and `governedModelInput` do not constitute a universal model-argument validator.

## Completed local verification

- `npm run test:oracle:acceptance`: **315 passed**, zero failures, cancellations
  or skips; 9 central conversations plus 14 registered provider/delivery suites.
- `node --test`: **1,349 tests: 1,346 passed, zero failed, 3 skipped**. The skips
  are opt-in live BigQuery statement/dry-run validations (annual finance,
  semantic statements and reconciliation), not Oracle fixture acceptance.
- `npm run test:oracle:browser` with the installed Playwright driver and Chromium:
  desktop/mobile matrix and durable refresh passed; no page exceptions or
  viewport overflow. Visible country AOV is verified in expandable details.
- Syntax checks for server, shared context/decision and gate/browser scripts,
  plus `git diff --check`, passed. Campaign diagnostic plan mode performed no
  remote reads and confirmed its documented limits.

Earlier failing runs exposed and led to the export idempotency/provenance,
named-month comparison, category-versus-product identity and campaign revenue
refinement regressions now protected by the gate. Only completed final runs
above are counted as passes. No live BigQuery/API evidence read, collection,
backfill, inventory request, source/knowledge mutation, schedule change,
deployment or merge was performed. CI and deployed acceptance are separate
from these completed local checks.
