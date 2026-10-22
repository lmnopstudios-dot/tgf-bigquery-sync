# Combined retention: materialized production execution

Live update: the combined collaboration script has now executed successfully at `7d75e804b35461aabc70353ae085010ee3b146fc` (35,705 ms; all 24 stages; 54 rows; 25 catalogue entries reconciled). Items received only six seconds and sitewide was not attempted. See [the scheduling follow-up](retention-component-scheduling.md) for the deadline fix and exact updated acceptance command. Earlier local-blocker statements below describe the pre-deployment state.

The supplied validation at deployed revision `f6ada6eda3c2bbda7707674febeff05fedea8dc0` establishes twelve successful corrected synthetic executions/result validations and eleven earlier full SELECT compilation successes. Preserve those checks. The flattened combined collaboration SELECT fails planning with “Not enough resources for query planning — query is too complex.”

## Actual execution route

`answerCohortRetention` calls the customer-journey service with combined scope and leaves its `decompose=true` default intact. That service already calls `cohortExecutionOptions`, producing one owned transactional script with temporary materializations. **The combined production route does not bypass staging.** The previous diagnostic planned `customerJourneySql` as one flattened SELECT instead of executing the production script. That failure alone does not establish that the existing staged script fails.

Inspection found two avoidable expansion paths in the shared executor:

- Dependency pruning matched any occurrence of a relation name. The catalogue's `products` count column selected the unrelated downstream `products` CTE and its dependencies. The selector now follows factory-owned `FROM`/`JOIN` table references and ignores quoted strings, identifiers and comments. Expressions and predicates are not rewritten.
- The final combined catalogue has the combined view plus three entry-source reconciliation branches. Shared governance and reporting-family CTEs remained inline across those branches. Four additional temporary boundaries cache `cr_routes`, `cr_collection_current`, `cr_resolved` and `retention_reporting_lines`. The final aggregation reads those cached inputs instead of expanding their histories again. Regressions verify that governance histories and the unrelated downstream-product branch are absent from the final statement.

The existing six source boundaries remain in place. Combined components use ten boundaries, then aggregate CTAS and final SELECT, inside one transaction per component. Every component sequences all three platforms with the same frozen analytical identity and eligibility definition before aggregation. Components remain independently owned jobs under the existing shared request deadline; this does not claim a transaction spanning the entire report. No separate-platform substitute or averaged rate is introduced.

The ordinary source execution cap remains 2,500,000,000 bytes per statement. For combined execution, twelve data statements share the unchanged 20,000,000,000-byte per-component ceiling: each statement is capped at 1,666,666,666 bytes. The customer-journey service now preserves that calculated cap instead of overriding it with the six-stage constant. The production report deadline remains 45 seconds, with at most 15 seconds per statement. No time or total-byte allowance is silently increased.

Linked first-observed sequencing, customer/family deduplication, provisional age-qualified numerators and denominators, classifications, imported-order/refund/cancellation exclusions and coverage safeguards retain their original SQL expressions. Only dependency selection and materialization change. TEMP tables and transaction control do not persist business data or governance decisions. The warehouse metadata reader recognizes every added stage and its cleanup.

## Verification and remaining uncertainty

Tests preserve the exact twelve previously successful synthetic SQL/parameter sets with hashes from `f6ada6e`; the existing eleven-success manifest preserves full SELECT texts. Raw full SELECTs and synthetic expressions remain unchanged; regenerated diagnostic artifacts contain the corrected execution scripts. Earlier successes are not reclassified as new staged-execution evidence.

Local regressions cover all three combined query shapes, unchanged expressions at every boundary, dependency pruning, the 20 GB ceiling, the production service's default staging, native provider/result/delivery validation, independently successful results after a component failure and missing child metadata. Warehouse transports in these tests are mocked; they do not establish live BigQuery execution.

A local attempt to execute the actual native materialized path was blocked at Google authentication/readiness before any population script was allocated. Google access in this environment returns OAuth 403 (`Could not refresh access token: Domain forbidden`). Combined identity safeguards failed closed; `actual_script_jobs` was zero. Corrected live staged execution is therefore **not verified here**. No flattened planning retry or first-DDL script dry run is used as a replacement for execution evidence.

Required gates passed: `npm run test:oracle:acceptance` (809 tests, zero failures; 21 central conversations and 56 regression suites) and `npm run test:oracle:browser` (desktop/mobile, combined TGF view and refresh). The focused execution/metadata suite passed 23 tests. These are local fixture/browser results; live materialized execution remains pending.

## One exact post-deployment Render acceptance command

Run once from the deployed `project/src` directory after this fix is deployed. This is a new, explicitly bounded, in-memory diagnostic calculation against existing warehouse data. It invokes the native combined provider, orchestration and evidence/delivery validation. It does not submit a report via HTTP, load or replay a saved request, create a durable analysis job, publish results, collect orders or rebuild the snapshot.

The command verifies the deployed helper/manifest hashes and exact generated script hashes before submitting population SQL. It executes the three real combined component scripts, with their production deadlines, cancellation/ownership handling and temporary tables. It reads metadata for the three parent jobs and up to fifty children each. Population reads share the native 45-second deadline; metadata inspection adds at most four seconds per allocated script. The outer command is bounded at 80 seconds. At most six identity readiness/coverage reads and three population script jobs are submitted; each script retains the 20 GB total ceiling (60 GB maximum across the three, plus existing bounded identity reads).

Independent outcomes stream as they complete. `acceptance_passed:true` requires all three native population results, supplemental section validation, complete source-specific catalogue reconciliation and successful child stages through final result retrieval. Missing metadata or a validation rejection remains explicit and does not erase successful results. A timeout, planner failure or rejected supplemental section is a software/execution limitation, not evidence of missing follow-up transactions or zero retention. Coverage uncertainty remains separately disclosed by the native report contract.

This command executes existing-data SELECTs and transactional TEMP-table materializations. It performs **no persistent business-data writes**. It does not rerun the eleven compilation checks, twelve synthetic successes, or the known-expensive flattened planning check.

```bash
timeout --signal=TERM --kill-after=5s 80s node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
const clean=e=>String(e?.message||e).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,700);
try{
 const helper=readFileSync('./diagnostics/accept-retention-materialized.js');
 const manifestBytes=readFileSync('./diagnostics/retention-materialized-manifest.json');
 if(createHash('sha256').update(helper).digest('hex')!=='aa9401ba693fd160fabdd4139e09823027c5fee18446e22ad11c61def7dda6f6'||createHash('sha256').update(manifestBytes).digest('hex')!=='0ff1b9103fcc2ef67a22dd3ad7fe6ec2ba5005b605a4e5cfa099fbaa0b40a3ed')throw Error('Deployed acceptance helper/manifest differs from reviewed fix');
 const {acceptMaterializedRetention}=await import('./diagnostics/accept-retention-materialized.js');
 const manifest=JSON.parse(manifestBytes),{project,credentials}=loadBigQueryConfig();
 console.log(JSON.stringify({phase:'materialized_acceptance_start',current_deployed_revision:process.env.RENDER_GIT_COMMIT||null,existing_data_only:true,temporary_tables_only:true,persistent_business_writes:false,report_replayed:false,prior_full_select_passes_preserved:11,prior_synthetic_passes_preserved:12,prior_checks_rerun:0}));
 const result=await acceptMaterializedRetention({bigquery:new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0}),project,env:process.env,manifest,onCheck:check=>console.log(JSON.stringify(check))});
 console.log(JSON.stringify({phase:'materialized_acceptance_result',...result}));
 if(!result.acceptance_passed)process.exitCode=1;
}catch(error){console.log(JSON.stringify({phase:'materialized_acceptance_blocked',acceptance_passed:false,reason:clean(error),persistent_business_writes:false,report_replayed:false}));process.exitCode=1;}
JS
```
