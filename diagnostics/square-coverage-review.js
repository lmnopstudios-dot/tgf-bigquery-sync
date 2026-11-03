import {BigQuery} from '@google-cloud/bigquery';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {loadBigQueryConfig} from '../bigquery/client.js';
import {identityConfiguration} from '../oracle/customer-identity.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations,cohortExecutionPlan} from '../oracle/cohort-execution.js';
import {reportingCoverageText} from '../oracle/journey-scope.js';
import {acceptSquareReports,reportingAcceptanceCases,acceptanceQueryPlan} from './square-reporting-acceptance.js';

export function coverageReviewPlan(project,identity){
 const c=reportingAcceptanceCases()[0],d=c.definition,base=acceptanceQueryPlan(project,identity,c);
 const raw=customerJourneySql(project,d.group_by[0],null,null,identity,true,d.report_scope,{state:'preview',version:'square_channels_v1'});
 const {relations,result}=cohortRelations(raw),end=result.indexOf(' reporting_coverage,');
 if(end<0)throw Error('Coverage projection unavailable');
 const select=result.slice(0,end+' reporting_coverage'.length)+`,
 ARRAY(SELECT AS STRUCT COALESCE(l.linkage,'unavailable') linkage,COUNT(*) eligible_orders,COUNT(DISTINCT q.governed_customer_ref) analytical_records
 FROM qualifying_orders q LEFT JOIN sx_links l ON q.source_customer_id=l.cid WHERE q.source_platform='square' GROUP BY linkage ORDER BY linkage) square_linkage,
 ARRAY(SELECT AS STRUCT source_platform,source_store,channel,COUNT(*) entry_orders,COUNT(DISTINCT governed_customer_ref) analytical_records
 FROM ranked_orders WHERE order_sequence=1 AND DATE(order_timestamp,@time_zone) BETWEEN @cohort_entry_start AND @cohort_entry_end GROUP BY source_platform,source_store,channel ORDER BY source_platform,source_store,channel) first_observed_entries,
 ARRAY(SELECT AS STRUCT source_platform,source_store,collaboration_name,COUNT(DISTINCT governed_customer_ref) analytical_records FROM entry_matches WHERE collaboration_name IS NOT NULL GROUP BY source_platform,source_store,collaboration_name ORDER BY source_platform,source_store,collaboration_name) named_collaboration_entries`;
 const sql=`WITH ${relations.map(r=>`${r.name} AS (${r.body})`).join(',\n')} ${select}`;
 // Reuse the accepted source, identity, channel and classification path only.
 // No retention-member/rate computation or next-product ranking is executed.
 const plan=cohortExecutionPlan(sql,['orders','ranked_orders','cr_routes','cr_collection_current','cr_resolved','classified_lines','retention_reporting_lines','entry_matches']);
 return [{name:'coverage_review_only',definition:d,plan:{...plan,params:base.params}}];
}
export function validateCoverageReview(rows){
 if(rows.length!==1)throw Error('Incomplete coverage review');const r=rows[0];reportingCoverageText(r.reporting_coverage);
 if(!r.reporting_coverage.some(c=>c.source_platform==='square'&&Number(c.eligible_transaction_orders)>0&&Number(c.eligible_orders)>0))throw Error('Square coverage unavailable');
 for(const name of ['square_linkage','first_observed_entries','named_collaboration_entries'])if(!Array.isArray(r[name]))throw Error('Missing coverage section');
 const forbidden=/^(?:customer_id|source_customer_id|governed_customer_ref|canonical_customer_ref|order_id|order_ref|email|email_address)$/;
 const visit=x=>{if(x&&typeof x==='object')for(const [k,v]of Object.entries(x)){if(forbidden.test(k))throw Error('Aggregate-only output required');visit(v);}};visit(r);
 for(const row of [...r.square_linkage,...r.first_observed_entries,...r.named_collaboration_entries])for(const key of ['eligible_orders','entry_orders','analytical_records'])if(key in row&&(row[key]==null||row[key]===''||typeof row[key]==='boolean'||!Number.isSafeInteger(Number(row[key]))||Number(row[key])<0))throw Error('Invalid coverage count');
}
export async function runCoverageReview({bigquery,project,identity,location,emit}){
 return acceptSquareReports({bigquery,project,identity,location,emit,casePlans:coverageReviewPlan(project,identity),validateReport:validateCoverageReview});
}
export async function main(){
 const path=`/tmp/square-coverage-${Date.now()}.jsonl`,fd=openSync(path,'wx',0o600),encode=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v);
 const emit=x=>{writeSync(fd,encode(x)+'\n');fsyncSync(fd);if(['manifest','population_validated','aggregate_results','acceptance_summary'].includes(x.stage)||x.state==='failed'||x.state==='population_validated')console.log(encode(x));};
 console.log(encode({stage:'output_file',path,coverage_only:true,report_replayed:false,activation:false,production_writes:false}));
 try{
  if(process.argv.length!==2)throw Error('No arguments supported');const identity=identityConfiguration();
  if(!identity?.orderLinks||identity.mode!=='email_candidate_v2'||identity.dataset!=='customer_identity'||identity.snapshot!=='history-20261022-billing-v3')throw Error('Existing accepted identity configuration required');
  const {project,credentials}=loadBigQueryConfig();if(project!=='gf-full-data')throw Error('Unexpected project');
  const bigquery=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),[ds]=await bigquery.dataset('square_data').getMetadata();
  if(!await runCoverageReview({bigquery,project,identity,location:ds.location,emit}))process.exitCode=2;
 }catch(e){emit({stage:'coverage_review',state:'failed',counts:'unknown',code:typeof e.code==='number'?e.code:null});process.exitCode=2;}finally{closeSync(fd);}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)await main();
