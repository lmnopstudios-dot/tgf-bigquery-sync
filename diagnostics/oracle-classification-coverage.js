// Bounded read-only aggregate diagnostics; no customer identifiers or mutations.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {retentionDefinition} from '../oracle/cohort-retention.js';
import {QUESTION} from './oracle-cohort-providers.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {safeReadFailure} from '../oracle/read-failure.js';

export async function classificationDiagnosticOptions({project,source,store,now,stage}){
 if(!['stages','gaps','identity','history','keys','catalogue'].includes(stage))throw Error('Invalid diagnostic stage');
 let settings;
 const deps=createOracleProviderDependencies({project,bigquery:{query:async q=>{settings=q;return [[]];}}});
 const context=transitionAnalysisContext(null,QUESTION,{now}).context,definition=retentionDefinition(context);
 await deps.customerJourney.analyzeCustomerJourney({...definition,cohort:{...definition.cohort,entry_source:source}},{sourceStore:store});
 const sql=settings.query.split(', retention_members AS (')[0];
 const selections={
  stages:`SELECT st.* FROM entry_stage_coverage st ORDER BY collaboration_state LIMIT 20`,
  gaps:`SELECT l.source_platform,l.source_store,l.source_product_ref,l.collaboration_state,COUNT(*) product_lines,COUNT(DISTINCT e.governed_customer_ref) first_customers,EXISTS(SELECT 1 FROM cr_routes r WHERE r.source_ref=l.source_product_ref) approved_route FROM entry_orders e JOIN line_classification_sets l USING(source_platform,source_store,order_ref) WHERE l.collaboration_state IN ('product_identity_unmatched','classification_absent','generic_only','conflicting') GROUP BY ALL ORDER BY first_customers DESC,source_product_ref LIMIT 100`,
  identity:`SELECT source_platform,source_store,COUNT(*) orders,COUNTIF(source_customer_id IS NULL) missing_customer_id,COUNTIF(source_customer_id='') empty_customer_id,COUNTIF(source_customer_id='0') guest_zero,COUNTIF(NOT customer_record_present) missing_customer_record,COUNTIF(persisted_guest) persisted_guest_orders,COUNTIF(REGEXP_CONTAINS(source_customer_id,r'^[0-9]+$')) numeric_identity,COUNTIF(REGEXP_CONTAINS(source_customer_id,r'^gid://shopify/Customer/[0-9]+$')) shopify_customer_gid,COUNTIF(source_customer_id IS NOT NULL AND source_customer_id NOT IN ('','0') AND NOT REGEXP_CONTAINS(source_customer_id,r'^(?:gid://shopify/Customer/)?[0-9]+$')) other_format FROM orders WHERE DATE(order_timestamp,@time_zone)<=@observation_end GROUP BY 1,2 LIMIT 3`,
  history:`SELECT source_platform,source_store,DATE(order_timestamp,@time_zone) observed_date,migrated,cancelled,status,COUNT(*) orders,COUNTIF(source_customer_id IS NOT NULL AND source_customer_id NOT IN ('','0')) identified_orders,COUNTIF(NOT migrated AND NOT cancelled AND ((source_platform='woo' AND status IN ('completed','processing')) OR (source_platform='shopify' AND status IN ('paid','partially_paid','partially_refunded'))) AND COALESCE(order_total,0)>COALESCE(refunds,0)) eligible_status_orders FROM orders WHERE DATE(order_timestamp,@time_zone) BETWEEN DATE '2025-11-01' AND DATE '2025-11-30' GROUP BY ALL ORDER BY observed_date,migrated,cancelled,status LIMIT 200`,
  catalogue:`SELECT l.source_platform,l.source_store,COUNT(*) historical_product_lines,COUNTIF(p.product_id IS NOT NULL) surviving_shopify_catalogue_lines,COUNTIF(p.product_id IS NULL) missing_shopify_catalogue_lines,COUNTIF(EXISTS(SELECT 1 FROM cr_routes r WHERE r.source_ref=l.source_product_ref)) approved_route_lines FROM source_lines l JOIN qualifying_orders o USING(source_platform,source_store,order_ref) LEFT JOIN \`${project}.shopify_catalogue.products\` p ON l.source_product_ref=CONCAT('shopify:shopify:',CAST(p.product_id AS STRING)) WHERE l.source_platform='shopify' GROUP BY 1,2 LIMIT 3`,
  keys:`SELECT 'product_classifications' evidence_table,CONCAT(SPLIT(subject_ref,':')[SAFE_OFFSET(0)],':',SPLIT(subject_ref,':')[SAFE_OFFSET(1)]) source_namespace,classification_type,classification_value,provenance,status,COUNT(*) evidence_rows,COUNT(DISTINCT subject_ref) products FROM \`${project}.commerce.product_classifications\` GROUP BY ALL UNION ALL SELECT 'collection_classifications','shopify:shopify',classification_type,classification_value,provenance,status,COUNT(*),COUNT(DISTINCT collection_id) FROM \`${project}.commerce.collection_classifications\` WHERE platform='shopify' GROUP BY ALL ORDER BY products DESC,classification_type,classification_value LIMIT 100`
 };
 return {...settings,query:sql+'\n'+selections[stage],jobTimeoutMs:15000,maximumBytesBilled:'20000000000',labels:{component:'classification_coverage',operation:stage}};
}
export async function diagnoseClassificationCoverage({bigquery,project,now=Date.now(),source='woo',store='ww',stage='stages',execute=false}){
 if(!((source==='woo'&&['ww','usd'].includes(store))||(source==='shopify'&&store==='shopify')))throw Error('Invalid source/store');
 const options=await classificationDiagnosticOptions({project,source,store,now,stage});
 let sqlVerified=false;
 try{
  const [job]=await boundedEvidenceRead(()=>bigquery.createQueryJob({...options,dryRun:true}),{maximumMs:15000});
  sqlVerified=true;
  const rows=execute?(await boundedQuery(bigquery,options,{maximumMs:15000}))[0]:null;
  return {read_only:true,source,store,stage,state:'fulfilled',sql_verified:true,executed:execute,bytes:job.metadata?.statistics?.totalBytesProcessed??null,rows,truncated:rows?.length===(stage==='gaps'||stage==='keys'?100:stage==='history'?200:20),identity_contract:'Source-qualified persisted customer IDs only. Null/zero does not prove a real-world anonymous customer; no guest substitution or cross-source linkage.',classification_contract:'Current governed view; not certified purchase-time classification. Valid historical product keys do not certify a surviving catalogue record.'};
 }catch(error){return {read_only:true,source,store,diagnostic_stage:stage,state:'rejected',sql_verified:sqlVerified,executed:false,...safeReadFailure(error,sqlVerified?'population_query':'population_dry_run'),code:'CLASSIFICATION_RETRIEVAL_FAILED'}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const arg=(key,fallback)=>process.argv.find(x=>x.startsWith(`--${key}=`))?.split('=').slice(1).join('=')||fallback;
 const result=await diagnoseClassificationCoverage({...createBigQueryClient(),now:Date.parse(arg('as-of','2026-10-19T12:00:00Z')),source:arg('source','woo'),store:arg('store','ww'),stage:arg('stage','stages'),execute:process.argv.includes('--execute')});
 console.log(JSON.stringify(result,null,2));if(result.state==='rejected')process.exitCode=1;
}
