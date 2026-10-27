// Warehouse validation uses synthetic session tables only. Never invokes Oracle,
// reads production tables, resolves customer identity or replays the report.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {bigQueryDateParameters} from '../bigquery/date-parameters.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortExecutionPlan} from '../oracle/cohort-execution.js';
import {validateProductJourneys} from '../oracle/product-journeys.js';

export const CORRELATION_PARAMS={time_zone:'Europe/London',...bigQueryDateParameters({cohort_entry_start:'2024-01-01',cohort_entry_end:'2024-01-01',observation_end:'2026-10-19'}),entry_source:null,entry_channel:null,coverage_status:'unverified',coverage_start:null,coverage_end:null,coverage_evidence:null};
export const CORRELATION_TYPES={cohort_entry_start:'DATE',cohort_entry_end:'DATE',observation_end:'DATE',entry_source:'STRING',entry_channel:'STRING',coverage_start:'DATE',coverage_end:'DATE',coverage_evidence:'STRING'};
export function productCorrelationValidationSql({legacy=false,empty=false}={}){
 const result=legacy?readFileSync(new URL('../test/fixtures/oracle-second-purchase-c9ac538f-result.sql',import.meta.url),'utf8').trim():`CREATE TEMP TABLE cohort_result AS ${cohortExecutionPlan(customerJourneySql('fixture-project','retention_product_journeys',null,null,{dataset:'identity',snapshot:'synthetic',orderLinks:true},true)).result};`;
 // These are already linked, ranked, eligible fixture orders. The shared final
 // calculation is consumed verbatim, with its real _SESSION relation boundaries.
 const inputs=`CREATE TEMP TABLE fixture_orders AS
 SELECT 'c1' governed_customer_ref,'woo' source_platform,'ww' source_store,'e1' order_ref,TIMESTAMP '2024-01-01 12:00:00+00' order_timestamp,1 order_sequence,'Online' channel
 UNION ALL SELECT 'c1','shopify','shopify','n1',TIMESTAMP '2024-02-01 12:00:00+00',2,'Online'
 UNION ALL SELECT 'c2','woo','ww','e2',TIMESTAMP '2024-01-01 12:00:00+00',1,'Online'
 UNION ALL SELECT 'c2','woo','usd','n2',TIMESTAMP '2026-01-01 12:00:00+00',2,'Online'
 UNION ALL SELECT 'c3','shopify','shopify','e3',TIMESTAMP '2024-01-01 12:00:00+00',1,'Online'
 UNION ALL SELECT 'c4','woo','ww','e4',TIMESTAMP '2024-01-01 12:00:00+00',1,'Online'
 UNION ALL SELECT 'c4','shopify','shopify','n4',TIMESTAMP '2024-02-01 12:00:00+00',2,'Online';
 CREATE TEMP TABLE cohort_ranked_orders AS SELECT * FROM fixture_orders ${empty?'WHERE FALSE':''};
 CREATE TEMP TABLE fixture_lines AS
 SELECT platform source_platform,store source_store,order_ref,id source_product_id,
   IF(id IS NULL,NULL,CONCAT('family:',id)) reporting_product_ref,COALESCE(id,'Unknown') reporting_product_title,
   'governed_family' family_status,ARRAY<STRING>[] classifications FROM UNNEST([
   STRUCT('woo' AS platform,'ww' AS store,'e1' AS order_ref,'A' AS id),
   ('woo','ww','e1','A'),('woo','ww','e2','A'),('woo','ww','e2','B'),('shopify','shopify','e3','B'),
   ('woo','ww','e4',NULL),('shopify','shopify','n1','A'),('shopify','shopify','n1','A'),
   ('shopify','shopify','n1','B'),('shopify','shopify','n1',NULL),('shopify','shopify','n1','Ring Sizer'),
   ('shopify','shopify','n4','B')]);
 CREATE TEMP TABLE cohort_retention_reporting_lines AS SELECT * FROM fixture_lines ${empty?'WHERE FALSE':''};
 CREATE TEMP TABLE cohort_pj_members AS
 SELECT e.governed_customer_ref,e.order_timestamp entry_timestamp,n.source_platform second_source_platform,n.source_store second_source_store,n.order_ref second_order_ref,
   DATE_DIFF(DATE(n.order_timestamp,@time_zone),DATE(e.order_timestamp,@time_zone),DAY) days_to_second
 FROM cohort_ranked_orders e LEFT JOIN cohort_ranked_orders n ON n.governed_customer_ref=e.governed_customer_ref AND n.order_sequence=2
 WHERE e.order_sequence=1;`;
 return `${inputs}\n${result}\nSELECT * FROM cohort_result;`;
}
// Only synthetic fixture identifiers and numeric/boolean values may be emitted.
// Never serialize SDK responses, SQL, stacks or arbitrary returned strings.
const fixtureRefs=new Set(['family:A','family:B','family:Ring Sizer']);
const counts=['entry_rank','window_days','entry_customers','returning_customers','age_eligible_customers','age_repeat_customers','verified_customers','verified_repeat_customers','missing_line_customers','unknown_product_customers','customers','denominator_customers','percentage','product_rank','available_products'];
function safeFixtureValue(value,depth=0){
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value==='string')return fixtureRefs.has(value)?value:{type:'string'};
 if(depth>4)return {type:'bounded'};
 if(Array.isArray(value))return value.slice(0,16).map(v=>safeFixtureValue(v,depth+1));
 if(value&&typeof value==='object')return {field_names:Object.keys(value).filter(k=>counts.includes(k)||['entry_product_ref','product_ref','entry_is_sizer','is_sizer','products'].includes(k)||/^f[0-9]+_$/.test(k)).slice(0,24),...Object.fromEntries(Object.entries(value).filter(([k])=>counts.includes(k)||['entry_product_ref','product_ref','entry_is_sizer','is_sizer','products'].includes(k)).slice(0,24).map(([k,v])=>[k,safeFixtureValue(v,depth+1)]))};
 return {type:typeof value};
}
function fixtureCheck(name,actual,expected){
 try{assert.deepEqual(actual,expected,name);}
 catch(error){error.fixture_check=name;error.fixture_actual=safeFixtureValue(actual);error.fixture_expected=safeFixtureValue(expected);throw error;}
}
function productComparisons(rows){
 const differences=[];
 if(!Array.isArray(rows))return differences;
 for(const [row_index,row] of rows.slice(0,16).entries())for(const [product_index,p] of (Array.isArray(row?.products)?row.products.slice(0,4):[]).entries()){
  if(p?.denominator_customers!==row.returning_customers)differences.push({row_index,product_index,field:'denominator_customers',expected:safeFixtureValue(row.returning_customers),actual:safeFixtureValue(p?.denominator_customers)});
  const expected=100*p?.customers/row.returning_customers;
  if(Number.isFinite(expected)&&(!Number.isFinite(p?.percentage)||Math.abs(p.percentage-expected)>0.000001))differences.push({row_index,product_index,field:'percentage',expected,actual:safeFixtureValue(p?.percentage)});
 }
 return differences.slice(0,8);
}
export function assertProductCorrelationResult(result,{empty=false}={}){
 const rows=result?.product_journeys;
 try{validateProductJourneys(rows);}
 catch(error){error.diagnostic_stage='result_validation';error.fixture_check='product_journey_contract';error.fixture_actual=safeFixtureValue(rows);error.fixture_comparisons=productComparisons(rows);throw error;}
 if(empty){fixtureCheck('empty_window_count',rows.length,4);fixtureCheck('empty_population',rows.every(r=>r.entry_customers===0&&r.returning_customers===0&&r.products.length===0),true);return;}
 const find=(ref,days=0)=>{const row=rows.find(r=>r.entry_product_ref===ref&&r.window_days===days);fixtureCheck('required_cohort_window_present',Boolean(row),true);return row;};
 const overall=find(null);
 fixtureCheck('overall_counts',[overall.entry_customers,overall.returning_customers,overall.missing_line_customers,overall.unknown_product_customers],[4,3,1,1]);
 fixtureCheck('overall_product_counts_and_denominators',overall.products.filter(p=>!p.is_sizer).map(p=>[p.product_ref,p.customers,p.denominator_customers]),[['family:B',2,3],['family:A',1,3]]);
 fixtureCheck('ring_sizer_denominator',overall.products.find(p=>p.is_sizer)?.denominator_customers,3);
 fixtureCheck('entry_A_counts',[find('family:A').entry_customers,find('family:A').returning_customers,find('family:A').missing_line_customers],[2,2,1]);
 fixtureCheck('deduplicated_later_A_repurchase',find('family:A').products.find(p=>p.product_ref==='family:A')?.customers,1);
 fixtureCheck('entry_B_unknown_products',find('family:B').products.length,0);
 fixtureCheck('entry_B_returners',find('family:B').returning_customers,1);
 fixtureCheck('overall_90_day_counts',[find(null,90).returning_customers,find(null,90).age_eligible_customers,find(null,90).age_repeat_customers],[2,4,2]);
 fixtureCheck('unknown_entry_customers',Number(result.unknown_entry_customers),1);
 fixtureCheck('available_entry_products',Number(result.available_entry_products),2);
}
const contractMessages=new Set(['Invalid product journey bound','Duplicate product journey','Invalid product journey scope','Invalid product journey denominator','Invalid verified coverage','Invalid product row bound','Invalid product share or ranking','Missing product share','Incomplete product selection','Incomplete product windows','Invalid entry ranking']);
const redact=message=>String(message||'').replace(/[^\s@]+@[^\s@]+/g,'[redacted]').slice(0,1000);
export function productCorrelationFailure(error){
 const stage=error.diagnostic_stage||'configuration';
 return {verified:false,location:'US',synthetic_session_tables_only:true,report_replayed:false,
  stage,warehouse_execution_completed:stage==='result_validation'||stage==='fixture_assertion',code:typeof error.code==='string'||typeof error.code==='number'?error.code:null,
  reason:stage==='fixture_assertion'?'FIXTURE_ASSERTION_FAILED':stage==='result_validation'?'RESULT_VALIDATION_FAILED':/Forbidden|domain forbidden/i.test(error.message)?'EGRESS_FORBIDDEN':'WAREHOUSE_VALIDATION_FAILED',
  error_name:stage==='fixture_assertion'?'AssertionError':error.name||'Error',
  message:stage==='fixture_assertion'?error.fixture_check:stage==='result_validation'?(contractMessages.has(error.message)?error.message:'Invalid synthetic result shape'):redact(error.message),
  ...(error.fixture_check?{check:error.fixture_check,actual:error.fixture_actual,...(Object.hasOwn(error,'fixture_expected')?{expected:error.fixture_expected}:{})}:{}),
  ...(error.fixture_comparisons?.length?{comparisons:error.fixture_comparisons}:{}),
  provider_errors:stage==='warehouse_execution'?(Array.isArray(error.errors)?error.errors:[]).slice(0,10).map(e=>({reason:redact(e.reason),location:redact(e.location),message:redact(e.message)})):[]};
}
export async function validateProductCorrelation({bigquery,legacy=false,empty=false}){
 let rows;
 try{[rows]=await bigquery.query({query:productCorrelationValidationSql({legacy,empty}),params:CORRELATION_PARAMS,types:CORRELATION_TYPES,
  location:'US',useLegacySql:false,useQueryCache:false,maximumBytesBilled:'100000000',jobTimeoutMs:30000,
  labels:{component:'oracle_diagnostic',operation:'product_correlation_fixture'}});}
 catch(error){error.diagnostic_stage='warehouse_execution';throw error;}
 try{fixtureCheck('warehouse_result_row_count',rows?.length,1);assertProductCorrelationResult(rows[0],{empty});}
 catch(error){error.diagnostic_stage ||= error.code==='ERR_ASSERTION'?'fixture_assertion':'result_validation';throw error;}
 return {verified:true,location:'US',synthetic_session_tables_only:true,production_tables_read:false,report_replayed:false,legacy,empty,cohort_windows:rows[0].product_journeys.length};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const timer=setTimeout(()=>{console.log(JSON.stringify({verified:false,reason:'VALIDATION_DEADLINE',report_replayed:false}));process.exit(1);},35000);
 try{console.log(JSON.stringify(await validateProductCorrelation({...createBigQueryClient(),legacy:process.argv.includes('--legacy'),empty:process.argv.includes('--empty')})));}
 catch(error){console.log(JSON.stringify(productCorrelationFailure(error)));process.exitCode=1;}
 finally{clearTimeout(timer);}
}
