# Multipart analysis, basket detail and XLSX delivery

Base: latest GitHub main `0978a15293163c79f120faf2b274b9c60fca9687`
(merged #331, #330, shared completeness #329, basket #326 and SQL #327).
The checkout's original `work` branch matched that SHA; its origin/main tracking
reference was older. GitHub main was verified through the connector, then the
tracking reference was corrected and a fresh `fix/oracle-component-detail-exports`
branch created from that main. A subsequent network-enabled Git fetch agreed.
Open PR inspection found only unrelated product-mapping diagnostics #123.
No merged feature branch was reused.

## Demonstrated causes

* Basket capability selection returned immediately, dropping other analytical
  operations such as requested bands and conditional shipping scenarios.
  “Basket averages/medians” also lost its mean/median declarations.
* Context represented population and threshold settings but lacked independent
  highest-unit predicates, basket-total intervals, overlap, detail and multi-format
  requirements. A related composition summary could therefore appear unchanged.
* The basket calculator fixed its subset at highest unit below 250 / total at
  least 250 and its bands at 250–<275 / 275–<300 / 300+. Presentation always led
  with the same threshold comparison. The requested 250–<260 split and 200–<250
  highest-unit overlap were not calculated.
* Promotion clarification consumed a whole message containing an exclusion
  refinement, silently dropping its additional calculations. The shared
  transition now applies those calculations after consuming the calendar answer.
* A scalar output preference and operation-only completeness check did not prove
  XLSX persistence or independently account for missing charts/downloads.

These source defects are reproduced locally. Repeated production counts alone
establish neither cache reuse nor stale collection. The deployed revision,
production schema/query validity, job state and actual counts remain unverified.

## Contract and execution

The existing context, analytical plan, capability registry, dispatchers and
result contract remain the owners. `request-detail.js` is a validated projection
of calculation/detail requirements used by the existing order-value transition;
it is not another planner. It separates predicates, exact integer-penny bands,
main-unit overlap, grouping/ranking/limit, detail and chart/XLSX requirements from
population, calendar exclusions and presentation. Delivery-only format changes
do not change the analytical plan key. Subject switches clear incompatible detail.
Unbound “same dates/population” references ask for the missing dates/exclusions
(and destination/currency if absent), rather than inventing a replacement scope.

The existing bounded basket batch and historical discount/reconciliation rules
remain unchanged. Subset membership and overlap are calculated directly, including
repeat-unit versus different-root-product counts. Main-item ties retain product
then line identity ordering. Combination grouping uses root identities, quantities
and observed allocated prices; title variation does not split identical identities.
Different prices appear as separately labelled observed-price combinations.
Ranked combination output defaults to 20, supports an explicit top count up to 100,
and discloses its bound. Composition never establishes purchase intent.

Multipart order-level mean/median, value bands and shipping scenarios run through
the existing order-value provider/calculator alongside the reconciled basket batch.
Their denominators are explicitly separate. Requested fixed-width value bands
extend through observed values, with a 100-band ceiling and a labelled overflow;
a populated overflow is a partial component, not exact-width completion.
Recorded unknown/ambiguous-zero charges and conditional scenario semantics remain.

`answer-completeness.js` recomputes basket proof, not just subject/date metadata.
`component-outcomes.js` records delivered, partially delivered, failed, unsupported
or clarification-blocked outcomes. XLSX success requires an artifact download;
prose cannot satisfy it. This accounting is in shared terminal delivery, including
direct/interactive, durable persistence/polling, native/model result delivery and
recovery callers. Provider-specific evidence validation remains mandatory first.
This is not a claim of new model capabilities or exhaustive model evaluation.

Weekly campaign, calendar product and calendar cohort regroupings without a
compatible producer return explicit limitations before reads. Existing supported
product, campaign, monthly country-conversion and cohort calculations remain.
Campaign, product and country-conversion XLSX execution is retained; cohort XLSX
is still unsupported. Cross-subject regressions distinguish those outcomes.

## Artifacts and privacy

Supporting workbooks contain exact coverage, comparisons, basket bands,
combinations and smaller-product tables, plus requested order statistics,
order bands, scenarios and component outcomes. Explicit underlying exports add
anonymous reconciled basket rows: export-scoped opaque reference, sale-exclusion
flag (unknown when exclusion dates are unresolved), subtotal, highest product/allocated discounted unit price, remaining
product names/quantities/prices and remaining combined value. They include all
reconciled baskets in the requested window; the flag identifies the comparison
exclusion. They contain no customer fields, raw order identifiers or admin links.
New internal proof replaces raw order IDs using an ephemeral random HMAC key
that is never saved, and allowlists governed source fields. Export references
are scoped again to the artifact. Existing legacy envelopes retain their original
validation/recovery contract; they cannot answer newly requested calculations.

The existing owner store, authenticated downloads, persisted hash/workbook
validation and deterministic owner/request artifact ID remain. Same-ID saved
basket exports recover before any provider call. Evidence is checkpointed before
supplemental execution and export, and survives later presentation/persistence
failure. The durable store's 8 MB limit is disclosed precisely, with no truncated
rows and a narrower-window/aggregate-export option. Basket reads still allow at
most 20,000 orders, 100 lines/order and 366 days. Exceeding the provider bound does
not produce an aggregate substitute labelled as basket detail.

## Acceptance and verification

Exposed incident wording is in `test/fixtures/oracle-multipart-questions.json`;
no incident count is used as a production expected result. The persistent matrix
registers `test/oracle-multipart-detail.test.js`. Existing held-out independent
evaluation data was not changed or relabelled as acceptance.

The specialised suite asserts actual provider scope/arguments, separate
populations, exact membership/boundaries/overlap, observed prices/quantities,
workbook headers/cells, anonymous references, ownership, interactive and durable
transport, same-ID retries, refresh/manifests without replay, changed bands and
exclusions, fresh/unbound references, aggregate/detail/export transitions, valid
zero subsets, empty evidence, provider/persistence/size failures, altered proof,
legacy recovery and cross-family exports/unsupported regrouping. A repeated
threshold summary fails the detail operation. Browser acceptance additionally
uses the actual composer, visible detail finding, downloads and refresh on
desktop/mobile. Fixture transport is read-only and production-shaped; it is not
live SQL acceptance.

Final release results are recorded in the PR. Initial runs found and repaired:
1. whole-message promotion consumption;
2. recovered product artifacts missing the new format accounting;
3. a routing-only test that incorrectly expected bare “OK” for an uncreated XLSX;
4. a browser test supplying a relative URL to Playwright's API client;
5. test expectations using the wrong workbook column and an incorrect fixture sum.
Initial unprivileged HTTP tests could not bind loopback; tests then ran with local
network access. Existing Playwright/Chromium were used; no package was installed.

## Bounded live verification / Render

The production diagnostic was attempted using existing configuration. It failed
at dataset-location lookup with HTTP 403, before schema inspection, dry run or
population execution. There is no attached Render log/shell service. No live
readiness, freshness, schema validity or production count is claimed.

From the existing Render checkout, these exact commands create only a temporary
source checkout and execute bounded read-only diagnostics. They do not modify the
deployed checkout, collect/backfill, query inventory, deploy or change permissions:

```sh
oracle_live_src="$PWD"
oracle_probe_root="$(mktemp -d /tmp/oracle-multipart.XXXXXX)"
timeout 45s git clone --depth 1 --single-branch --branch fix/oracle-component-detail-exports https://github.com/lmnopstudios-dot/tgf-bigquery-sync.git "$oracle_probe_root/src"
ln -s "$oracle_live_src/node_modules" "$oracle_probe_root/src/node_modules"
git -C "$oracle_probe_root/src" rev-parse HEAD
node --input-type=module -e 'console.log(JSON.stringify({deployed_revision:process.env.RENDER_GIT_COMMIT||null}))'
node "$oracle_probe_root/src/diagnostics/oracle-order-value-bindings.js"
timeout 75s node "$oracle_probe_root/src/diagnostics/oracle-basket-composition.js" --start 2026-01-01 --end 2026-10-16 --execute-read-only
timeout 75s node "$oracle_probe_root/src/diagnostics/oracle-basket-composition.js" --start 2026-01-01 --end 2026-10-17 --execute-read-only
timeout 300s node "$oracle_probe_root/src/diagnostics/oracle-order-values.js" --start 2026-01-01 --end 2026-10-17
```

Confirm the probe SHA equals the PR commit before interpreting output. Each basket
probe has at most six SQL jobs, 1 GB/query, 15-second query waits, a 60-second total
deadline, and the existing 20,000-order/100-line bounds. It returns aggregates,
coverage and explicit selected-subset calculations, never order/customer rows.
The order-value probe has its existing eight-submission ceiling, query deadlines,
billing caps and output limits. Bindings inspection performs zero provider calls.

Compare requested cutoff with latest observed eligible order date and per-component
collection timestamps. Equal totals with a newer requested date can be valid when
no additional eligible evidence exists; stale collection needs collection/coverage
evidence. These direct warehouse probes bypass Oracle result caches. Establishing
cache/recovery reuse additionally requires the affected owner's stored plan/result
and deployed revision/logs. Do not infer freshness or a cache defect from unchanged
counts or label the requested cutoff as observed coverage.

Short deployed acceptance sequence: submit INITIAL, then DETAIL, then UNDERLYING
from the exposed fixture file; verify different visible findings, four exact bands,
direct overlap, both denominators, charts and actual authenticated XLSX contents.
Refresh the final download, retry its request ID, check another owner is denied,
and verify no new provider execution. Repeat after an unrelated scope; unresolved
references must clarify instead of reusing that unrelated population. Record
supported execution, partial sections, explicit limitations, clarifications and
incorrect answers separately. Do not add or infer the incident's 113/2,922 counts.
