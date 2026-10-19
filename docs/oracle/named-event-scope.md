# Named-event comparison scope incident (19 October 2026)

Request references: `2f88f2a7-745b-4e4b-a646-baba292b0de4` and
`702338e6-3587-4a1f-874d-b29cc86daa3a`.
Base: `bb588b5` (latest origin/main fetched before implementation).

## Demonstrated cause and uncertainty

The unchanged question is:

> Can you compare teh sales of the last 3 black friday sale periods

Running main's original context resolver against that question at
2026-10-19T12:00Z yields this sanitized structural result:

| Field | Resolved request on main | Historical event producer on main |
|---|---|---|
| route / envelope | compare_historical_events | historical_event_comparison.v2 |
| requested subject / declared evidence subject | product_sales | absent |
| metrics | sales, refunds, customers, products, ecommerce_performance | absent |
| entity query | present (product interpretation of relative event wording) | absent |
| grain | month | disjoint campaign ranges and nested phases |
| promotion treatment | compare_excluding | campaign totals, not excluded monthly totals |

The event handler overwrote the route without replacing the product subject and
query. The later shared promotion recognizer also interpreted the sale name as
an exclusion. Independently, the event producer supplied neither a recognized
kind nor a subject. The shared validator therefore rejected the producer's
subject even if its queries succeeded. `analytical_scope` in the old log is a
fallback label, not proof of a particular date-field mismatch. This is a
reproduced source-level cause consistent with the incident, not a claim to have
inspected either deployed evidence payload or verified the deployed revision.

Both bounded incident lookups were attempted. Each stopped at dataset metadata
with `403 / EGRESS_FORBIDDEN`. The new production-factory scope diagnostic made
two bounded knowledge reads and returned `EVENT_KNOWLEDGE_RETRIEVAL_FAILED`.
No live sales read, SQL/parser validation, real campaign selection or deployed
Oracle delivery was established. Five successful ShopifyQL calls do not prove
historical Woo coverage, compatible populations or successful browser delivery.

## Shared changes

- Shared intent/context resolution recognizes latest-N named annual promotions,
  including the typo-containing question. It clears unrelated product, monthly,
  exclusion and retained-source scope. Named email/Klaviyo selection remains
  with its existing governed resolver. Explicit unsupported channel/source or
  population filters return a limitation before reads rather than being dropped.
- Analytical plans declare `named_event_comparison`, the event selector,
  disjoint campaign structure, nested phases and native metric definitions.
  Continuous reporting dates remain separate from actual evidence periods.
- The existing governed historical resolver is reused. Completed/scheduled
  records establish annual comparison slots; future, ongoing and cancelled
  campaigns cannot replace completed campaigns. A governed scheduled successor
  can expose a missing newest campaign. Missing slots, invalid dates, conflicts
  and incomplete reviewed phase relationships remain visible; older events are
  not backfilled into those slots. No nominal Black Friday date is used.
- Reviewed 2025 VIP/public identities and expected dates remain guarded.
  Full-campaign dates/duration are derived from validated phases and totals are
  queried once per campaign, never summed over overlapping phases. The known
  2024 online event retains authority over its parent/physical-store context.
- `historical-event-provider.js` is the production dependency factory used in
  server composition, fixtures and the read-only diagnostic. It uses the existing
  source-qualified country-sales aggregate provider separately for Woo and
  applicable native Shopify history. Existing source status, required joins,
  source overlap and Matrixify exclusion SQL is preserved. A source failure
  retains the other source's independent observations. The previous unrelated
  management-report/ShopifyQL dependency is removed from campaign sales reads.
- Strict validation examines returned provider periods, native metric/currency
  definitions, source/store identities, applicable source components, campaign
  identities, confirmed phases, duration denominators, presented rows and
  persisted plans. Repeated country coverage rows are deduplicated by source,
  store and currency; conflicting repeated totals are rejected. A requested plan
  stamp cannot satisfy these checks. Plan stamps are still attached only after
  strict producer-evidence validation, preserving the existing recovery contract.
- Direct and interactive validation failures preserve `EVIDENCE_SCOPE_MISMATCH`
  and return typed HTTP 422. Durable failed polling explains the scope rejection
  and retains the request reference. Bounded plan diagnostics report field paths
  and structural types, never values, prompts or provider bodies. Direct and
  dispatched execution use the same validation-stage reporting.
- Responses begin with actual dates, duration, source/store, native currency,
  sales/orders and daily rates in a comparison table. Phase provenance, missing
  campaigns, source failures and limitations are in Show details. Ownership,
  leases, authenticated polling and provider-free recovery remain unchanged.

## Practical limits

This binding supports governed **annual named online campaign comparisons**.
Multiple conflicting campaigns/phases without a governed parent relationship
remain blocked rather than being guessed. Discovery is bounded (two knowledge
searches, at most 50 results each); completeness of the latest-event inventory
is explicitly unverified. The persisted knowledge schema has no typed cancellation lifecycle field; fixture cancellation cases establish rejection when such metadata is supplied, not live cancellation discovery. Rejected/superseded knowledge records retain their governed exclusion semantics. No record can establish an unknown missing identity
when neither it nor a governed successor/annual slot is available.

Source-native operational sales/orders remain source/store/currency separated.
Woo and Shopify definitions are directional, not canonical finance equivalence.
Collection completeness is not established by aggregate query success, so the
result is partial, rates use actual calendar durations of the observed periods,
and prior-campaign percentage changes are suppressed while compatible complete
coverage is unverified. Unknown/missing evidence is never a zero. Known native
Shopify history starts 2025-11-16; earlier events read historical Woo authority.
Overlapping legitimate Woo/native observations are preserved separately.

Exact-period compatible traffic is not available from this sales binding, so
conversion is explicitly unavailable. No conversion/management report is
substituted. Campaign charts and exports were not previously supported here;
they are explicitly reported unavailable. Existing supported chart/export
capabilities elsewhere remain protected by the gates.

Legacy successful campaign envelopes lacking independently verifiable source
contracts cannot be upgraded by copying a new requested plan. Recovery rejects
such incompatible evidence; it does not re-run providers or silently select new
events. Other persisted plans keep their existing compatibility upgrades.

## Bounded Render diagnostics

Run these in the existing Render service shell at the revision being evaluated.
They do not collect/backfill, mutate sources/knowledge, change permissions,
reset queues, activate schedules, deploy or merge. They create no Oracle jobs.
Do not print environment variables, stored payloads/answers or raw provider logs.

```sh
printf 'Diagnostic runtime revision: %.40s\n' "$RENDER_GIT_COMMIT"
timeout 30s node diagnostics/oracle-analysis-incident.js 2f88f2a7-745b-4e4b-a646-baba292b0de4
timeout 30s node diagnostics/oracle-analysis-incident.js 702338e6-3587-4a1f-874d-b29cc86daa3a
node diagnostics/oracle-named-event-scope.js
timeout 30s node diagnostics/oracle-named-event-scope.js --execute-read-only
```

Each incident lookup uses bounded read-only metadata plus one parameterized job
lookup (100 MB maximum billed, 15 s query timeout, 25 s process deadline).
A missing job does not establish the cause of an interactive/pre-job failure.
Use Render's existing log viewer with each exact request ID, bounded to its
request window; inspect only stage/status/code/scope-field/revision records.
Do not copy raw prompts, customer rows, query strings or tool bodies.

The new scope diagnostic has at most eight read-only queries, 1 GB per query,
10 s query timeout and a 25 s overall deadline (27 s hard process bound). It
reports hashed event identities, actual period dates/durations, phase counts,
source contract periods, native currencies, aggregate row counts and typed
validation outcomes. It never logs campaign descriptions, raw provider bodies,
customer rows, figures or credentials. Its default invocation only prints bounds.
A diagnostic success verifies read-only production dependency execution, not a
deployed chat, job completion, export or browser delivery.

## Acceptance sequence

1. In a fresh session ask exactly: **Can you compare teh sales of the last 3 black friday sale periods**.
2. Confirm actual governed completed identities and dates, 2026 exclusion at the
   incident runtime, full VIP/public duration without duplicate totals, separate
   sources/currencies and the visible daily denominators. Open Show details.
3. Ask an unrelated customer/month question, then repeat the unchanged question.
   Confirm no product query, month or promotion-exclusion context leaks through.
4. Repeat through direct `/agent`, authenticated interactive chat and durable
   jobs. Refresh/reconnect to the owned result; confirm identical evidence and no
   new provider reads. Compare with the runtime revision, not just source main.
5. Execute the offline matrix for missing/invalid dates, missing newest records,
   future/ongoing/cancelled events, unequal durations, currency separation and
   independent source failures. Injected source failures are fixtures, never
   production source mutations.
6. Confirm wrong periods/identities/sources/definitions/plan stamps are rejected
   as validation failures. Repeat an equivalent Summer Sale comparison. Request
   a chart/export: unsupported optional output must be disclosed truthfully.

## Verification record

Validation completed locally:

- Focused campaign suites: 21 passed; final stricter scope suite: 14 passed.
- Regression recheck for the three full-suite failures: 61 passed.
- `npm run test:oracle:acceptance`: 503 passed, zero failed/cancelled/skipped;
  21 central conversations and 25 provider/delivery suites.
- `ORACLE_BROWSER_DRIVER=/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs npm run test:oracle:browser`:
  all 21 conversations passed in desktop/mobile, including durable refresh.
- Full `npm test`: 1,540 tests, 1,537 passed, zero failed/cancelled, three skipped
  opt-in real BigQuery syntax checks (annual finance, conversion backfill and
  finance reconciliation). No real SQL/parser validation is claimed.
- `node --check server.js`, changed-module syntax checks and `git diff --check`
  passed.

An earlier full run had three failures: empty discovery still expected invented
missing years/phases, a follow-up still expected implicit GBP instead of native
currency separation, and a missing event binding fell through to the wrong
failure path. The assertions/limitation behavior were corrected and rechecked.
The initial browser invocation could not resolve its default Playwright module;
rerunning with the installed driver path above passed. No interrupted check is
counted as a pass.

 The persistent matrix
registers `test/oracle-named-event-scope.test.js` and includes the unchanged
question in all three central transports. The browser gate checks its visible
comparison table, details and provider-free refresh in desktop/mobile viewports.
Fixture success does not verify real provider reads or production resolution.
