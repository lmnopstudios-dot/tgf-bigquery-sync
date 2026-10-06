# Oracle report and conversation continuity

Branch base: latest `origin/main`, `311982658eab3aa8a54ac009d91127e4c3263d6b` (merged PR #294). GitHub connector verified this SHA; a subsequent permitted `git fetch origin main` succeeded. The merged exports, selections, governed providers, storage and chart contracts are extended in place.

## Demonstrated causes and changes

- Product exports: the continuation predicate accepted broad `show`/`sales` requests and could consume a new analytical subject as an export refinement. It now accepts compatible metric/date/population refinements and releases explicit conversion, named-product and email subjects. “All published Shopify products” clears a previous selected-ID subset/top-N; hyphenated top-selling requests clarify units versus value. The source loader previously prefixed an absolute landing URL with the configured origin, making it invalid. Relative and absolute provider shapes are now distinguished. Numeric XLSX columns retain blanks versus verified zeros; an appended ranking-status column identifies unrankable products. Each requested metric records bounded join counts without URLs or product/customer data. The explicit five-column photography preset is retained.
- Charts: missing endpoints disappeared from the selected chart axis, and an isolated point after a gap could be invisible as a one-point polyline. Specifications retain the requested axis; the browser renders point markers, labels and legends, limits displayed decimals and removes redundant supporting-table columns. Conversion's full raw rate table is collapsed when charts are available; native numerators and coverage remain accessible. Currency and native definition facets stay separate, and missing months break lines.
- Conversations: Klaviyo providers existed but the deterministic context/dispatcher route was absent; the old classifier recognized only narrow phrases. Governed performance, opportunity and Shopify referrer comparison tools are now registered and production-bound. Campaign/flow scope, requested dates, coverage, attribution settings and timestamps are preserved. BigQuery date/timestamp wrappers are normalized. New device questions clear old comparisons, explicit dates replace stale comparison dates, overlapping monthly windows execute once, exclusions apply before provider calls, and partial labels inspect all applied periods. Compatible August/September conversion compares devices separately in percentage points without causal explanations. Failed subject switches retain the last successful scope and require clarification on ambiguous follow-ups. Unsupported new questions cannot automatically rerun retained evidence. `/agent`, interactive and durable delivery share scope/evidence validation, including email kind and comparison periods.

These are demonstrated local code/fixture findings, not a diagnosis of every production incident. The original conversion correlation cannot be inspected here: the bounded diagnostic returned `403 EGRESS_FORBIDDEN` at `job_dataset_metadata`. Live provider coverage, actual landing match rate, deployed revision and historical product mapping remain unverified.

## Supported boundary

Existing six export metrics remain governed: original line units, distinct product-containing orders, discounted presentment product line sales, landing sessions, organic clicks and impressions. The current online-published Shopify catalogue, source currencies, completeness/pagination, owner-scoped immutable downloads, limits, artifact recovery and same-ID retry/conflict checks remain in place. No FX rates, inventory, historical identity guesses, backfill or collection are added.

Klaviyo uses its existing persisted non-overlapping calendar-month reports, bounded to 500 rows. Campaigns and flows, conversion metric IDs, attribution settings/timezones and currencies stay separate. Exact day slicing and causal/incremental-sales attribution remain unsupported. Monthly message trends are not supplied by the aggregate adapter. Shopify email referrer comparisons run only through the explicit comparison capability; referrer sessions and completed-checkout sessions are separate populations, not campaign-level sales.

## Verification

- `env -u SHOPIFY_INVENTORY_LOCATION_ID npm test -- --test-reporter=tap`: 891 tests; 888 passed, zero failures, three existing skips (83.9 seconds). The environment removal isolates existing inventory fixtures; no inventory query is performed.
- `node --test --test-reporter=tap test/oracle-conversation-continuity.test.js test/oracle-product-priority-production.test.js test/oracle-evidence-charts.test.js test/oracle-inline-charts.test.js test/klaviyo.test.js`: 89 passed, zero failures.
- The new conversations run through the real production dependency factory, typed BigQuery date arguments, shared dispatcher, production `/agent` entrypoint over local HTTP, interactive sessions and durable jobs. Assertions cover provider calls, dates, campaign/flow scope, exclusions, percentage points, persisted evidence, retry/download ownership and recovered charts. Existing nine-month customers, ten-month Woo history, fifteen independent months, Black Friday/exclusions, selection/history, currencies, optional failures and scrolling regressions remain in the full suite.
- `timeout 45s python diagnostics/oracle-chart-browser.py /tmp/oracle-chart-browser`: Chromium at 1280×900 and 390×844; four disconnected line segments, six visible points, three compact table columns, two decimal places and no page overflow. Requires available Python Playwright and Chromium, without installing dependencies.
- `node --check server.js`, `node --check public/oracle/inline-chart.js`, `git diff --check`.

Full authenticated production browser acceptance remains: actual spreadsheet click/download, refresh recovery, multiple currency/definition charts and complete Oracle page layout. Local HTTP tests inspect actual workbook downloads and owner isolation; the browser smoke verifies the real chart renderer and stylesheet.

## Acceptance prompts

1. “Export all published Shopify products in order of landing traffic only.” → “Add units sold and sales value to that sheet.” → “Sort by units instead.” → “What about last year?”
2. “How are mobile and desktop conversion rates this year?” → “What changed between August and September?” → “how have klaviyo campaigns effected slaes performance this year” → “How are mobile and desktop conversion rates this year?”
3. Select a governed named product → “By month.” → “Just online.” → “What about last year?” → “Graph that.”
4. After a failed Klaviyo switch, “What changed between August and September?” must clarify Klaviyo versus the last successful subject.

## Bounded read-only Render checks

Run from the checked-out service revision in a Render shell. These commands only read job/artifact metadata; they do not enqueue analysis, initialize storage, collect, backfill or mutate sources. Do not print credentials or prompt bodies.

```sh
timeout 30s node diagnostics/oracle-analysis-incident.js 6395298a-d087-4ed6-aa3a-b2aeb7eb4106
```

For the landing-only acceptance export, use the exact request/job IDs from its response (not a guessed owner or artifact ID):

```sh
ORACLE_REPORT_REQUEST_ID='replace-with-exact-export-request-id'
ORACLE_REPORT_JOB_ID='replace-with-exact-export-job-id'
timeout 30s node diagnostics/oracle-product-priority-incident.js "$ORACLE_REPORT_REQUEST_ID" "$ORACLE_REPORT_JOB_ID"
```

The incident queries use `LIMIT 1`, `maximumBytesBilled=100000000` and `jobTimeoutMs=15000`. The export diagnostic reports deployed revision, route registration, recorded failure stage, persisted artifact/completeness/ranking, applied sort and landing join counts. Absence of counts on an older artifact is unverified evidence, not zero matches. A direct/interactive incident without a durable job requires the correlated sanitized Render log entries: request ID, revision, scope resolution, route, dates and provider stage. Use an exact correlation and a bounded time window; do not export unfiltered logs.

No deployment, merge, schedules, source/knowledge mutation, inventory, collection, backfill or watermark reset was performed.
