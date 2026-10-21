import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from '../bigquery/client.js';
import {historyCoverageSql} from '../customer-identity/history-sql.js';
import {historyFailure} from '../customer-identity/history-warehouse.js';
import {SCOPE} from '../customer-identity/collect.js';
import {boundedQuery} from '../oracle/bounded-query.js';

// One planning request only: no execution, results, job-history scan or retry.
export async function diagnosePreview({bigquery,project}){
  const stage='preview_coverage',query=historyCoverageSql(project,'customer_identity',{materialized:false});
  const start=performance.now();
  const evidence={read_only:true,dry_run:true,query_form:'unmaterialized_cte',stage,query_sha256:createHash('sha256').update(query).digest('hex')};
  try{
    const [job]=await boundedQuery(bigquery,{query,dryRun:true,maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:20000},{maximumMs:20000});
    return {...evidence,status:'validated',elapsed_ms:Math.round(performance.now()-start),
      estimated_bytes:job.metadata?.statistics?.totalBytesProcessed??null,
      limitation:'Planning only; success does not establish runtime feasibility.'};
  }catch(error){
    // Inspect text only for fixed categories; never return provider text.
    const messages=[error.message,...(error.errors||[]).map(e=>e.message),...(error.response?.data?.error?.errors||[]).map(e=>e.message)].join('\n');
    const resource_category=/too many subqueries|query is too complex|query planning|planning resources/i.test(messages)?'planning_complexity':
      /shuffle/i.test(messages)?'shuffle':/memory|peak usage/i.test(messages)?'memory':null;
    error.history_diagnostic={stage,elapsed_ms:Math.round(performance.now()-start)};
    return {...evidence,...historyFailure(error,{operation:'preview',elapsed_ms:Math.round(performance.now()-start)}),resource_category};
  }
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  if(process.argv.length!==2)throw Error('No arguments supported');
  const {project,credentials}=loadBigQueryConfig();
  const bigquery=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  diagnosePreview({bigquery,project}).then(result=>{console.log(JSON.stringify(result));if(result.status!=='validated')process.exitCode=2;});
}
