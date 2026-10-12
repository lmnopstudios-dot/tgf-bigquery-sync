# Shared Oracle analytical planning and weekday sales

## Revision and demonstrated causes

Started a new branch from hosted `main` at
`a61de7dd0daeae1a8cbef03ac0cf435699d92d2f` (merged PR #303). The initial
sandbox network setting prevented fetch; enabling network access allowed a
normal fetch, which confirmed that revision. The GitHub connector independently
confirmed the same head. PR #302's native category export and PR #303's
campaign-relative continuity implementations are present and preserved.

These are repository/fixture demonstrations. The original incident requests,
600-row workbook, job IDs, deployed revision and production logs were not supplied.
They cannot establish the exact production execution or deployment state.

| Incident | Demonstrated mechanism | Current handling |
|---|---|---|
| Pendant export → “Units sold” | Before #302, the product config had no category field, and catalogue retrieval/enrichment/ranking had no category predicate. The category was never represented; a resolved predicate was not simply dropped by the clarification. | Preserve #302's structured classification, complete pagination, selected root IDs, scoped enrichment, unavailable cells, workbook and recovery checks. Add shared plan projection and short-month refinement coverage. |
| Last campaign → “Since it was sent” | Before #303, generic email classification required calendar dates without selected campaign identity/send-relative date semantics. The date parser could not fill that field, so clarification repeated. | Preserve #303's governed sent identities, candidates and actual send metadata. The shared plan exposes that pending/resolved state and its reporting timezone. Provider hydration and recovery cannot replace the submitted subject/population. |
| Online sales by weekday, accounting for May sale | At the branch base, `analysis-context.js` did not represent weekday grouping or promotion treatment. Ordinary sales selected the operational baseline, forced a channel breakdown and cleared online scope. `baseline-overview.js` requested both Online Store and POS in monthly sections using summary calls. No compatible daily aggregation or confirmed sale exclusion was built. | Represent grouping/channel/promotion/ranking independently; select the audited daily capability; issue Online Store `TIMESERIES day`; verify shop timezone/identity/currency; aggregate covered eligible calendar days and an explicit sale-excluded comparison. |

The third failure is a parsing/scope/capability-selection and aggregation defect,
not demonstrated Shopify retrieval failure. The old baseline could successfully
retrieve the wrong analytical population. Recovery previously checked subject
and some optional metric/date metadata without enforcing weekday grain or sale
exclusions. The new daily evidence contract rejects those stale monthly results.
Browser verification also demonstrated an existing presentation defect: grouped
bars scaled each group independently. Financial bar groups now share a scale
within the same currency.

## Request-to-delivery trace

1. Current message enters `transitionAnalysisContext`. Existing product/campaign
   handlers retain their validated scope; independent analytical refinements
   represent grouping, native measures, ranking and promotion treatment.
2. `resolveAnalyticalPlan` projects the validated context, including existing
   product report config and campaign request. It separates subject/entities,
   catalogue population, platform/store/channel/currency, metrics/definitions,
   dimensions/grain, dates/timezone/cutoff/partial policy, comparison periods,
   promotion/exclusions, ranking, presentation/columns and pending fields.
   It introduces no second competing conversation store.
3. `resolveExecutionPlan` combines audited capability contracts with the existing
   executable dispatch bindings. A rejected combination returns a specific
   limitation; it cannot select a monthly, POS, conversion or all-products fallback.
   Existing governed routes remain registered and reachable.
4. Product providers receive selected root IDs/URLs after complete native category
   inspection. Campaign providers receive selected ID/account/channel and the
   supported requested dates. Daily sales receives the resolved period/store,
   online scope, currencies and reporting timezone; its actual ShopifyQL query
   contains `WHERE sales_channel = 'Online Store'` and `TIMESERIES day`.
5. Daily reporting metadata comes from the configured shop's `id`, `currencyCode`
   and `ianaTimezone`. A non-London/unverified daily timezone cannot be re-zoned
   from aggregates. Rows retrieved before a metadata failure remain persisted
   in supporting evidence without an unverifiable financial ranking.
6. Knowledge retrieval and sales settle independently. Confirmed day/range sale
   records with provenance establish exclusion dates, including named early
   access. Truncated, absent, imprecise or failed knowledge leaves unadjusted
   figures usable and the adjusted comparison unavailable. A supplied ISO sale
   date range fills that pending field without changing the analysis window;
   its user-supplied provenance is retained.
7. One aggregation creates Monday–Sunday totals, native orders, eligible-day
   counts and averages, both included and sale-excluded. Unequal weekday
   occurrence counts do not decide the ranking. Explicit zero days require
   complete daily evidence; missing days do not enter the denominator as zero.
   Missing individual measures remain unavailable. Expected/covered days and
   provisional results are explicit.
8. Table, business finding, chart datasets and XLSX consume those same rows.
   Detailed daily evidence, coverage, excluded dates and definitions are in
   Show details. Charts use common financial scales. XLSX persistence uses the
   existing owner-scoped artifact store and stable request-derived artifact ID.
9. Interactive cache and durable checkpoints retain validated successful
   evidence before optional delivery work. BigQuery JSON key ordering is
   canonicalized before agreement checks. Idempotency validates the submitted
   analytical scope as well as the original message. Failed/unsupported analyses preserve
   prior scope and evidence; a separate bounded pending intent supports explicit
   retry. Resolved shop/currency identities commit only to the unchanged pending
   request. Older job polling cannot replace a newer analysis's cached evidence.
10. Job polling checks both submitted-to-resolved scope and actual evidence.
    Weekday recovery recomputes eligible rows, totals, denominators, exclusions,
    definitions and chart agreement. Export manifests validate the saved context
    and expected analytical plan. Browser refresh restores the owned workbook
    without another provider read. Existing product artifacts retain their
    original full report-config/selection contract rather than acquiring a
    delivery-only metadata copy inconsistent with stored evidence.

## Audited capabilities and limitations

The shared registry audits product export, sent-campaign attribution, operational
Shopify baseline and daily weekday sales contracts. Other routes continue through
existing governed adapters; their names do not establish additional capability.
The default engineering rule is scoped to `oracle/AGENTS.md`. No existing
contributor/agent guidance was present to replace.

- Weekday binding: one configured Shopify shop, Online Store only, source-native
  ShopifyQL `net_sales` and `orders`, shop currency, verified Europe/London daily
  reporting. `net_sales` is gross sales minus discounts and returns; it is not
  canonical finance or presentment-currency line sales. Another shop identity,
  POS/Woo, unverified/different timezone, gross/total sales or profit measures,
  unsupported population filters, another grouping or a second reporting-period
  comparison cannot silently substitute a different population or measure.
- ShopifyQL retrieval alone does not verify complete collection or omitted zero
  days. Production currently supplies no completeness proof, so results remain
  provisional unless a governed provider supplies complete daily evidence.
- Missing confirmed sale dates leave adjusted averages unavailable. Matching
  phases retain their actual dates, not all May or a nominal bank holiday. The
  comparison describes observed differences, never causal promotion uplift.
- Campaign reporting remains calendar-month message attribution. A precise
  since-send timestamp slice, distinct order/customer counts, historical window
  equivalence, flows as “latest campaign”, SMS or another account in the current
  production binding remain unsupported. Counts use source-native credited
  conversion events/purchase provenance and currencies remain separate.
- Product allocated refunds/net units/profit/conversion remain unsupported where
  existing capability definitions say so. Missing analytics do not remove a
  matching root product or become zero. Ambiguous structured classifications
  still require a source choice; titles are never a classification substitute.
- Pending interactive retry state is session-scoped and expires after 15 minutes;
  durable job/context/artifact recovery uses the existing persisted contracts.

## Local verification

The completed full repository suite passes **1,048 tests**, with **3 existing
opt-in BigQuery syntax-validation skips** and no failures/cancellations. Strict
tool-schema validation passes **46 schemas across 61 tools**. Focused final
product/campaign/weekday coherence checks pass **66/66**, and final idempotency,
product export and durable-worker checks pass **74/74**. The combined shared
plan suite passes **14/14**. `node --check` and `git diff --check` pass. All data
providers use mocked fixtures; live acceptance is separate.

`test/oracle-shared-analytical-plan.test.js` exercises the real shared dispatcher,
production dependency factory, product source loader, provider arguments,
selected IDs, exact averages/denominators, workbook cells and headers, chart
values, direct agent entrypoint, interactive/durable HTTP, owned downloads,
explicit retry, manifest mismatch and stale recovery rejection. The combined
conversation runs filtered product export → selected campaign → weekday sales →
conversion. Existing category/campaign, customers, historical Woo conversion,
calendar-month, Black Friday, presentation, charts and durable/export suites stay
in place. Read-only diagnostic tests assert exact scopes and SELECT-only job SQL.

Offline Chromium acceptance runs the real UI and owned XLSX endpoints on desktop
and mobile: weekday bar chart with a common scale, collapsed Show details,
Enter/Space controls, semantic tables, accessible scrolling, viewport fit,
workbook download and refresh recovery without provider rereads. A combined
chart-and-XLSX request retains both deliveries; chart wording cannot overwrite
export intent. Both the interactive and actual composer/durable-worker paths
are verified. The existing
presentation browser diagnostic also passes. Screenshots are generated under
`/tmp/oracle-weekday-browser` and `/tmp/oracle-presentation-browser`.

The first full run's six failures were introduced by adding a delivered-only
plan to existing persisted product artifacts and clearing failed-subject
clarification on a compatible follow-up. Both mechanisms were corrected; the
57 affected regressions passed. No interrupted or hanging test run is counted
as a pass. Completed full runs exit normally; no leaked handle remains blocking
verification. A subsequent full run exposed the existing worker-backoff test's
38 ms wall-clock assumption under parallel load (one claim rather than two or
three). Its timers now advance deterministically through the 10/20 ms backoff
and stop boundary; the production worker is unchanged.

## Live acceptance — not performed locally

After deployment through the normal separate release process:

1. “Export Shopify pendants” → “Units sold.” → “Sort by landing sessions
   instead.” → “Include organic clicks too.” → “Just September.” → “Export all
   products instead.” Confirm the category remains until explicitly cleared;
   preview/chart/XLSX contain the same root IDs and dates, including unmatched
   products with unavailable cells. Retry and refresh the owned download.
2. “How did the latest email perform?” → “Since sending.” Confirm a verified sent
   campaign identity, actual send/reporting cutoff and visible whole-month
   limitation. The answer must advance, preserve native credited counts and avoid
   calling them causal sales or distinct orders.
3. Ask the supplied online weekday/May-sale question → “By orders instead.” →
   “Include the sale again.” → “Just September.” → “Export that.” Confirm daily
   Online Store calls, completed London days, confirmed sale/early-access dates,
   denominators, common chart scale, consistent workbook and restored download.
   Repeat after customer, online/POS and conversion conversations.

Production permissions, reporting metadata, classification populations, sale
records, completeness and deployment acceptance remain unverified. No production
queries, collection/backfill, inventory calls, source/knowledge mutations,
watermark resets, schedule changes, deployment or merge occurred in this task.

## Exact bounded read-only diagnostics

Run from the repository in an authorized production diagnostic environment.
These commands do not start the application, create jobs/artifacts, set up tables,
collect sources or read inventory. Credentials are used normally and never printed.

```sh
# Native categories: at most 7 root pages, 25 GraphQL reads (plus OAuth);
# native collection membership is inspected, with incomplete reads disclosed.
node diagnostics/oracle-shared-plan-readonly.js --mode catalogue --category pendants

# Actual Shopify daily contract: 31 days, Online Store only, identity/currency/timezone.
node diagnostics/oracle-shared-plan-readonly.js --mode sales --start 2026-05-01 --end 2026-05-31

# Confirmed promotion phases: one bounded knowledge read, at most 50 records.
node diagnostics/oracle-shared-plan-readonly.js --mode promotion --query 'May bank holiday sale' --start 2026-01-01 --end 2026-10-11

# Sent-campaign metadata: one governed query (LIMIT 501; at most 10 candidates displayed).
# Omit cutoff for the actual runtime instant; this sample pins a reviewed incident cutoff.
node diagnostics/oracle-shared-plan-readonly.js --mode campaign --cutoff 2026-10-12T12:00:00Z

# One identified incident job, LIMIT 1, maximumBytesBilled 500 MB.
# Replace the placeholder with the original incident's actual UUID; none was supplied.
node diagnostics/oracle-shared-plan-readonly.js --mode job --job-id ORIGINAL_JOB_UUID
```

The last command reports stored pending/resolved context, evidence agreement,
subject, dimensions, periods, selected campaign/catalogue population, coverage,
row count and exclusions. Use the authenticated owner-scoped existing export
manifest/download endpoints for the corresponding artifact; the interactive-only
incident may have no durable job, in which case its deployment logs and original
owned workbook are required. Retain the correlation ID/deployed revision and
compare the original request through those recorded stages before attributing
any remaining live failure to this implementation.
