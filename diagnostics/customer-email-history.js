// Read only. Private evidence stays inside warehouse SQL; output is allowlisted.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {cohortRelations,auditExecutionOptions,COHORT_BOUNDARIES} from '../oracle/cohort-execution.js';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {retentionDefinition} from '../oracle/cohort-retention.js';
import {EMAIL_SOURCES,emailSchemaSql,emailEvidenceCtes,emailLinkedJourneySql} from '../oracle/email-linked-history.js';

export const EMAIL_BOUNDARIES=['email_states','email_profiles'];
export const SOURCE_BOUNDARIES=[...EMAIL_BOUNDARIES,'orders'];
const integer=value=>{if(value==null||typeof value==='boolean'||value===''||!Number.isSafeInteger(Number(value))||Number(value)<0)throw Error('Invalid aggregate');return Number(value);};
const counts=(row,keys)=>Object.fromEntries(keys.map(k=>[k,integer(row?.[k])]));
export function emailAuditSql(project,schemas,store){
 const original=cohortRelations(customerJourneySql(project,'retention_windows',store==='shopify'?'shopify':'woo',store));
 const end=original.relations.findIndex(r=>r.name==='qualifying_orders');
 const relations=original.relations.slice(0,end+1).map(r=>`${r.name} AS (${r.body})`).join(',\n');
 const evidence=emailEvidenceCtes(project,schemas,{stores:[store]});
 const qualifying=original.relations.find(r=>r.name==='qualifying_orders').body;
 const transactionEligibility=qualifying.slice(qualifying.indexOf('FROM orders')).replace("source_customer_id IS NOT NULL AND source_customer_id NOT IN ('','0') AND ",'');
 return `WITH ${evidence},${relations}, eligible_online_orders AS (SELECT * ${transactionEligibility} AND channel='Online'), population AS (SELECT DISTINCT source_store,source_customer_id profile FROM qualifying_orders WHERE channel='Online'),
 evaluated AS (SELECT p.*,e.usable_emails,e.normalized,e.malformed,e.placeholder,e.customer_emails,e.order_emails FROM population p LEFT JOIN email_profiles e USING(source_store,profile)),
 order_evidence AS (SELECT evidence_order,COUNT(DISTINCT IF(state='usable',normalized,NULL)) usable,COUNTIF(state='malformed')>0 malformed,COUNTIF(state='placeholder')>0 placeholder FROM email_states WHERE source_store='${store}' AND evidence_level='order' AND evidence_order IS NOT NULL GROUP BY 1)
 SELECT (SELECT COUNT(*) FROM population) eligible_online_customers,
 (SELECT COUNT(*) FROM eligible_online_orders) eligible_online_orders,
 (SELECT COUNT(*) FROM qualifying_orders WHERE channel='Online') identified_online_orders,
 (SELECT COUNT(*) FROM eligible_online_orders WHERE source_customer_id IS NULL OR source_customer_id IN ('','0')) anonymous_online_orders,
 (SELECT COUNT(*) FROM evaluated WHERE usable_emails=1) customers_usable_email,
 (SELECT COUNT(*) FROM evaluated WHERE COALESCE(usable_emails,0)=0 AND NOT COALESCE(malformed,FALSE) AND NOT COALESCE(placeholder,FALSE)) customers_missing_email,
 (SELECT COUNT(*) FROM evaluated WHERE malformed) customers_malformed_email,
 (SELECT COUNT(*) FROM evaluated WHERE placeholder) customers_placeholder_email,
 (SELECT COUNT(*) FROM evaluated WHERE usable_emails>1) customers_conflicting_email,
 (SELECT COUNT(*) FROM evaluated WHERE customer_emails>0 AND order_emails>0 AND usable_emails>1) customer_order_disagreements,
 (SELECT COUNT(DISTINCT es.normalized) FROM email_states es JOIN population p ON es.source_store=p.source_store AND es.profile=p.profile WHERE es.state='usable') distinct_normalized_emails,
 (SELECT COUNT(*) FROM email_degrees WHERE source_store='${store}' AND profiles>1 AND normalized IN (SELECT normalized FROM evaluated WHERE usable_emails=1)) emails_multiple_profiles,
 (SELECT COUNT(*) FROM evaluated e JOIN email_links l USING(source_store,profile)) unambiguous_email_customers,
 (SELECT COUNT(*) FROM eligible_online_orders q JOIN order_evidence o ON q.order_ref=o.evidence_order WHERE q.channel='Online' AND o.usable=1) orders_usable_email,
 (SELECT COUNT(*) FROM eligible_online_orders q LEFT JOIN order_evidence o ON q.order_ref=o.evidence_order WHERE q.channel='Online' AND COALESCE(o.usable,0)=0 AND NOT COALESCE(o.malformed,FALSE) AND NOT COALESCE(o.placeholder,FALSE)) orders_missing_email,
 (SELECT COUNT(*) FROM eligible_online_orders q JOIN order_evidence o ON q.order_ref=o.evidence_order WHERE q.channel='Online' AND o.malformed) orders_malformed_email,
 (SELECT COUNT(*) FROM eligible_online_orders q JOIN order_evidence o ON q.order_ref=o.evidence_order WHERE q.channel='Online' AND o.placeholder) orders_placeholder_email,
 (SELECT COUNT(*) FROM eligible_online_orders q JOIN order_evidence o ON q.order_ref=o.evidence_order WHERE q.channel='Online' AND o.usable>1) orders_conflicting_email,
 (SELECT COUNT(*) FROM raw_orders) raw_order_rows,(SELECT COUNT(*) FROM orders) distinct_orders,
 (SELECT COUNTIF(migrated) FROM orders) imported_copies_excluded`;
}
export const SOURCE_COUNTS=['eligible_online_customers','eligible_online_orders','identified_online_orders','anonymous_online_orders','customers_usable_email','customers_missing_email','customers_malformed_email','customers_placeholder_email','customers_conflicting_email','customer_order_disagreements','distinct_normalized_emails','emails_multiple_profiles','unambiguous_email_customers','orders_usable_email','orders_missing_email','orders_malformed_email','orders_placeholder_email','orders_conflicting_email','raw_order_rows','distinct_orders','imported_copies_excluded'];
export const OVERLAP_COUNTS=['exact_email_overlap','unique_candidate_emails','ambiguous_candidate_emails','left_eligible_customers','right_eligible_customers','left_unevaluable_customers','right_unevaluable_customers','left_unmatched_customers','right_unmatched_customers'];
export function emailOverlapSql(project,schemas,{stores=Object.keys(EMAIL_SOURCES)}={}){
 const available=stores.filter(store=>schemas[EMAIL_SOURCES[store].dataset]);
 const canonical=available.map(store=>{
  const s=EMAIL_SOURCES[store],parsed=cohortRelations(customerJourneySql(project,'retention_windows',s.platform,store));
  const rs=parsed.relations.slice(0,3).map(r=>`${r.name} AS (${r.body})`).join(',');
  return `SELECT source_store,source_customer_id profile FROM (WITH ${rs} SELECT DISTINCT source_store,source_customer_id FROM qualifying_orders WHERE channel='Online')`;
 }).join(' UNION ALL ');
 return `WITH ${emailEvidenceCtes(project,schemas,{stores})}, eligible AS (${canonical}), eligible_emails AS (SELECT DISTINCT e.source_store,e.profile,s.normalized FROM eligible e JOIN email_states s USING(source_store,profile) WHERE s.state='usable'), ep AS (SELECT e.*,p.usable_emails,p.normalized FROM eligible e LEFT JOIN email_profiles p USING(source_store,profile)),
 addresses AS (SELECT DISTINCT source_store,normalized FROM eligible_emails),
 pairs AS (SELECT 'ww' a,'shopify' b UNION ALL SELECT 'usd','shopify' UNION ALL SELECT 'ww','usd'),
 matches AS (SELECT DISTINCT p.a,p.b,x.normalized FROM pairs p JOIN addresses x ON x.source_store=p.a JOIN addresses y ON y.source_store=p.b AND x.normalized=y.normalized)
 SELECT p.a,p.b,COUNT(m.normalized) exact_email_overlap,
 COUNTIF(m.normalized IS NOT NULL AND m.normalized NOT IN (SELECT normalized FROM email_bad)) unique_candidate_emails,
 COUNTIF(m.normalized IS NOT NULL AND m.normalized IN (SELECT normalized FROM email_bad)) ambiguous_candidate_emails,
 (SELECT COUNT(*) FROM ep WHERE source_store=p.a) left_eligible_customers,
 (SELECT COUNT(*) FROM ep WHERE source_store=p.b) right_eligible_customers,
 (SELECT COUNT(*) FROM ep WHERE source_store=p.a AND COALESCE(usable_emails,0)!=1) left_unevaluable_customers,
 (SELECT COUNT(*) FROM ep WHERE source_store=p.b AND COALESCE(usable_emails,0)!=1) right_unevaluable_customers,
 (SELECT COUNT(*) FROM ep x WHERE source_store=p.a AND usable_emails=1 AND NOT EXISTS(SELECT 1 FROM ep y WHERE y.source_store=p.b AND y.usable_emails=1 AND y.normalized=x.normalized)) left_unmatched_customers,
 (SELECT COUNT(*) FROM ep x WHERE source_store=p.b AND usable_emails=1 AND NOT EXISTS(SELECT 1 FROM ep y WHERE y.source_store=p.a AND y.usable_emails=1 AND y.normalized=x.normalized)) right_unmatched_customers
 FROM pairs p LEFT JOIN matches m ON m.a=p.a AND m.b=p.b GROUP BY 1,2`;
}

function safeSourceCounts(row,outcomes,store){
 try{
  const n=counts(row,SOURCE_COUNTS);
  const bad=n.identified_online_orders+n.anonymous_online_orders!==n.eligible_online_orders||n.eligible_online_customers>n.identified_online_orders
   ||n.customers_usable_email+n.customers_missing_email+n.customers_conflicting_email>n.eligible_online_customers
   ||n.orders_usable_email+n.orders_missing_email+n.orders_conflicting_email>n.eligible_online_orders
   ||n.unambiguous_email_customers>n.customers_usable_email||n.customer_order_disagreements>n.customers_conflicting_email
   ||n.distinct_orders>n.raw_order_rows||n.imported_copies_excluded>n.distinct_orders;
  if(bad)throw Error('Inconsistent aggregate');return n;
 }catch{outcomes[store]={...outcomes[store],state:'rejected',failure:{code:'INVALID_AGGREGATE'}};return null;}
}

async function bindings(project,now){
 let settings;
 const context=transitionAnalysisContext(null,'Rank named collaborations by 90-day repeat purchase rate online using the last three years through yesterday.',{now}).context;
 const service=createCustomerJourneyService({project,bigquery:{query:async o=>{settings=o;return [[]];}}});
 await service.analyzeCustomerJourney(retentionDefinition(context),{decompose:false});
 return settings;
}
function failure(error){
 let host=null;try{const candidate=new URL(error.response?.config?.url||error.config?.url).hostname;if(['oauth2.googleapis.com','bigquery.googleapis.com'].includes(candidate))host=candidate;}catch{}
 return {...safeReadFailure(error,host==='oauth2.googleapis.com'?'authentication_token':'diagnostic'),host};
}
const LINKAGE_COUNTS=['eligible_email_linked_records','eligible_source_customer_profiles','multi_source_email_linked_records','woo_email_linked_customer_denominator','cross_migration_repeat_customers'];
const resultKeys=['window_days','cohort_customers','mature_customers','repeat_customers','observed_repeat_customers','same_collaboration','different_collaboration','core_range','unknown'];
function publicLinkedRows(rows){return rows.filter(r=>r.window_days!=null).map(r=>{const n=counts(r,resultKeys);if(![90,180].includes(n.window_days)||n.mature_customers!==0||n.repeat_customers!==0||n.observed_repeat_customers>n.cohort_customers||['same_collaboration','different_collaboration','core_range','unknown'].some(k=>n[k]!==0))throw Error('Invalid linked result');return {entry_source:r.source_store,collaboration:r.collaboration_name,window_days:n.window_days,cohort_customers:n.cohort_customers,observed_repeat_customers:n.observed_repeat_customers,mature_denominator:null,mature_repeat_customers:null,second_purchase_classification_for_mature_returns:null,repeat_rate:null,follow_up:'unverified'};});}
export function emailCrossMigrationSql(sql){
 const {relations}=cohortRelations(sql);const upto=relations.findIndex(r=>r.name==='ranked_orders');
   return `WITH ${relations.slice(0,upto+1).map(r=>`${r.name} AS (${r.body})`).join(',')} SELECT (SELECT COUNT(DISTINCT governed_customer_ref) FROM ranked_orders) eligible_email_linked_records,(SELECT COUNT(DISTINCT CONCAT(source_platform,'|',source_store,'|',source_customer_id)) FROM ranked_orders) eligible_source_customer_profiles,(SELECT COUNT(*) FROM (SELECT governed_customer_ref FROM ranked_orders GROUP BY 1 HAVING COUNT(DISTINCT source_store)>1)) multi_source_email_linked_records,(SELECT COUNT(DISTINCT governed_customer_ref) FROM ranked_orders WHERE source_platform='woo') woo_email_linked_customer_denominator,COUNT(DISTINCT governed_customer_ref) cross_migration_repeat_customers FROM (SELECT governed_customer_ref,MIN(IF(source_platform='woo',order_timestamp,NULL)) first_woo,MAX(IF(source_platform='shopify',order_timestamp,NULL)) last_shopify FROM ranked_orders GROUP BY 1) WHERE last_shopify>first_woo`;
}
// Metadata-only telemetry. Never return SQL, job IDs, rows or error messages.
export async function executionStages(bigquery,job,{deadlineAt,signal}={}){
 return boundedEvidenceRead(async()=>{
  const [children,continuation]=await bigquery.getJobs({parentJobId:job.id,projection:'full',autoPaginate:false,maxResults:100});
  if(continuation||children.length>100)throw Error('Stage bound');
  return children.map(child=>{
   const m=child.metadata||{},q=m.configuration?.query?.query||'',s=m.statistics||{};
   const candidate=q.match(/CREATE TEMP TABLE cohort_([a-z_]+) AS/i)?.[1];
   const allowed=new Set([...SOURCE_BOUNDARIES,...COHORT_BOUNDARIES,'eligible','eligible_emails','ep','matches','result']);
   const start=Number(s.startTime),end=Number(s.endTime),creation=Number(s.creationTime);
   return {stage:allowed.has(candidate)?candidate:'script_control',state:m.status?.state==='DONE'?'done':'pending_or_running',
    queue_ms:Number.isFinite(start)&&Number.isFinite(creation)?Math.max(0,start-creation):null,
    execution_ms:Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,end-start):null};
  });
 },{maximumMs:1000,deadlineAt,signal});
}
export async function diagnoseEmailHistory({bigquery,project,now=Date.now(),signal}){
 const deadlineAt=Date.now()+90000,schemas={},source_outcomes={},sources={};let queries=0;
 const base=await bindings(project,now);
 const read=async(name,query,settings={})=>{const start=performance.now();queries++;const lifecycle=[];let allocated;
  try{const [rows]=await boundedQuery(bigquery,{...base,query,params:base.params,...settings,useLegacySql:false,maximumBytesBilled:settings.maximumBytesBilled||'1000000000',jobTimeoutMs:20000},{maximumMs:20000,deadlineAt,signal,onQueryAllocated:job=>{allocated=job;},onProviderStage:event=>{if(lifecycle.length<16)lifecycle.push({stage:event.stage,elapsed_ms:event.elapsed_ms,...(event.cancellation_state?{cancellation_state:event.cancellation_state}:{})});}});if(!Array.isArray(rows)||rows.length>200)throw Error('Aggregate row bound');source_outcomes[name]={state:'fulfilled',elapsed_ms:Math.round(performance.now()-start),lifecycle};return rows;}
  catch(e){source_outcomes[name]={state:'rejected',elapsed_ms:Math.round(performance.now()-start),failure:failure(e),lifecycle};return null;}
  finally{if(allocated&&settings.scriptOptions&&typeof bigquery.getJobs==='function'){try{source_outcomes[name].execution_stages=await executionStages(bigquery,allocated,{deadlineAt,signal});}catch{source_outcomes[name].execution_stages=null;}}}
 };
 await Promise.all(['metorik_uk','metorik_us','shopify_data','woocommerce_uk'].map(async d=>{const rows=await read('schema_'+d,emailSchemaSql(project,d));if(rows&&rows.length<=200&&rows.every(r=>typeof r.table_name==='string'&&typeof r.column_name==='string'))schemas[d]=rows;else if(rows)source_outcomes['schema_'+d]={state:'rejected',failure:{code:'SCHEMA_BOUND'}};}));
 await Promise.all(Object.entries(EMAIL_SOURCES).map(async([store,s])=>{
  if(store==='ww'&&!schemas.woocommerce_uk){sources[store]={state:'unknown',counts:null,blocker:'raw_woo_schema_unavailable'};return;}
  if(!schemas[s.dataset]){sources[store]={state:'unknown',counts:null,blocker:'source_schema_unavailable'};return;}
  if(!schemas[s.dataset].some(r=>r.table_name===(store==='shopify'?'order_customers':'orders')&&r.column_name==='customer_id')){sources[store]={state:'unknown',counts:null,blocker:'canonical_customer_identity_unavailable'};return;}
  const sql=emailAuditSql(project,schemas,store);
  const rows=await read(store,sql,auditExecutionOptions(sql,SOURCE_BOUNDARIES));
  const evidenceTables=schemas[s.dataset];
  const hasEmail=schemas[s.dataset].some(r=>/^(email|billing_email|customer_email|raw_json)$/.test(r.column_name))||store==='ww'&&schemas.woocommerce_uk?.some(r=>r.table_name==='orders_api'&&r.column_name==='raw_json');
  sources[store]=rows?.length===1?{state:'fulfilled',ambiguity_scope:'within_source',email_field_available:Boolean(hasEmail),evidence:{customer_table_present:evidenceTables.some(r=>r.table_name==='customers'),customer_namespace_compatible:evidenceTables.some(r=>r.table_name==='customers'&&r.column_name==='customer_id'),order_table_evaluated:evidenceTables.some(r=>r.table_name===(store==='shopify'?'order_customers':'orders')),raw_woo_order_payload_evaluated:store==='ww'?Boolean(schemas.woocommerce_uk?.some(r=>r.table_name==='orders_api'&&r.column_name==='raw_json')):null,normalized_columns_with_unverified_contract:evidenceTables.filter(r=>/^(email_normalized|normalized_email)$/.test(r.column_name)).length,hash_columns_with_unverified_contract:evidenceTables.filter(r=>/hash|sha256/i.test(r.column_name)).length},counts:safeSourceCounts(rows[0],source_outcomes,store)}:{state:'unknown',counts:null,blocker:'source_read_unavailable'};
 }));
 for(const value of Object.values(sources))if(value.counts===null){value.state='unknown';value.blocker||='invalid_source_aggregate';}
 const stores=Object.entries(sources).filter(([store,x])=>x.state==='fulfilled'&&(store!=='ww'||Boolean(schemas.woocommerce_uk))).map(([store])=>store);
 const all=stores.length>=2;
 let overlap=null,linked={state:'unavailable',blocker:all?'no_unambiguous_cross_source_email_overlap':'fewer_than_two_evaluable_sources',cohorts:null,baseline:null,cross_migration_repeat_customers:null};
 if(all){
  const rows=await read('overlap',emailOverlapSql(project,schemas,{stores}),auditExecutionOptions(emailOverlapSql(project,schemas,{stores}),[...EMAIL_BOUNDARIES,'eligible','eligible_emails']));
  if(rows){try{
   if(rows.length!==3||new Set(rows.map(r=>r.a+','+r.b)).size!==3||!rows.every(r=>['ww,shopify','usd,shopify','ww,usd'].includes(r.a+','+r.b)))throw Error('Invalid pair aggregates');
   overlap=rows.map(r=>{const n=counts(r,OVERLAP_COUNTS);if(n.unique_candidate_emails+n.ambiguous_candidate_emails!==n.exact_email_overlap||['left','right'].some(side=>n[side+'_unmatched_customers']+n[side+'_unevaluable_customers']>n[side+'_eligible_customers']))throw Error('Invalid pair denominator');return {sources:[r.a,r.b],state:stores.includes(r.a)&&stores.includes(r.b)?'evaluated':'unknown',...(stores.includes(r.a)&&stores.includes(r.b)?n:Object.fromEntries(OVERLAP_COUNTS.map(k=>[k,null])))};});
  }catch{overlap=null;source_outcomes.overlap={...source_outcomes.overlap,state:'rejected',failure:{code:'INVALID_AGGREGATE'}};}}
  if(!overlap)linked.blocker='overlap_read_or_validation_unavailable';
  if(overlap?.some(r=>r.state==='evaluated'&&r.unique_candidate_emails>0)){
   const sql=emailLinkedJourneySql(project,schemas,{stores}),baseSql=emailLinkedJourneySql(project,schemas,{baseline:true,stores});
   const crossSql=emailCrossMigrationSql(sql);
   const [cohorts,baseline,cross]=await Promise.all([read('linked_cohorts',sql,auditExecutionOptions(sql,[...EMAIL_BOUNDARIES,...COHORT_BOUNDARIES])),read('linked_baseline',baseSql,auditExecutionOptions(baseSql,[...EMAIL_BOUNDARIES,...COHORT_BOUNDARIES])),read('cross_migration',crossSql,auditExecutionOptions(crossSql,[...EMAIL_BOUNDARIES,'orders','ranked_orders']))]);
   const parsed={};
   for(const [name,rows] of [['cohorts',cohorts],['baseline',baseline]]){try{parsed[name]=rows?publicLinkedRows(rows):null;}catch{parsed[name]=null;source_outcomes['linked_'+name]={...source_outcomes['linked_'+name],state:'rejected',failure:{code:'INVALID_AGGREGATE'}};}}
   let crossCounts=null;try{crossCounts=cross?.length===1?counts(cross[0],LINKAGE_COUNTS):null;if(crossCounts&&crossCounts.cross_migration_repeat_customers>crossCounts.woo_email_linked_customer_denominator)throw Error('Invalid denominator');}catch{crossCounts=null;source_outcomes.cross_migration={...source_outcomes.cross_migration,state:'rejected',failure:{code:'INVALID_AGGREGATE'}};}
   linked={state:parsed.cohorts&&parsed.baseline&&crossCounts?'fulfilled':'partial',blocker:null,...parsed,analytical_population_counts:crossCounts,woo_email_linked_customer_denominator:crossCounts?.woo_email_linked_customer_denominator??null,cross_migration_repeat_customers:crossCounts?.cross_migration_repeat_customers??null};
  }
 }
 return {read_only:true,aggregate_only:true,population:'email-linked customer records',normalization:'trim_lowercase_plus_preserved',bounds:{total_ms:90000,query_ms:20000,maximum_queries:11,maximum_bytes_per_statement:'1000000000',maximum_script_bytes_per_statement:'500000000',maximum_data_statements:47,maximum_data_bytes:'23500000000',maximum_result_rows:200},queries,source_outcomes,sources,overlap,linked,evaluated_linkage_sources:stores,
 activated_customer_mappings:0,analytical_linkage:linked.state==='fulfilled'?'evaluated_in_read_only_query':'not_demonstrated',transaction_policy:'Original source-qualified Woo orders once; Shopify Matrixify copies excluded; genuine later Shopify orders retained.',
 limitations:['Candidate email overlaps are not verified people or migration completeness. Shared addresses and conflicting emails are excluded across evaluated sources; unmatched and missing email evidence remain source-specific.','Coverage is not certified by links, activity endpoints or migration dates. Mature rates and first-ever claims are unavailable.','USD raw Woo payload evaluation is null: no upstream absence is established. Source unambiguous counts are local; overlap and linked results apply ambiguity exclusions across evaluated sources.',
 'Schema inspection is limited to known customer/order evidence tables, including WW raw Woo orders. Hash contracts are unverified and hashes are never joined.','Malformed/placeholder/conflict counts may overlap. Usable email does not imply unambiguous linkage. Customer denominators exclude guests; eligible order counts separately include anonymous orders.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
 try{const report=await diagnoseEmailHistory({...createBigQueryClient(),signal:controller.signal});console.log(JSON.stringify(report));if(Object.values(report.source_outcomes).some(x=>x.state==='rejected'))process.exitCode=1;}
 catch(e){console.log(JSON.stringify({read_only:true,verified:false,failure:failure(e)}));process.exitCode=1;}
}
