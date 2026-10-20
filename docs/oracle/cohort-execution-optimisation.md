# Cohort execution follow-through

Base: origin/main ab37aa026365fb93475f7aebbc414e1d81651a72, containing merged #342. New branch fix/cohort-execution-completion. No collection, backfill, source/classification mutation, deployment or merge.

## Established facts and missing attribution

Reviewed the operator's original metadata responses in the preceding investigation and the retained record in cohort-polling-ownership.md. Exact job b18574c0-16a9-4a9c-b877-c097c9545782, US, SQL SHA-256 40d47aa0971b60b774668396a8fd4d0aa27db5404e17dec0a0cb4d353c9c7e91. It was an uncached SELECT, DONE with reason stopped. Creation/start/end: 1792435534028 / 1792435534109 / 1792435558265; 81 ms pre-execution and 24,156 ms start-to-end. Bytes processed 509,628; billed 73,400,320; slot-ms 193,240.

The supplied plan tail contains stages 9–58, all PENDING with mostly null metrics; stages 0–8 were omitted. Timeline: at 9,891 ms, 132,539 slot-ms and zero reported pending/completed/active units; at 10,891 ms, 193,240 slot-ms, 30 pending, 186 completed and 30 active units. These establish warehouse activity, not which operator dominates. Low bytes and pending output stages do not prove planning is the bottleneck. No complete physical plan or cancellation request/acknowledgement timestamps were supplied.

Client authentication took 273 ms; validation 10,566 ms; execution stage expired at 15,007 ms, after submission response at approximately 10,269 ms. Server lifetime exceeds that client stage, but server start is not client submission-response time. The remaining ~4.7 seconds is a client retrieval budget, not measured useful warehouse execution. The 24.156-second stopped lifetime includes an unknown stopping interval. #342 fixes demonstrated subsequent SDK polling after ownership expiry; it does not explain or fix warehouse execution. Its code is unchanged here.

A bounded lookup of the exact job through the configured helper returned code 403 in this workspace. The bounded Woo WW execution diagnostic also failed during authentication_token: OAuth HTTP 403 after 36 ms, attempted=false, sql_verified=false, query_id=null (request 3de59a9a-4de1-49c5-ad5f-8f2379eff6e1). No SQL was submitted. Its generated SQL hash is 7a0f2f0489251e09bee5759eb7732c38dea9b546ad64bbadd7f3a6577e50c61f, 25,713 bytes / 57 CTEs; textual size is not reachable execution cost. No fresh plan, live SQL validation, completed production calculations or production chat acceptance was obtained. Production cause and performance remain unverified.

## Evidence-backed SQL changes

The retention branch formerly selected its next order from downstream_orders, which joins cohort, which groups entry_matches. Retention also reads entry_matches for named membership. That is a repeated dependency on the governed classification resolver. AST traversal of the reachable logical CTE graph confirms three entry_matches dependencies before versus two after; it does not assert physical materialisation. It now selects one next qualifying order from ranked_orders joined to entry_orders, before joining named membership. Non-member entry customers may occur in this intermediate relation but cannot enter retention: the final member stream still comes exclusively from the identical governed entry_matches predicate. For members, entry_orders has exactly one entry per source-qualified customer, so its timestamp equals cohort's MIN(entry_timestamp). The same sequence, strictly-later timestamp, source and channel predicates and order tie-break remain. General journey/downstream queries retain their original path.

Coverage previously joined every entry product line to every matching entry piece/name for that customer, then reduced to boolean flags. Named membership is now reduced to one boolean per customer before that join. Generic and conflict flags still inspect every classified entry line; only redundant multiplication is removed. Missing membership explicitly becomes false. Executing the real CTEs on a multi-piece fixture demonstrates 20 intermediate rows before, 12 after, with identical complete coverage and cohort output. This is a demonstrated local cardinality reduction, not a measured BigQuery speedup.

No resolver rules, identity routes, historical lookback, classification governance, overlapping name/piece membership, window maturity, median inputs, ranking, limits or source outcomes changed. No temporary storage, retry, timeout increase, billing-cap change or validation bypass was introduced. Polling, cancellation, absolute deadline and lease fencing remain owned by #342 and existing layers. Independent source/group partial results remain independent.

The two failed diagnostic imports called pathToFileURL(undefined) when the multi-file runner lacked argv[1]. Both now check for a CLI entry point before converting it. Import-only subprocess regressions exercise that exact condition without invoking diagnostics.

## Reproducible local verification

Install the repository's declared Node dependencies without introducing a lockfile. The existing relational harness requires duckdb and sqlglot; this run installed duckdb 1.5.6 and sqlglot 30.23.0 under /tmp/cohort-python, without repository dependency changes.

```bash
PYTHONPATH=/tmp/cohort-python python test/classification-reader-sql.py
NODE_OPTIONS=--test-isolation=none node --test test/diagnostic-imports.test.js test/oracle-cohort-retention.test.js test/oracle-query-polling-ownership.test.js test/oracle-query-cancellation-evidence.test.js test/cohort-deadline-isolation.test.js test/classification-reader.test.js test/klaviyo.test.js
NODE_OPTIONS=--test-isolation=none npm run test:oracle:acceptance
ORACLE_BROWSER_DRIVER=/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs npm run test:oracle:browser
NODE_OPTIONS=--test-isolation=none npm test
```

Relational checks execute generated production-factory SQL, translated from BigQuery to DuckDB. The harness reconstructs the previous dependencies (independently checked against origin/main SQL for all six source/group routes) and compares full output rows for six source/group routes plus the general downstream route. It covers active/revoked/conflicting routes, numeric/GID parent identities, variant rejection, overlapping entries, generic/unknown membership, mature/immature customers, equal timestamps, repeat classifications, exact medians, empty populations and product/channel filters. It independently asserts alpha 90-day 2/1/1 with median 30, beta 90-day 2/2/1 with median 30; an additional unknown second purchase changes alpha to 3/2/2 with one unknown and exact median 20. SQL translation does not certify native BigQuery syntax or production performance.

Focused cohort/SDK/isolation/classification/Klaviyo: 93 passed, zero failures/skips. Import regressions: two passed. Browser acceptance: 21 conversations passed on desktop/mobile including durable refresh. Final Oracle acceptance: 552 passed, zero failures/cancellations/skips. Final repository suite: 1,591 tests, 1,588 passed, zero failures/cancellations, three opt-in live BigQuery checks skipped (annual statements, report statements and reconciliation statements). Both formerly failing diagnostic entry-point suites now load and execute.

Early workspace checks without local network permissions failed to bind test servers and were not passing acceptance runs. An initial npm ci failed because the repository has no lockfile; npm install --no-package-lock succeeded. The broad baseline run overlapped edits and is not used as a clean before/after count. Final checks use the finished source with local server access. The first acceptance attempt loaded two stale SQL-shape assertions expecting the removed downstream_orders branch and reported 550 passed / two failed. Those assertions now check the replacement next-order relation; the final gate is rerun on the finished source.

## ONE next bounded Render command

Run from the existing Render repository checkout using its configured credentials; this reads metadata only, requires no new branch deployment and submits no query. The next missing fact is the omitted active plan stages needed to attribute warehouse work. One jobs.get, five-second helper bound and eight-second external bound; SQL text, parameters and customer rows are omitted.

```bash
timeout 8s node --input-type=module <<'NODE'
import {createBigQueryClient} from './bigquery/client.js';
import {inspectBigQueryJob} from './diagnostics/oracle-bigquery-job.js';
try {
  const r=await inspectBigQueryJob({...createBigQueryClient(),location:'US',jobId:'b18574c0-16a9-4a9c-b877-c097c9545782',expectedHash:'40d47aa0971b60b774668396a8fd4d0aa27db5404e17dec0a0cb4d353c9c7e91'});
  console.log(JSON.stringify({...r,query_plan:r.query_plan.filter(s=>s.status!=='PENDING')},null,2));
  if(!r.hash_matches)process.exitCode=1;
} catch(e) {
  console.log(JSON.stringify({inspection:'unverified',code:e.code||'METADATA_READ_FAILED'}));
  process.exitCode=1;
}
NODE
```

If non-PENDING metrics are absent, operator attribution remains unknown; stopped does not distinguish server timeout from client cancellation. Do not infer idle stopping time from the last timeline sample.

Remaining live acceptance after interpreting metadata: native validation and completed uncached Woo WW calculations at the recorded cutoff under existing 15-second stage / 30-second source / 20-GB billing bounds; independently Woo USD and Shopify collaboration/piece calculations; reconcile complete coverage, denominators, classifications and medians; then production Oracle chat and authenticated durable refresh without provider replay. No production resolution or speedup claim until these pass. Fixture execution, successful cancellation and local browser delivery do not substitute for those results.
