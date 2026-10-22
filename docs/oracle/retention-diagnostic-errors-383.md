# #383 diagnostic failures: retained errors required

The five successful existing-evidence reads remain valid and must not be repeated. Mapping review failed at 117:2 and entry-age trace at 145:2. In the pinned artifact these are the starts of their final `CREATE TEMP TABLE cohort_result` statements, not the rejected expression. Neither the provider's detailed message nor the mapping job ID was supplied. The known trace job is `234c3fa4-30b3-4d6a-86db-4f4ac0ede92c` (US).

A development metadata-only read on 2026-10-22 failed before job access with OAuth 403, `Could not refresh access token: Domain forbidden`. No SQL defect is attributed or fixed from `invalidQuery` alone. Live-accepted business-report SQL and all production data remain unchanged. The previous seven-check command is not a corrected revalidation command; do not rerun it for these failures.

## One bounded existing-job-error read

Run from the deployed `src` directory. This command submits **zero queries**. It reads the exact trace job, then lists at most 21 jobs belonging to the same service account in the four-minute interval around its creation. Only exact pinned mapping-SQL matches are selected; multiple matches remain separate. A missing match or inventory bound is explicitly unresolved, never replaced by an arbitrary execution. The mapping error read proceeds independently of the trace error's status. No customer rows, report replay or persistent writes are involved.

```bash
timeout --signal=TERM --kill-after=3s 45s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
const traceId='234c3fa4-30b3-4d6a-86db-4f4ac0ede92c';
const clean=v=>String(v??'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,8000);
const emit=v=>console.log(JSON.stringify({read_only:true,queries_submitted:0,report_replayed:false,...v}));
const summarize=(check,m)=>emit({check,job_id:m.jobReference?.jobId,location:m.jobReference?.location,created_ms:m.statistics?.creationTime,started_ms:m.statistics?.startTime,ended_ms:m.statistics?.endTime,state:m.status?.state,error_result:m.status?.errorResult?{reason:m.status.errorResult.reason,location:m.status.errorResult.location,message:clean(m.status.errorResult.message)}:null,errors:(m.status?.errors||[]).slice(0,10).map(e=>({reason:e.reason,location:e.location,message:clean(e.message)})),script_statistics:m.statistics?.scriptStatistics||null});
let stage='trace_metadata';
try {
 const {project,credentials}=loadBigQueryConfig();assert.equal(project,'gf-full-data');
 const bq=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 const [trace]=await bq.job(traceId,{location:'US'}).getMetadata();summarize('entry_age_trace_retained_error',trace);
 stage='reviewed_mapping_artifact';
 const revision='0af73bf2d2e294d13ea258940b13e5ae889f238c';
 const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-mapping-coverage.json.gz`,{signal:AbortSignal.timeout(8000),redirect:'error'});
 assert.ok(response.ok,'Pinned artifact unavailable');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=262144,'Artifact bound');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);assert.equal(createHash('sha256').update(bytes).digest('hex'),'3b606816a4f31a1294bf2c28c8fc5085a292ec8a6924d88838b2b0dbc8a7ef22');
 const artifact=JSON.parse(gunzipSync(bytes,{maxOutputLength:4194304}));
 const hash=q=>createHash('sha256').update(q||'').digest('hex');
 assert.equal(hash(trace.configuration?.query?.query),hash(artifact.trace_settings.query),'Trace SQL differs from reviewed artifact; mapping selection not established');
 const created=Number(trace.statistics?.creationTime);assert.ok(Number.isFinite(created)&&created>0,'Missing trace creation time');
 stage='bounded_mapping_inventory';
 const [jobs,next,api]=await bq.getJobs({allUsers:false,projection:'full',autoPaginate:false,maxResults:21,minCreationTime:created-120000,maxCreationTime:created+120000});
 const matches=jobs.filter(j=>j.metadata?.jobReference?.location==='US'&&hash(j.metadata?.configuration?.query?.query)===hash(artifact.mapping_settings.query));
 emit({check:'mapping_exact_sql_inventory',matching_jobs:matches.map(j=>({job_id:j.id,state:j.metadata?.status?.state,created_ms:j.metadata?.statistics?.creationTime})),inventory_rows:jobs.length,inventory_truncated:!!next||!!api?.nextPageToken,metadata_read_bound:4});
 if(!matches.length){emit({check:'mapping_retained_error',status:'unresolved',reason:'no_exact_reviewed_mapping_sql_match_in_bounded_inventory'});process.exitCode=1;}
 const results=await Promise.allSettled(matches.slice(0,4).map(async j=>{const [m]=await j.getMetadata();summarize('mapping_retained_error',m);}));
 for(let i=0;i<results.length;i++)if(results[i].status==='rejected'){emit({check:'mapping_retained_error',job_id:matches[i].id,status:'unavailable',message:clean(results[i].reason?.message)});process.exitCode=1;}
 if(matches.length>4||next||api?.nextPageToken)process.exitCode=1;
}catch(e){emit({stage,status:'unavailable',http_status:Number(e.code)||null,message:clean(e.message)});process.exitCode=1;}
JS
```

After the actual provider messages are available: correct only the diagnostic expressions they identify, add exact regressions, regenerate/pin the artifact and run required gates. The replacement acceptance command must whitelist only `mapping_settings` and `trace_settings`, preserving their separate results and existing diagnostic limits. The five successful reads and live-accepted report SQL do not need revalidation for a diagnostic-only change. BigQuery execution of corrected diagnostics remains pending; local fixture success cannot replace it.
