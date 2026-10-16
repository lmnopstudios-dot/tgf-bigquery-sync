/** Stored-evidence SELECTs only; never imports server, collectors or inventory. */
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {datasetLocation,assertDatasetIdentifier} from '../bigquery/dataset-location.js';
import {createBasketProvider,basketPopulationSql,basketSchemaIssues} from '../oracle/basket-provider.js';
import {inspectOrderValueSchema} from '../oracle/order-value-schema.js';
import {orderValueQueryOptions,validateOrderValueScope} from '../oracle/order-value-provider.js';
import {basketComposition,BASKET_DEFINITIONS} from '../oracle/basket-composition.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {safeReadFailure} from '../oracle/read-failure.js';
export function basketDiagnosticArgs(input){
  if(Object.keys(input).some(k=>!['start','end','execute-read-only'].includes(k)))throw Error('Use --start YYYY-MM-DD --end YYYY-MM-DD [--execute-read-only]');
  return validateOrderValueScope({start_date:input.start,end_date:input.end,platform:'shopify',source_store:'shopify',channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal',assumed_charge:8});
}
export async function diagnoseBaskets(input,{bigquery,project}){
  const args=basketDiagnosticArgs(input);assertDatasetIdentifier(project);
  const report={read_only:true,project,scope:args,bounds:{maximum_days:366,maximum_sql_jobs:6,maximum_bytes_per_query:1000000000,maximum_orders:20000,maximum_lines_per_order:100,query_timeout_ms:15000,total_deadline_ms:60000},definitions:BASKET_DEFINITIONS};
  if(!input['execute-read-only'])return {...report,status:'plan_only',required_configuration:['GOOGLE_PROJECT_ID','GOOGLE_SERVICE_ACCOUNT_JSON or application default credentials'],schema_verified:false,collection_coverage_verified:false};
  const deadlineAt=Date.now()+60000,options={deadlineAt,maximumMs:15000};
  const location=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,'shopify_data'),options);
  const queryOptions={...orderValueQueryOptions(args,location),jobTimeoutMs:15000};
  const [schema]=await boundedEvidenceRead(()=>bigquery.query({...queryOptions,query:`SELECT table_name,column_name,data_type FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN ('order_line_items','order_locations','order_financials','order_customers','order_shipping_geography') LIMIT 250`}),options);
  report.order_schema=inspectOrderValueSchema(schema);report.line_schema_missing=basketSchemaIssues(schema.filter(r=>r.table_name==='order_line_items'));
  if(!report.order_schema.valid||report.line_schema_missing.length)return {...report,status:'schema_unavailable'};
  const [dry]=await boundedEvidenceRead(()=>bigquery.createQueryJob({...queryOptions,query:basketPopulationSql(project),dryRun:true}),options);
  report.dry_run_bytes=dry.metadata?.statistics?.totalBytesProcessed||null;
  const data=await createBasketProvider({bigquery,project})(args,options);
  const excludedDays=new Set(['05-01','05-02','05-03','05-04']);
  return {...report,status:'retrieved',coverage:{...data.coverage,requested_end_date:args.end_date,latest_observed_order_date:data.rows.reduce((m,r)=>r.date>m?r.date:m,'')||null,verified_collection_coverage:false},sections:[{label:'Full period',...basketComposition(data.rows,[200,225,250],'GBP')},{label:'Exclude 1–4 May inclusive',...basketComposition(data.rows.filter(r=>!excludedDays.has(r.date.slice(5))),[200,225,250],'GBP')}],interpretation:'Unchanged totals with advancing requested dates do not identify a cache or collector defect. Compare latest eligible order date, per-component collection timestamps, stored job plan and deployed revision. No collection coverage is verified by this diagnostic.'};
}
async function main(){
  const input={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--execute-read-only'){input['execute-read-only']=true;continue;}if(!['--start','--end'].includes(key)||!process.argv[i+1])throw Error('Invalid diagnostic arguments');input[key.slice(2)]=process.argv[++i];}
  basketDiagnosticArgs(input);
  const deps=input['execute-read-only']?createBigQueryClient():{project:process.env.GOOGLE_PROJECT_ID||'gf-full-data'};
  const result=await diagnoseBaskets(input,deps);console.log(JSON.stringify(result,null,2));if(result.status==='schema_unavailable')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({status:'unavailable',failure:safeReadFailure(error,'schema_inspection')}));process.exitCode=1;});
