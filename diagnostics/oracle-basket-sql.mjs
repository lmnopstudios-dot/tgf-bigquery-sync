/** Standalone Render probe: save anywhere, run from the deployed repository root.
 * Only metadata and dry runs. No server, collectors, writes or row retrieval.
 */
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const load=path=>import(pathToFileURL(resolve(process.cwd(),path)).href);
export async function verifyBasketSql(input,{bigquery,project,preview=false}={}) {
  const {createOracleProviderDependencies}=await load('oracle/provider-dependencies.js');
  const {basketPopulationSql,BASKET_LINE_COLUMNS}=await load('oracle/basket-provider.js');
  const {orderValueHistogramSql,orderValueCoverageSql,orderValueQueryOptions,validateOrderValueScope}=await load('oracle/order-value-provider.js');
  const {ORDER_VALUE_SCHEMA,inspectOrderValueSchema}=await load('oracle/order-value-schema.js');
  const {datasetLocation}=await load('bigquery/dataset-location.js');
  const {safeReadFailure}=await load('oracle/read-failure.js');
  const {boundedEvidenceRead}=await load('oracle/bounded-evidence-read.js');
  const deps=createOracleProviderDependencies(bigquery?{bigquery,project,env:{}}:{});
  ({bigquery,project}=deps);
  const args=validateOrderValueScope({start_date:input.start,end_date:input.end,platform:'shopify',source_store:'shopify',channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal',assumed_charge:8});
  const report={read_only:true,dry_run_only:true,preview_struct_alias_fix:preview,bounds:{maximum_sql_jobs:5,maximum_schema_rows:250,maximum_bytes_per_query:1000000000,query_timeout_ms:15000,total_deadline_ms:60000},checks:[]};
  const deadlineAt=Date.now()+60000;
  const check=async(stage,work)=>{try{const value=await boundedEvidenceRead(work,{deadlineAt,maximumMs:15000});report.checks.push({stage,status:'fulfilled'});return {value};}catch(error){const failure=safeReadFailure(error,stage);const messages=[error?.message,...(error?.errors||[]).map(e=>e.message)].join(' ');if(/Syntax error:/i.test(messages))failure.error_category='sql_syntax';report.checks.push({stage,status:'rejected',failure});return {failure};}};
  const located=await check('dataset_location',()=>datasetLocation(bigquery,project,'shopify_data'));
  if(located.failure)return report;
  report.location=located.value;
  const settings={...orderValueQueryOptions(args,located.value),jobTimeoutMs:15000};
  report.parameter_contract=settings.types;
  const schemas=await check('schema_inspection',()=>bigquery.query({query:`SELECT table_name,column_name,data_type FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN ('order_locations','order_financials','order_customers','order_shipping_geography','order_line_items') LIMIT 250`,location:located.value,useLegacySql:false,maximumBytesBilled:'104857600',jobTimeoutMs:15000}));
  if(schemas.failure)return report;
  const rows=schemas.value[0];report.order_schema=inspectOrderValueSchema(rows);
  const types=new Set(['STRING','INT64','NUMERIC','FLOAT64','BIGNUMERIC','BOOL','TIMESTAMP','DATE','DATETIME','JSON','BYTES']);
  // Only required, code-owned identifiers; unknown provider type strings are hidden.
  report.schema=Object.entries({...ORDER_VALUE_SCHEMA,order_line_items:BASKET_LINE_COLUMNS}).flatMap(([table,columns])=>Object.entries(columns).map(([column,expected_type])=>{const actual=rows.find(r=>r.table_name===table&&r.column_name===column)?.data_type;return {table,column,expected_type,actual_type:types.has(actual)?actual:actual?'unsupported':null};}));
  // inspectOrderValueSchema retains provider types; use the allowlisted comparison above.
  report.order_schema={valid:report.order_schema.valid};
  if(report.schema.some(r=>r.expected_type!==r.actual_type)){report.checks.push({stage:'population_dry_run',status:'blocked',blocked_by:'schema_contract'});return report;}
  let basket=basketPopulationSql(project);
  if(preview){await check('population_dry_run',()=>bigquery.createQueryJob({...settings,query:basket,dryRun:true}));report.checks.at(-1).consumer='basket_deployed';}
  if(preview)for(const name of ['original_unit_price_presentment','original_total_presentment','discounted_total_presentment','total_discount_presentment'])basket=basket.replace(`CAST(${name} AS STRING) ${name}`,`CAST(${name} AS STRING) AS ${name}`);
  // Fixed expression only: no provider SQL, parameters, project or row literals.
  report.failure_site={line:29,column:57,expression:'CAST(original_unit_price_presentment AS STRING)',field_alias_requires:'AS'};
  for(const [stage,query] of [['population_dry_run',basket],['coverage_dry_run',orderValueCoverageSql(project)],['population_dry_run',orderValueHistogramSql(project)]]){
    const checked=await check(stage,()=>bigquery.createQueryJob({...settings,query,dryRun:true}));
    report.checks.at(-1).consumer=query===basket?'basket':stage==='coverage_dry_run'?'shared_coverage':'order_value';
    if(checked.failure){report.checks.push({stage:'dependent_execution',status:'blocked',blocked_by:stage});break;}
  }
  return report;
}
async function main(){const input={};let preview=false;for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--preview-struct-alias-fix'){preview=true;continue;}if(!['--start','--end'].includes(key)||!process.argv[i+1])throw Error('Invalid arguments');input[key.slice(2)]=process.argv[++i];}const report=await verifyBasketSql(input,{preview});console.log(JSON.stringify(report,null,2));if(report.checks.some(c=>c.status!=='fulfilled'))process.exitCode=1;}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error(JSON.stringify({status:'unavailable',category:'configuration_or_scope_invalid'}));process.exitCode=1;});
