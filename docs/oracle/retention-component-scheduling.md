# Combined retention deadline scheduling

The user-supplied live acceptance at deployed revision `7d75e804b35461aabc70353ae085010ee3b146fc` establishes a successful combined collaboration execution. Job `2996a9e5-e336-417e-a5cd-420e5e18e49e` completed in 35,705 ms; all 24 script stages, including final SELECT, succeeded. Native validation retained 54 collaboration window rows and reconciliation for all 25 governed catalogue entries. `catalogue_complete` was true. These are verified production results, preserved in `test/fixtures/retention-7d75e80-deadline.json`.

Items did not receive a complete execution opportunity. Job `1c9a874b-d108-4298-96ec-34c7845e1d9a` was submitted with only 5,984 ms remaining and hit `ORACLE_AGENT_DEADLINE`. Its parent was still RUNNING at the metadata sample; terminal cancellation was unverified. That evidence does not establish an item SQL failure. Sitewide was `not_attempted/request_deadline`, so it was not validated by this acceptance.

## Fix

The combined path had one population task that awaited collaboration, items and sitewide sequentially. The independent source path already admitted three source tasks concurrently. Combined scope now admits its three independent component reads concurrently, with the same absolute 45-second request deadline. All receive an opportunity to submit before a slow collaboration finishes. Maximum concurrency remains three; per-component statement and byte limits are unchanged. Source-separated compatibility paths retain their prior scheduling.

Results merge in requested component order. Classification coverage is retained from the first successful nonempty component, rather than duplicated or summed across component reads. Each script still sequences the full frozen linked history before aggregation, with the same temporary materializations and transaction snapshot per component. This does not claim one transaction spanning the entire report. SQL, snapshot, classifications, exclusions, provisional customer-level numerators/denominators and verified-coverage safeguards are unchanged. There is no source-rate averaging or new identity link.

Identity readiness now emits its validated activation evidence before population execution. The report retains that evidence when the outer read deadline wins before the provider can return its error metadata. An active analytical snapshot is not proof of completed population retrieval or follow-up coverage. Failed reads still supply no cohort numbers.

The materialized acceptance helper additionally records each component's initial deadline/budget and requires all three to have started before the first completion. The existing script manifest is unchanged. The deployed helper hash changes so an old sequential deployment cannot accidentally pass the new command's preflight.

## Validation and next acceptance

Barrier-based tests prove all three components start before the collaboration provider is released, with a maximum of three reads, identical deadlines and independent 99/99/3 row quotas. A separate outer-deadline test preserves successful collaboration/sitewide results and the timed-out item's active snapshot provenance. These are fixture tests; production concurrency success is not yet established.

Preserve the successful collaboration result, all twelve prior synthetic execution validations and the eleven earlier full SELECT compilation passes. No historical error retrieval or rerun of those compilation/synthetic checks is needed. No new warehouse execution was performed here; Google access remains blocked in this environment.

Required gates passed: `npm run test:oracle:acceptance` (813 tests, zero failures; 21 central conversations and 57 regression suites) and `npm run test:oracle:browser` (desktop/mobile, combined report and refresh). The focused scheduling/materialization suites passed 15 tests. These checks use fixtures/mocked warehouse responses and do not claim new live item/sitewide success.

## One post-deployment acceptance command

The command below performs one new, bounded, in-memory end-to-end acceptance read to verify all three components under concurrent load. It does not replay the retained request or republish a report. The previous successful collaboration evidence remains valid independently of this new acceptance. The read uses the actual native provider, production deadline/cancellation handling, result validators and temporary-table scripts, with at most six identity readiness/coverage reads and three population jobs. No persistent business data, governance decisions or snapshot settings are changed.

All components share 45 seconds. Statement limits remain 15 seconds and 1,666,666,666 bytes; the total ceiling remains 20 GB per component, at most 60 GB across the three plus existing bounded identity reads. Parent/child metadata inspection adds at most four seconds per script; the shell limit is 80 seconds. Independent results remain visible if another component fails. Pass criteria are `scheduling_passed:true` and `acceptance_passed:true`. Failure is not a reason to silently extend limits or certify coverage.

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
