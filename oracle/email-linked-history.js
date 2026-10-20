// Internal identifiers never leave SQL. Candidate linkage is analytical, not a
// person identity assertion. Unknown schema/hash contracts are never guessed.
import {customerJourneySql} from './customer-journey.js';
import {cohortRelations} from './cohort-execution.js';
export const EMAIL_SOURCES=Object.freeze({ww:{dataset:'metorik_uk',platform:'woo',tables:['orders','customers']},usd:{dataset:'metorik_us',platform:'woo',tables:['orders','customers']},shopify:{dataset:'shopify_data',platform:'shopify',tables:['order_customers','customers']}});
export function emailState(value){
 const normalized=typeof value==='string'?value.trim().toLowerCase():'';
 if(!normalized)return {state:'missing',normalized:null};
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))return {state:'malformed',normalized:null};
 if(/^(?:test|unknown|none|null|noemail|no-email|noreply|no-reply|guest|placeholder)(?:[+._-]|@)|@(?:example\.(?:com|org|net)|invalid\.|test\.)|\.(?:invalid|test)$/.test(normalized))return {state:'placeholder',normalized:null};
 return {state:'usable',normalized};
}
const table=(project,dataset,name)=>{if(!/^[a-z][a-z0-9-]{4,62}$/.test(project)||![dataset,name].every(x=>/^[a-z_]+$/.test(x)))throw Error('Invalid relation');return `\`${project}.${dataset}.${name}\``;};
export function emailSchemaSql(project,dataset){
 const relation=table(project,dataset,'columns').replace(/columns`$/,'INFORMATION_SCHEMA.COLUMNS`');
 return `SELECT table_name,column_name,data_type FROM ${relation} WHERE table_name IN ('orders','customers','order_customers','orders_api') AND (column_name IN ('customer_id','metorik_customer_id','id','order_id','raw_json','billing','customer') OR REGEXP_CONTAINS(LOWER(column_name),r'email|hash|migrat|mapping')) LIMIT 201`;
}

const paths=['$.email','$.billing_email','$.customer_email','$.billing.email','$.customer.email'];
export function emailEvidenceCtes(project,schemas,{stores=Object.keys(EMAIL_SOURCES)}={}){
 const selects=[];
 for(const [store,s] of Object.entries(EMAIL_SOURCES)){
  if(!stores.includes(store))continue;
  const locations=[...s.tables.map(name=>[s.dataset,name]),...(store==='ww'?[['woocommerce_uk','orders_api']]:[])];
  for(const [dataset,name] of locations){
   const columns=schemas[dataset]?.filter(x=>x.table_name===name)||[];
   if(!columns.length)continue;
   const names=new Set(columns.map(x=>x.column_name));
   const id=names.has('customer_id')?'customer_id':null;
   if(!id)continue; // Metorik customer ID is not silently assumed to be a Woo ID.
   const record=name==='customers'?'customer':'order';
   const values=paths.filter(p=>names.has(p.split('.')[1])).map(p=>`JSON_VALUE(TO_JSON_STRING(t.${p.split('.')[1]}),'${p.split('.').length===2?'$':'$.email'}')`);
   if(names.has('raw_json'))for(const p of paths)values.push(`JSON_VALUE(t.raw_json,'${p}')`);
   if(!values.length)values.push('CAST(NULL AS STRING)');
   selects.push(`SELECT '${store}' source_store,CAST(t.${id} AS STRING) profile,'${record}' evidence_level,${record==='order'&&names.has('order_id')?'CAST(t.order_id AS STRING)':'CAST(NULL AS STRING)'} evidence_order,email FROM ${table(project,dataset,name)} t CROSS JOIN UNNEST([${values.join(',')}]) email`);
  }
 }
 if(!selects.length)throw Error('No evaluated email relations');
 return `email_raw AS (${selects.join('\nUNION ALL\n')}),
 email_normalized AS (SELECT *,LOWER(TRIM(email)) normalized FROM email_raw),
 email_states AS (SELECT *,CASE WHEN normalized IS NULL OR normalized='' THEN 'missing'
 WHEN NOT REGEXP_CONTAINS(normalized,r'^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$') THEN 'malformed'
 WHEN REGEXP_CONTAINS(normalized,r'^(test|unknown|none|null|noemail|no-email|noreply|no-reply|guest|placeholder)([+._-]|@)|@(example\\.(com|org|net)|invalid\\.|test\\.)|\\.(invalid|test)$') THEN 'placeholder' ELSE 'usable' END state FROM email_normalized),
 email_profiles AS (SELECT source_store,profile,COUNT(DISTINCT IF(state='usable',normalized,NULL)) usable_emails,MIN(IF(state='usable',normalized,NULL)) normalized,
 COUNT(DISTINCT IF(evidence_level='customer' AND state='usable',normalized,NULL)) customer_emails,
 COUNT(DISTINCT IF(evidence_level='order' AND state='usable',normalized,NULL)) order_emails,
 COUNTIF(state='malformed')>0 malformed,COUNTIF(state='placeholder')>0 placeholder
 FROM email_states WHERE profile IS NOT NULL AND profile NOT IN ('','0') GROUP BY 1,2),
 email_degrees AS (SELECT normalized,source_store,COUNT(DISTINCT profile) profiles FROM email_states WHERE state='usable' AND profile IS NOT NULL AND profile NOT IN ('','0') GROUP BY 1,2),
 email_bad AS (SELECT DISTINCT normalized FROM email_states WHERE state='usable' AND (source_store,profile) IN (SELECT AS STRUCT source_store,profile FROM email_profiles WHERE usable_emails>1)
 UNION DISTINCT SELECT normalized FROM email_degrees WHERE profiles>1),
 email_links AS (SELECT p.* FROM email_profiles p WHERE usable_emails=1 AND normalized NOT IN (SELECT normalized FROM email_bad))`;
}
export function emailLinkedJourneySql(project,schemas,{baseline=false,stores=Object.keys(EMAIL_SOURCES)}={}){
 if(!stores.length||stores.some(store=>!Object.hasOwn(EMAIL_SOURCES,store)))throw Error('Invalid evaluated sources');
 const original=cohortRelations(customerJourneySql(project,'retention_windows'));
 let sql='WITH\n'+original.relations.map(r=>{
  const body=['raw_orders','lines'].includes(r.name)?r.body.split(/\n    UNION ALL /).filter(part=>stores.some(store=>part.includes("'"+store+"' source_store"))).join('\n UNION ALL '):r.body;
  return `${r.name} AS (${body})`;
 }).join(',\n')+'\n'+original.result;
 sql=sql.replace('WITH\n',()=>`WITH\n ${emailEvidenceCtes(project,schemas,{stores})},\n`);
 // Retain canonical transactions, original namespaces, eligibility and products.
 // Relink before sequencing all histories and applying entry-period filters.
 sql=sql.replace("CONCAT('c_',TO_HEX(SHA256(CONCAT(source_platform,'|',source_store,'|',source_customer_id)))) governed_customer_ref", "CONCAT('email_',TO_HEX(SHA256(el.normalized))) governed_customer_ref");
 sql=sql.replace('FROM orders WHERE source_customer_id', 'FROM orders JOIN email_links el ON el.source_store=orders.source_store AND el.profile=orders.source_customer_id WHERE channel=\'Online\' AND source_customer_id');
 // Avoid ambiguous unqualified source_store from the internal evidence join.
 sql=sql.replace('SELECT *,CONCAT(\'email_', 'SELECT orders.*,CONCAT(\'email_');
 // Shared cohort totals span entry sources; original transaction identity remains
 // in entry_orders/ranked_orders and all product joins.
 const parsed=cohortRelations(sql);
 const entry=parsed.relations.find(x=>x.name==='entry_matches').body;
 sql=sql.replace(entry,()=>entry.replace('e.source_platform,e.source_store',"'email_linked' source_platform,'all' source_store"));
 if(baseline){
  const {relations}=cohortRelations(sql);const body=relations.find(x=>x.name==='entry_matches').body;
  sql=sql.replace(body,()=>`SELECT e.governed_customer_ref,'email_linked' source_platform,'all' source_store,e.order_ref entry_order_ref,e.order_timestamp entry_timestamp,'Overall email-linked first-observed baseline' collaboration_name FROM entry_orders e`);
 }
 return sql;
}
