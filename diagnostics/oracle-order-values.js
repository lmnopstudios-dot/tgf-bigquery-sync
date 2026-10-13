import { orderValueTraceSql, assessOrderValueTrace } from '../oracle/order-value-trace.js';
import { orderValueSourceBindings } from '../oracle/order-value-bindings.js';
import { inspectOrderValueSchema } from '../oracle/order-value-schema.js';
import { boundedEvidenceRead } from '../oracle/bounded-evidence-read.js';
/** Aggregate-only read diagnostic. Imports no collector, server or inventory API. */
import { pathToFileURL } from 'node:url';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { safeReadFailure } from '../oracle/read-failure.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { orderValueQueryOptions, orderValuePopulationSql, orderValueHistogramSql, orderValueCoverageSql, ORDER_VALUE_DEFINITIONS } from '../oracle/order-value-provider.js';
import { numericDistribution } from '../oracle/numeric-distribution.js';

export function validateOrderValueDiagnostic(input){
  if(Object.keys(input).some(k=>!['start','end'].includes(k)))throw Error('Only --start and --end read bounds are permitted');
  for(const d of [input.start,input.end])if(!/^\d{4}-\d{2}-\d{2}$/.test(d||'')||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)throw Error('Valid start/end required');
  const days=(Date.parse(input.end)-Date.parse(input.start))/86400000+1;if(days<1||days>366)throw Error('Read bound: 1–366 days');
  return input;
}
export async function diagnoseOrderValues(input,{bigquery,project,env=process.env}){
  validateOrderValueDiagnostic(input);
  const report={read_only:true,aggregate_only:true,period:{start_date:input.start,end_date:input.end},bounds:{days:(Date.parse(input.end)-Date.parse(input.start))/86400000+1,maximum_days:366,maximum_queries:8,maximum_trace_rows:1,maximum_trace_components:8,maximum_filter_stages:11,maximum_bytes_per_population_query:1000000000,maximum_schema_rows:200,maximum_aggregate_groups:50000,timeout_ms:30000},bindings:orderValueSourceBindings({project,env}),checks:[]};
  const check=async(stage,work)=>{try{const result=await boundedEvidenceRead(work,{maximumMs:30000});report.checks.push({stage,status:'fulfilled',result});return result;}catch(error){report.checks.push({stage,status:'rejected',failure:safeReadFailure(error,stage)});return null;}};
  const location=await check('dataset_location',()=>datasetLocation(bigquery,project,'shopify_data'));
  if(!location)return {...report,population_status:'query_failure'};
  report.location=location;
  report.datasets=[{project,dataset:'shopify_data',actual_location:location}];
  const schemas=await check('schema_inspection',async()=>{const [rows]=await bigquery.query({query:`SELECT table_name,column_name,data_type,is_nullable FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN ('order_locations','order_financials','order_customers','order_shipping_geography') ORDER BY table_name,ordinal_position LIMIT 200`,location,maximumBytesBilled:'104857600',jobTimeoutMs:30000,useLegacySql:false});return rows;});
  report.schemas=schemas;
  report.schema_contract=schemas?inspectOrderValueSchema(schemas):null;
  const args={start_date:input.start,end_date:input.end,platform:'shopify',source_store:null,channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal',assumed_charge:8};
  const options={...orderValueQueryOptions(args,location),jobTimeoutMs:30000};
  report.parameter_contract=options.types;
  // Validated dates are non-secret scope evidence; other parameter values stay private.
  report.bound_dates={start_date:options.params.start_date,end_date:options.params.end_date};
  report.date_predicate="order_date BETWEEN DATE(@start_date) AND DATE(@end_date); order_date = DATE(l.created_at,'Europe/London')";
  let populationValid=false,coverageValid=false;
  for(const [stage,query] of [['population_dry_run',orderValueHistogramSql(project)],['coverage_dry_run',orderValueCoverageSql(project)]]){
    if(stage==='coverage_dry_run'&&!populationValid){report.checks.push({stage,status:'blocked',blocked_by:'population_dry_run'});continue;}
    const result=await check(stage,async()=>{const [job]=await bigquery.createQueryJob({...options,query,dryRun:true});return {valid:true,total_bytes_processed:job.metadata?.statistics?.totalBytesProcessed||null};});
    if(stage==='population_dry_run')populationValid=!!result;else coverageValid=!!result;
  }
  if(!populationValid||!coverageValid){
    for(const stage of ['join_uniqueness','population_query','coverage_query'])report.checks.push({stage,status:'blocked',blocked_by:!populationValid?'population_dry_run':'coverage_dry_run'});
    return {...report,population_status:'query_failure'};
  }
  let trace=null;
  if(report.schema_contract?.valid){
    const valid=await check('population_trace_dry_run',async()=>{const [job]=await bigquery.createQueryJob({...options,query:orderValueTraceSql(project),dryRun:true});return {valid:true,total_bytes_processed:job.metadata?.statistics?.totalBytesProcessed||null};});
    if(valid)trace=await check('population_trace',async()=>{const [rows]=await bigquery.query({...options,query:orderValueTraceSql(project)});return rows[0];});
    else report.checks.push({stage:'population_trace',status:'blocked',blocked_by:'population_trace_dry_run'});
  }else for(const stage of ['population_trace_dry_run','population_trace'])report.checks.push({stage,status:'blocked',blocked_by:'schema_contract'});
  report.population_trace=trace;
  report.cause_assessment=assessOrderValueTrace(trace,report.period);
  await check('join_uniqueness',async()=>{const [rows]=await bigquery.query({...options,query:`${orderValuePopulationSql(project)} SELECT 'shopify' source_platform,'shopify' source_store,COUNT(*) joined_rows,COUNT(DISTINCT order_id) distinct_source_orders,COUNT(*)-COUNT(DISTINCT order_id) excess_join_rows FROM scoped`});return rows;});
  const data=await check('population_query',()=>createOracleProviderDependencies({bigquery,project,env:{}}).orderValues(args,{maximumMs:30000}));
  // The provider result contains aggregate groups; report only calculated summaries.
  const entry=report.checks.find(c=>c.stage==='population_query');if(entry?.result)delete entry.result;
  if(!data)return {...report,population_status:'query_failure'};
  report.checks.push({stage:'coverage_query',status:data.coverage.coverage_retrieval,...(data.coverage.failure?{failure:data.coverage.failure}:{})});
  const summary=numericDistribution(data.rows,{},data.coverage);
  const missing=['missing_financials','missing_status','missing_geography'].some(k=>Number(data.coverage[k])>0);
  return {...report,coverage_status:data.coverage.coverage_retrieval==='rejected'?'query_failure':missing?'missing_components':'incomplete_coverage',coverage:data.coverage,definitions:ORDER_VALUE_DEFINITIONS,shipping_rule_basis:'unverified; observed subtotal alternative explicitly named',...summary,population_status:summary.population?'retrieved':missing?'missing_components':'empty_collected_population',eligible_population_status:summary.population_status,gaps:undefined,live_acceptance:'Only these executed stored-evidence reads; no complete collection or shipping-rule validation implied'};
}
async function main(){const input={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!key?.startsWith('--')||!process.argv[i+1])throw Error('Use --start YYYY-MM-DD --end YYYY-MM-DD');input[key.slice(2)]=process.argv[i+1];}validateOrderValueDiagnostic(input);const report=await diagnoseOrderValues(input,createOracleProviderDependencies());console.log(JSON.stringify(report,null,2));if(report.checks.some(c=>c.status==='rejected')||report.schema_contract?.valid===false)process.exitCode=1;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({status:'failed',failure:safeReadFailure(error,'population_query')}));process.exitCode=1;});
