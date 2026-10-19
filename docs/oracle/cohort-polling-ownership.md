# Cohort timeout: polling ownership follow-through

Base: fresh branch from origin/main ab140795 (merged #341). No deployment or merge.

## Established versus unresolved

The original incident remains unverified in production. Request b3899896-fd41-47ae-9f56-ef98f5dee7eb, job b18574c0-16a9-4a9c-b877-c097c9545782 exhausted its 15-second execution stage after the submission response used approximately 10.269 seconds. This does not establish a warehouse processing bottleneck. Operator-supplied metadata later reports a stopped job and slot activity, as detailed below. The missing header prevents hash/location verification and timestamp comparison; the limiting stage, queueing contribution and relation to client expiry remain unknown.

This environment's bounded dataset-location discovery through the configured client returned HTTP 403 before jobs.get. No job location was guessed. The enforced network policy excludes OAuth/BigQuery destinations. No credential values, customer rows, SQL text or provider exception bodies were printed.

A separate lifecycle defect is demonstrated with the installed BigQuery SDK: getQueryResults() automatically follows both incomplete-job responses and pagination tokens. When the initial response is held until after boundedQuery rejects and cancels, releasing it with jobComplete=false causes another result request. Baseline reproduction: one request at deadline, one cancellation, then one additional result request after ownership ended. Existing late-result rejection prevents evidence delivery, but cannot stop this SDK-owned loop.

The shared boundedQuery now disables auto-pagination and checks deadline/abort ownership before and after each polling/page request. It accumulates rows privately until all pages finish. A later page error rejects the whole query. Late allocation still cancels once; failed ownership never becomes evidence. An already-issued HTTP request (including its SDK transport retry behavior) is not forcibly aborted; this fix prevents subsequent polling/page calls. No new query submission or replay is introduced.

This fixes the reproduced lifecycle defect, not an established cause of the historical timeout. It does not claim faster warehouse execution or completed production cohort figures.

## SQL and budget investigation

The production factory regenerates the exact incident SQL: SHA-256 40d47aa0971b60b774668396a8fd4d0aa27db5404e17dec0a0cb4d353c9c7e91, 25,035 bytes, 55 CTE definitions. SQL generation, classification resolution and retention definitions are unchanged from main, so relational semantics are identical for all source and grouping routes.

The successful classification population reaches first-observed order selection and classified entry lines. The full query additionally reaches distinct named customer/piece membership, subsequent-order matching, order-level classification sets, 90/180 calendar-day maturity, mature-only analytic median, ranking and coverage. Entry coverage joins lines to entry matches by customer and then aggregates booleans, permitting intermediate fanout. Shared CTE references may expand more than once; unused product aggregates are not proof of executed work. #340 already removed the median self-join. None of these structural observations proves where the production time was spent, so no further SQL rewrite or temporary storage is introduced.

The diagnostic has independent 15-second dry-run/execution stages within a 30-second per-source cap including authentication. Production retention uses the remaining request deadline (default 45 seconds); sources are parallel and requested groups within a source are sequential. Durable worker runtime/lease bounds are separate. No budget is increased or validation removed. Submission is jobs.insert; result polling is jobs.getQueryResults; server creation/start/end evidence is needed to attribute their observed duration.

Callers of boundedQuery include journey/cohort, basket and order-value providers and the cohort dry-run diagnostic. Existing ownership, lease fencing, independent outcomes and presentation recovery remain in their owning layers.

## Exact bounded Render checks

Use this revision in an isolated checkout with existing Render credentials. Do not deploy or alter the running service. First run ONE metadata command; it discovers location from the exact Woo WW source dataset and uses the merged #341 interface. A successful full query must share its referenced dataset location. The configured project is selected by createBigQueryClient; there is no invented project or region.

```bash
timeout 12s node --input-type=module <<'NODE'
import {createBigQueryClient} from './bigquery/client.js';
import {boundedEvidenceRead} from './oracle/bounded-evidence-read.js';
import {inspectBigQueryJob} from './diagnostics/oracle-bigquery-job.js';
try {
  const {bigquery}=createBigQueryClient();
  const [dataset]=await boundedEvidenceRead(
    ()=>bigquery.dataset('metorik_uk').getMetadata({maxRetries:0}),
    {maximumMs:5000}
  );
  if(!dataset.location) throw Error();
  let relationship;
  const reader={job:(id,options)=>({getMetadata:async request=>{
    const result=await bigquery.job(id,options).getMetadata(request),m=result[0];
    relationship={job_type:m.configuration?.jobType||(m.configuration?.query?'QUERY':null),
      parent_job_id:m.statistics?.parentJobId??null,child_job_count:m.statistics?.numChildJobs??null};
    return result;
  }})};
  const inspection=await inspectBigQueryJob({
    bigquery:reader, location:dataset.location,
    jobId:'b18574c0-16a9-4a9c-b877-c097c9545782',
    expectedHash:'40d47aa0971b60b774668396a8fd4d0aa27db5404e17dec0a0cb4d353c9c7e91'
  });
  console.log(JSON.stringify({...inspection,...relationship},null,2));
} catch(e) {
  console.log(JSON.stringify({inspection:'unverified',code:e.code||'METADATA_READ_FAILED'}));
  process.exitCode=1;
}
NODE
```

The helper omits SQL, rows and error messages. It reports up to 100 plan stages and 30 timeline samples. DONE is not proof cancellation stopped execution. Hash mismatch, missing metadata or absent timestamps must remain uncertainty. The command augments the same single metadata read with job type/parent/child fields. Historical cancellation request/acknowledgement times cannot be inferred from job metadata; existing client cancellation events are a separate observation.

Only after interpreting metadata, run dry run, then actual Woo WW execution, then each other source independently. Execution commands also validate first. Each command retains the 20 GB billing cap and existing stage bounds. Stop on a failed prerequisite rather than interpreting missing results as zero.

```bash
timeout 40s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --source=woo:ww
timeout 40s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --source=woo:ww --execute
timeout 40s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --source=woo:usd --execute
timeout 40s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --source=shopify:shopify --execute
```

After successful complete calculations, submit the repository question in Oracle chat with explicit entry dates 2023-10-19 through 2026-10-18, observation cutoff 2026-10-18 and Europe/London timezone. For individual pieces also request the piece breakdown. Verify returned source outcomes, mature denominators, repeat classifications, medians, deterministic ranking and incomplete-source disclosures. Refresh the browser and recover the same answer without replaying providers. For a durable result, authenticated polling can be checked with the owner's existing session configured without printing it:

```bash
timeout 20s node diagnostics/oracle-incident-poll.js ACTUAL_ORACLE_JOB_ID
```

The last command requires ORACLE_UI_ORIGIN and ORACLE_INCIDENT_SESSION_COOKIE; it performs one bounded GET and emits presence/status metadata only. It does not prove visible browser delivery. No source collection, backfill, inventory query, source/classification mutation, schedule, queue reset, permissions change or deployment is part of these checks.

## Acceptance criteria

1. Exact job hash/location and available final server evidence are recovered and compared with client timings. Separate submission, pre-execution, execution, polling and cancellation uncertainty explicitly.
2. Woo WW passes validation and actual execution with complete validated cohort rows and reconciled coverage. Fixture counts never substitute for production calculations.
3. Woo USD and Shopify each pass independently or report their actual independent failure; neither failure becomes zero activity.
4. Collaboration and piece figures preserve overlapping membership, mature/immature denominators, repeat timing, unknown/conflicting classification and first-observed lookback semantics.
5. Chat delivery and durable refresh/recovery display the same validated evidence, without provider replay; expired leases and late/partial responses cannot persist as completion.
6. No production resolution or speedup claim until these checks pass. Missing metadata still blocks attribution of the historical bottleneck.

## Local verification

- Baseline installed-SDK reproduction observed one extra result request after deadline/cancellation. The new regression suppresses that request.
- Focused SDK polling/cancellation tests: 17 passed, zero failures/skips. These include submission delays, late allocation, polling delays, abort between pages, expired absolute ownership, later-page failure and complete multi-page delivery.
- Real production factory tests compare complete parsed SDK pages with the unchanged row contract for Woo WW, Woo USD and Shopify, for collaboration and piece routes. Existing acceptance fixtures cover overlapping entry names, mature/immature windows, medians, unknown classifications and partial source failures. No SQL transformation is proposed; these are transport/fixture checks, not live relational execution.
- `NODE_OPTIONS=--test-isolation=none npm run test:oracle:acceptance`: 552 passed, zero failures/cancellations/skips. This includes analytical, classification, basket, campaign, date, durable lease and recovery regressions.
- Browser gate: 21 conversations passed on desktop/mobile with durable refresh. Initial execution could not resolve playwright-core; the successful command selected the already-installed driver:
  `ORACLE_BROWSER_DRIVER=/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs npm run test:oracle:browser`.
- This environment's default Node process-isolation run reported only file-level tests, so assertion counts above use `--test-isolation=none`. A standalone new test run executes 12 assertions/tests, rather than the default runner's single file-level pass.
- Exact incident SQL hash was reproduced locally. Live BigQuery dry run, execution and production chat acceptance remain blocked/unverified; no production speedup is claimed.

## Operator metadata returned during this task

The operator supplied the tail of #341's inspection output. It reports `cancellation: stopped`, with timeline samples at 9,891 ms / 132,539 total slot-ms and 10,891 ms / 193,240 total slot-ms. The latter sample reports 30 pending units, 186 completed units and 30 active units. Supplied output stages (IDs 9–58) remain PENDING with mostly absent metrics. This provides warehouse slot-activity evidence and a stopped-job observation; PENDING output stages alone do not locate the bottleneck. The pasted portion omits location, SQL hash verification, top-level status/error and creation/start/end times. Those fields were requested from the existing output; no duplicate production query was requested. Attribution of planning, queueing, execution and client expiry remains pending those fields.
