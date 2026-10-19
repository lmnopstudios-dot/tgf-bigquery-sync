# Basket incident scope and delivery regression

## Evidence and first divergences

Baseline: fresh branch from origin/main 53c4425, containing PR #332 and
cb9ceec1a88945323c9f71c03c83260e38c22204. Its multipart planner, reconciliation,
export validation and durable ownership safeguards remain in place.

Incident 1 reproduces at the shared natural report-period parser: abbreviated
`1 January–17 October 2026` fell through to the single named-date branch, which
recognized only 17 October. The order-value boundary then capped the end to the
latest completed day. This explains a one-day scope with the supplied runtime;
it does not certify the production runtime or population.

The detail parser scanned every currency range as a basket-total band. Its
highest-unit interval recognizer lacked `priced`, so the extra £200–£249.99
interval was retained as a basket band and its overlap calculation was missing.
The natural-language main subset also lacked an explicit binding and used the
existing default predicates. These predicates are now recorded in the plan.

Incident 2's explicit report date fields were not recognized as separate report
roles. Its exclusion ISO range could be selected as the report range, and its
structured inequalities and half-open bands had no detail bindings. The corrected
parser independently records the total predicate, highest-unit predicate,
additional overlap, four bands and output format. Open ends are null, never
Infinity. Monetary boundaries remain validated integer pennies.

These are exposed parser regressions, not proof of incident 2's terminal cause.
No exact job/owner correlation or deployed revision could be recovered here.
The artifact hash f27bc577e096721fe2e6e809125dd6bc4128c021a1512f066fe8721aa3c820d6
is not sufficient authorization or a lookup key for enumerating private jobs.
No Render/log connector was available. No workbook/customer contents were fetched.

Separately, the browser's authoritative failed-job response discarded request_id
when throwing its error. Failure and refresh recovery now display that reference.
This explains missing diagnostics in that path, not the underlying job failure.

## Execution and verification

The existing governed reader still performs schema inspection followed by bounded
population/coverage batch queries. No population-wide detail calls were added.
Deduplication, discounted original quantity semantics, penny reconciliation,
deterministic ties, exclusions, historical identities and source boundaries remain
owned by the existing reader/calculator. Membership drives bands and overlaps.
Existing evidence equality, actual workbook validation, ownership, checkpoint,
lease and delivery checks remain active; no recovery bypass was introduced.

Persistent acceptance now includes both unchanged requests, fresh and unrelated
contexts, production dependency bindings with generated SQL and typed parameters,
exact fixture counts and four bands, actual XLSX sheets, same-ID reuse, interactive
and durable authenticated downloads and recovery. Browser tests exercise both
requests on desktop/mobile and inspect workbook bands and single download links.
Shared date tests cover product, campaign, conversion, cohort and sales wording,
shared-year ranges and London summer midnight completed-day cutoffs. Existing
cross-subject capability and failure suites remain part of the gate. These are
fixture checks, not production acceptance or held-out generalisation evidence.

The live bounded SQL probe returned HTTP 403 at dataset_location. It did not reach
schema inspection, dry run, population retrieval, calculations or delivery.
No real BigQuery SQL validation succeeded in this session. Production counts,
collection timestamps, cache identity/age, changed population and freshness remain
unknown. Earlier 3,219/2,922/166/113 observations are not test expectations.
Unknown collection completeness stays disclosed; advancing the requested cutoff
is not evidence of complete coverage. Unsupported components retain their existing
explicit limitations; missing optional components do not replace supported work.

## Bounded read-only Render verification

Run from the deployed repository root. This creates a temporary source checkout
and uses its corrected diagnostics with existing dependencies and credentials.
Verify the printed probe SHA against the PR commit before interpreting results.
No deployment, source/knowledge writes, collectors, backfill or inventory queries.

```sh
oracle_live_src="$PWD"
oracle_probe_root="$(mktemp -d /tmp/oracle-basket-scope.XXXXXX)"
timeout 45s git clone --depth 1 --single-branch --branch fix/oracle-basket-scope https://github.com/lmnopstudios-dot/tgf-bigquery-sync.git "$oracle_probe_root/src"
ln -s "$oracle_live_src/node_modules" "$oracle_probe_root/src/node_modules"
git -C "$oracle_probe_root/src" rev-parse HEAD
node --input-type=module -e 'console.log(JSON.stringify({deployed_revision:process.env.RENDER_GIT_COMMIT||null}))'
(
  cd "$oracle_probe_root/src" || exit 1
  timeout 15s node diagnostics/oracle-basket-incident-plan.js
  timeout 15s node diagnostics/oracle-order-value-bindings.js
  timeout 75s node diagnostics/oracle-basket-sql.mjs --start 2026-01-01 --end 2026-10-17
  timeout 75s node diagnostics/oracle-basket-composition.js --start 2026-01-01 --end 2026-10-16 --execute-read-only
  timeout 75s node diagnostics/oracle-basket-composition.js --start 2026-01-01 --end 2026-10-17 --execute-read-only
)
```

The SQL probe is metadata/dry-run only: five jobs, 250 schema rows, 1 GB/query,
15-second waits, 60-second deadline. Each execution probe has six jobs, the same
billing/time bounds, at most 20,000 orders and 100 lines per order, and aggregate
output. Failure stage distinguishes metadata/schema/query validation/retrieval;
Oracle job stage logs distinguish calculation, checkpoint and terminal delivery.
For owner-authorized correlation, use the affected session's authenticated job
polling/export manifest and its request reference; do not enumerate conversations.

## Acceptance sequence

1. Submit the unchanged first request from test/fixtures/oracle-basket-incidents.json.
   Confirm 1 January–17 October, inclusive 1–4 May exclusion, exactly four bands,
   separately counted highest-item interval and visible combinations. Record
   actual retrieved/reconciled/excluded counts and latest eligible order date.
2. Ask: "Show supporting detail for that same subset and keep the same dates,
   exclusions and four bands." Verify scope, membership totals and overlap stay
   consistent; unsupported refinements must remain explicit.
3. Ask: "Export those supporting tables to XLSX." Inspect scope and real band,
   combination and coverage sheets. Verify one download link, owner authentication,
   refresh recovery and same submission-ID reuse without provider replay.
4. Repeat the unchanged structured request from a fresh session and after unrelated
   conversion context. Confirm equivalent plans/calculations. On failure record the
   displayed sanitized reference and stage; do not interpret unavailable as zero.

## Local check results

- Final persistent acceptance: 455 passed, zero failed/cancelled/skipped.
- Final desktop/mobile browser gate passed, including both unchanged incidents,
  actual workbook band rows, one link and refresh without provider replay.
- Focused final multipart/role suite: 22 passed, zero failures/skips.
- Complete repository run: 1,487 passed, three opt-in BigQuery checks skipped,
  zero failures/cancellations (1,490 total). The subsequent numeric-role regression
  and exclusion masking refinement are covered by the final focused/gate runs.
- Strict schema validation: 46 schemas across 61 tools. Browser JS syntax and
  git diff whitespace checks passed. The planning/serialization probe passed.
- Initial runs found two incorrect new test assertions expecting DATE instead of
  the existing SDK STRING parameters cast by SQL; corrected and rerun successfully.
  Initial browser invocation lacked a local Playwright package; the installed
  /opt/codex/runtimes/cua driver and Chromium passed the final browser runs.
- Live probe: HTTP 403 at dataset_location; no SQL dry run or production acceptance.
