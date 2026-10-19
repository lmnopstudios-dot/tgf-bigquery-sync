// Bounded aggregate-only production probe. No collectors, DDL, source writes or PII.
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { createCustomerJourneyService } from '../oracle/customer-journey.js';
import { retentionDefinition,retentionRows,retentionCoverage } from '../oracle/cohort-retention.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
export async function probeRetentionCoverage({bigquery,project,now=Date.now(),execute=false}){
 const context=transitionAnalysisContext(null,'Rank collaborations by 90-day repeat purchase rate after their first purchase for the last three years through the latest completed day, including online and in-store. Group by collaboration first and show individual pieces within each collaboration.',{now}).context;
 const definition=retentionDefinition(context),checks=[],deadline=Date.now()+45000;
 for(const source of ['woo','shopify'])for(const group of ['retention_windows','retention_piece_windows']){
  let stage='query_definition';
  try{
   let options;
   await createCustomerJourneyService({project,bigquery:{query:async o=>{options=o;return [[]];}}}).analyzeCustomerJourney({...definition,cohort:{...definition.cohort,entry_source:source},group_by:[group]});
   const remaining=deadline-Date.now();if(remaining<1000)throw Object.assign(Error('Deadline'),{code:'DEADLINE_EXCEEDED'});
   options.jobTimeoutMs=Math.min(10000,remaining);options.maximumBytesBilled='20000000000';
   stage=execute?'aggregate_read':'sql_dry_run';
   if(!execute){const [job]=await bigquery.createQueryJob({...options,dryRun:true});checks.push({source,group,status:'dry_run_verified',bytes:job.metadata?.statistics?.totalBytesProcessed||null});continue;}
   const [rows]=await bigquery.query(options);stage='calculation_validation';
   const publicRows=retentionRows(rows.filter(r=>r.window_days!=null).map(r=>({...r,entry_product:r.entry_product_title})));
   const coverage=retentionCoverage(rows[0]?.coverage||[]);
   // Only aggregate outcomes and bounded product/collaboration rows are emitted.
   checks.push({source,group,status:'partial_supported',coverage,rows:publicRows,row_bound:definition.limit,truncated:rows.some(r=>r.truncated===true)||rows.length>=definition.limit,first_ever_established:false});
  }catch(error){checks.push({source,group,status:'unavailable',stage,code:String(error.code||error.name||'UNKNOWN').replace(/[^A-Za-z0-9_:-]/g,'').slice(0,60)});}
 }
 return {read_only:true,aggregate_only:true,execute,revision:process.env.RENDER_GIT_COMMIT||null,scope:{entry_start:definition.cohort_entry_start,entry_end:definition.cohort_entry_end,observation_end:definition.observation_end,time_zone:definition.time_zone},bounds:{queries:4,bytes_per_query:20000000000,job_timeout_ms:10000,deadline_ms:45000,rows_per_query:50},checks,square:'unsupported; no governed cohort binding or deterministic combined identity',continuous_history:'unverified; observed endpoints are not a coverage guarantee'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const r=await probeRetentionCoverage({...createBigQueryClient(),execute:process.argv.includes('--execute-read-only')});
 console.log(JSON.stringify(r,null,2));if(r.checks.some(c=>c.status==='unavailable'))process.exitCode=1;
}
