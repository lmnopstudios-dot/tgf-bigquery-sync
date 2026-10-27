// Warehouse validation uses synthetic session tables only. Never invokes Oracle,
// reads production tables, resolves customer identity or replays the report.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortExecutionPlan} from '../oracle/cohort-execution.js';
import {validateProductJourneys} from '../oracle/product-journeys.js';

export const CORRELATION_PARAMS={time_zone:'Europe/London',cohort_entry_start:'2024-01-01',cohort_entry_end:'2024-01-01',observation_end:'2026-10-19',entry_source:null,entry_channel:null,coverage_status:'unverified',coverage_start:null,coverage_end:null,coverage_evidence:null};
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
export function assertProductCorrelationResult(result,{empty=false}={}){
 const rows=validateProductJourneys(result.product_journeys);
 if(empty){assert.equal(rows.length,4);assert.ok(rows.every(r=>r.entry_customers===0&&r.returning_customers===0&&r.products.length===0));return;}
 const find=(ref,days=0)=>rows.find(r=>r.entry_product_ref===ref&&r.window_days===days);
 const overall=find(null);
 assert.deepEqual([overall.entry_customers,overall.returning_customers,overall.missing_line_customers,overall.unknown_product_customers],[4,3,1,1]);
 assert.deepEqual(overall.products.filter(p=>!p.is_sizer).map(p=>[p.product_ref,p.customers,p.denominator_customers]),[['family:B',2,3],['family:A',1,3]]);
 assert.equal(overall.products.find(p=>p.is_sizer).denominator_customers,3);
 assert.deepEqual([find('family:A').entry_customers,find('family:A').returning_customers,find('family:A').missing_line_customers],[2,2,1]);
 assert.equal(find('family:A').products.find(p=>p.product_ref==='family:A').customers,1); // Later repurchase, duplicated lines count once.
 assert.equal(find('family:B').products.length,0); // Missing lines do not drop its returning customer.
 assert.equal(find('family:B').returning_customers,1);
 assert.deepEqual([find(null,90).returning_customers,find(null,90).age_eligible_customers,find(null,90).age_repeat_customers],[2,4,2]);
 assert.equal(Number(result.unknown_entry_customers),1);
 assert.equal(Number(result.available_entry_products),2);
}
export async function validateProductCorrelation({bigquery,legacy=false,empty=false}){
 const [rows]=await bigquery.query({query:productCorrelationValidationSql({legacy,empty}),params:CORRELATION_PARAMS,types:CORRELATION_TYPES,
  location:'US',useLegacySql:false,useQueryCache:false,maximumBytesBilled:'100000000',jobTimeoutMs:30000,
  labels:{component:'oracle_diagnostic',operation:'product_correlation_fixture'}});
 assert.equal(rows.length,1);assertProductCorrelationResult(rows[0],{empty});
 return {verified:true,location:'US',synthetic_session_tables_only:true,production_tables_read:false,report_replayed:false,legacy,empty,cohort_windows:rows[0].product_journeys.length};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const timer=setTimeout(()=>{console.log(JSON.stringify({verified:false,reason:'VALIDATION_DEADLINE',report_replayed:false}));process.exit(1);},35000);
 try{console.log(JSON.stringify(await validateProductCorrelation({...createBigQueryClient(),legacy:process.argv.includes('--legacy'),empty:process.argv.includes('--empty')})));}
 catch(error){console.log(JSON.stringify({verified:false,location:'US',synthetic_session_tables_only:true,report_replayed:false,code:error.code||null,
  reason:/Forbidden|domain forbidden/i.test(error.message)?'EGRESS_FORBIDDEN':'WAREHOUSE_VALIDATION_FAILED',provider_errors:error.errors?.map(e=>({reason:e.reason,location:e.location,message:e.message}))||[]}));process.exitCode=1;}
 finally{clearTimeout(timer);}
}
