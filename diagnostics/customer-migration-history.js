// Render: node diagnostics/customer-migration-history.js
// Existing warehouse only. No collection, persistent writes, or identity activation.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {customerHistoryContract} from '../oracle/customer-history.js';
import {createCustomerJourneyService} from '../oracle/customer-journey.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {answerCohortRetention} from '../oracle/cohort-retention.js';

export function migrationAuditSql(project) {
 if(!/^[a-z][a-z0-9-]{4,62}$/.test(project))throw Error('Invalid project');
 const q=(dataset,table)=>`\`${project}.${dataset}.${table}\``;
 return {
  // Schema-only discovery includes other persisted customer/mapping evidence in
  // each known source dataset. It cannot prove no evidence exists elsewhere.
  ...Object.fromEntries(['shopify_data','metorik_uk','metorik_us','oracle_knowledge','commerce'].map(d=>['schema_'+d,`SELECT '${d}' dataset,table_name,column_name,data_type FROM ${q(d,'INFORMATION_SCHEMA.COLUMNS')} WHERE REGEXP_CONTAINS(LOWER(CONCAT(table_name,' ',column_name)),r'customer|identity|mapping|migrat|import|meta|attribute|original|source|order')`+ ' ORDER BY dataset,table_name,column_name LIMIT 1001'])),
  candidates:`WITH woo AS (
   SELECT 'ww' store,CAST(order_id AS STRING) order_id,CAST(customer_id AS STRING) customer_id,TIMESTAMP(order_created_at) original_date,order_name,order_number FROM ${q('metorik_uk','orders')}
   UNION ALL SELECT 'usd',CAST(order_id AS STRING),CAST(customer_id AS STRING),TIMESTAMP(order_created_at),order_name,order_number FROM ${q('metorik_us','orders')}
  ), imported AS (
   SELECT order_id,customer_id,order_created_at,order_name FROM ${q('shopify_data','order_customers')} WHERE source_app_id='gid://shopify/App/1758145'
  ), candidates AS (
   SELECT DISTINCT i.order_id shopify_order,i.customer_id shopify_customer,w.store,w.order_id woo_order,w.customer_id woo_customer,w.original_date,i.order_created_at imported_date
   FROM imported i JOIN woo w ON NULLIF(i.order_name,'')=NULLIF(w.order_name,'') OR NULLIF(i.order_name,'')=NULLIF(w.order_number,'')
  ), per_order AS (SELECT shopify_order,COUNT(DISTINCT CONCAT(store,'|',woo_order)) matches,COUNT(DISTINCT store) stores FROM candidates GROUP BY 1),
  links AS (SELECT DISTINCT store,woo_customer,shopify_customer FROM candidates WHERE woo_customer NOT IN ('','0') AND shopify_customer IS NOT NULL),
  forward AS (SELECT store,woo_customer,COUNT(DISTINCT shopify_customer) profiles FROM links GROUP BY 1,2),
  reverse AS (SELECT shopify_customer,COUNT(DISTINCT CONCAT(store,'|',woo_customer)) customers FROM links GROUP BY 1)
  SELECT (SELECT COUNT(*) FROM imported) imported_rows,(SELECT COUNT(DISTINCT order_id) FROM imported) imported_orders,
   (SELECT COUNT(DISTINCT customer_id) FROM imported) imported_customers,
   (SELECT COUNTIF(customer_id IS NULL) FROM imported) imported_without_customer,
   (SELECT COUNT(*) FROM per_order WHERE matches=1) single_order_reference_candidates,
   (SELECT COUNT(DISTINCT order_id) FROM imported)-(SELECT COUNT(*) FROM per_order) unmatched_order_references,
   (SELECT COUNTIF(matches>1) FROM per_order) ambiguous_order_references,
   (SELECT COUNTIF(stores>1) FROM per_order) namespace_collisions,
   (SELECT COUNT(*) FROM forward WHERE profiles>1) woo_customers_with_multiple_shopify_profiles,
   (SELECT COUNT(*) FROM reverse WHERE customers>1) shopify_profiles_with_multiple_woo_customers,
   (SELECT COUNT(*) FROM candidates WHERE original_date=imported_date) candidate_original_date_agreements,
   (SELECT COUNT(*) FROM candidates WHERE original_date!=imported_date) candidate_original_date_conflicts,
   (SELECT COUNT(*) FROM candidates WHERE original_date IS NULL OR imported_date IS NULL) candidate_missing_dates,
   (SELECT COUNT(*) FROM woo) woo_rows,(SELECT COUNT(DISTINCT CONCAT(store,'|',order_id)) FROM woo) woo_orders`,
  attributes:`SELECT COUNT(*) imported_product_lines,
   COUNTIF(product_id IS NULL) lines_without_product_id,
   COUNTIF(EXISTS(SELECT 1 FROM UNNEST(IFNULL(JSON_QUERY_ARRAY(custom_attributes_json),[])) a WHERE REGEXP_CONTAINS(LOWER(JSON_VALUE(a,'$.key')),r'woo|migrat|original|import|source.store'))) lines_with_candidate_provenance_keys
   FROM ${q('shopify_data','order_line_items')} WHERE order_id IN (SELECT order_id FROM ${q('shopify_data','order_customers')} WHERE source_app_id='gid://shopify/App/1758145')`,
 };
}
const numericRow=row=>Object.fromEntries(Object.entries(row||{}).map(([k,v])=>{
 const n=Number(v);if(v==null||typeof v==='boolean'||v===''||!Number.isSafeInteger(n)||n<0)throw Error('Invalid aggregate');return [k,n];
}));
function diagnosticFailure(error) {
 let host=null;try{const h=new URL(error.response?.config?.url||error.config?.url).hostname;if(['oauth2.googleapis.com','bigquery.googleapis.com'].includes(h))host=h;}catch{}
 return {...safeReadFailure(error,host==='oauth2.googleapis.com'?'authentication_token':'diagnostic'),host};
}
export async function diagnoseMigrationHistory({bigquery,project,now=Date.now(),signal}) {
 const deadlineAt=Date.now()+45000,statements=migrationAuditSql(project),audit={};
 await Promise.all(Object.entries(statements).map(async([name,query])=>{
  try {
   const [rows]=await boundedQuery(bigquery,{query,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000},{maximumMs:15000,deadlineAt,signal});
   audit[name]={state:'fulfilled',...(name.startsWith('schema_')?{columns:rows.slice(0,1000).map(r=>({dataset:r.dataset,table_name:r.table_name,column_name:r.column_name,data_type:r.data_type})),truncated:rows.length>1000}:{counts:numericRow(rows[0])})};
  }catch(e){audit[name]={state:'rejected',failure:diagnosticFailure(e)};}
 }));
 // Use the ordinary shared retention path, with independent source results and
 // its existing decomposed execution / lease and cancellation protections.
 const context=transitionAnalysisContext(null,'Rank named collaborations by 90-day repeat purchase rate among customers whose first purchase included that collaboration, using the last three years through yesterday.',{now}).context;
 let retention;
 try {
  const result=await answerCohortRetention({context,provider:createCustomerJourneyService({bigquery,project}),deadlineAt,signal});
  retention={state:'fulfilled',periods:result.evidence.periods,observation_end:result.evidence.observation_end,rows:result.evidence.rows,coverage:result.evidence.coverage,source_outcomes:result.evidence.source_outcomes};
 }catch(e){retention={state:'rejected',failure:diagnosticFailure(e)};}
 return {read_only:true,aggregate_only:true,customer_history:customerHistoryContract(),audit,retention,
  mapping_coverage:{verified_customers:null,unmatched_customers:null,conflicting_customers:null,ambiguous_customers:null,status:'not_certified_order_reference_candidates_are_not_customer_links'},
  duplicate_handling:{matrixify_transaction_copies:'excluded_unchanged',original_woo:'source_qualified_order_deduplication_unchanged',sales_queries:'unchanged'},
  cross_migration_repeat_customers:null,
  limitations:['Matching names/numbers and date agreement do not certify order provenance or customer identity. No candidates are activated.', 'Import completeness, original product identities and first-ever status are unverified. Missing or failed reads are unknown, never zero. Schema discovery is bounded to known datasets; inspect any other governed evidence before concluding absence.', 'An imported customer/order count does not certify complete migration. Placeholder products cannot establish historical collaboration membership.'],
  next_step:'Review retained import manifest or approved mapping evidence with Woo store (ww/usd), Woo customer/order IDs, Shopify customer/order IDs, original purchase timestamp, original product IDs, provenance reference and import scope/coverage. Reconcile both directions and resolve duplicate profiles before proposing activation. Do not collect or backfill.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const report=await diagnoseMigrationHistory(createBigQueryClient());console.log(JSON.stringify(report,null,2));if(Object.values(report.audit).some(x=>x.state==='rejected')||report.retention.state==='rejected'||report.retention.source_outcomes?.some(x=>x.state==='rejected'))process.exitCode=1;}
 catch(e){console.log(JSON.stringify({read_only:true,verified:false,failure:diagnosticFailure(e)}));process.exitCode=1;}
}
