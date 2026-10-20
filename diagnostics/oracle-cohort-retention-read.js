// Read-only SQL/schema probe. Default and only mode is a warehouse dry run.
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { createCustomerJourneyService } from '../oracle/customer-journey.js';
import { retentionDefinition } from '../oracle/cohort-retention.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
export async function dryRunCohortRetention({bigquery,project,now=Date.now(),pieces=false}){
  let options;
  const service=createCustomerJourneyService({project,bigquery:{query:async value=>{options=value;return [[]];}}});
  const context=transitionAnalysisContext(null,pieces?'Can I have a breakdown of what collaboration pieces that are the first purchase a customer has ever made lead to the most return customers. Use both online and instore sales from the last 3 years.':'Rank collaborations by repeat purchase rate after the first order, online in the last 3 years.',{now}).context;
  await service.analyzeCustomerJourney(retentionDefinition(context),{decompose:false});
  const [job]=await bigquery.createQueryJob({...options,dryRun:true,jobTimeoutMs:30000});
  return {read_only:true,dry_run:true,verified:true,operation:'cohort_retention',total_bytes_processed:job.metadata?.statistics?.totalBytesProcessed||null,entry_start:context.start_date,entry_end:context.end_date,live_results_executed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await dryRunCohortRetention({...createBigQueryClient(),pieces:process.argv.includes('--pieces')}),null,2));}
  catch(error){let host=null;try{host=new URL(error.response?.config?.url||error.config?.url).hostname;}catch{} console.error(JSON.stringify({host,verified:false,dry_run:true,stage:'warehouse_sql_schema',code:String(error.code||error.name||'UNKNOWN').slice(0,80),reason:/Invalid configuration/.test(error.message)?'Invalid configuration: GOOGLE_SERVICE_ACCOUNT_JSON':/ENOTFOUND|ECONN|proxy|Forbidden|403|denied|blocked/i.test(error.message)?'Network or warehouse authorization denied; run this bounded diagnostic in Render with its existing governed identity.':'Warehouse dry run failed; inspect bounded provider diagnostics in Render.'}));process.exitCode=1;}
}
