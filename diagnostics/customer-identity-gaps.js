// Read-only, aggregate-only investigation. Never writes source or identity data.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {options,SOURCES,fq} from '../customer-identity/collect.js';
import {read} from '../customer-identity/operations.js';
import {sourceClient} from '../customer-identity/runtime.js';
import {emailState} from '../customer-identity/email.js';
import {safeReadFailure} from '../oracle/read-failure.js';

export function gapSql(project) {
  return `SELECT DISTINCT p.order_id FROM ${fq(project,'shopify_data','order_locations')} p
    WHERE DATE(p.created_at) BETWEEN @start AND @end
    AND NOT EXISTS(SELECT 1 FROM ${fq(project,'shopify_data','order_customers')} c WHERE c.order_id=p.order_id)
    ORDER BY p.order_id LIMIT 1001`;
}
export function classifyOrder(node,id) {
  if(node===null)return 'unavailable_order';
  if(!node||node.id!==id||!Object.hasOwn(node,'customer'))return 'extraction_failure';
  if(node.customer===null)return 'customerless_order';
  return /^gid:\/\/shopify\/Customer\/\d+$/.test(node.customer?.id||'')?'attached_customer_missing_row':'extraction_failure';
}
const bump=(counts,key)=>{counts[key]=(counts[key]||0)+1;};
export async function shopifyGaps({bigquery,project,o,client=sourceClient,env=process.env}) {
  const [rows]=await read(bigquery,gapSql(project),{start:o.start,end:o.end},{start:'DATE',end:'DATE'});
  if(rows.length>1000)throw Error('Relationship gap cap exceeded');
  const ids=rows.map(r=>r.order_id);
  if(new Set(ids).size!==ids.length||ids.some(id=>!/^gid:\/\/shopify\/Order\/\d+$/.test(id)))throw Error('Invalid gap identities');
  const budget={requests:0,bytes:0,maxRequests:24,maxBytes:33554432};
  const counts={customerless_order:0,attached_customer_missing_row:0,unavailable_order:0,extraction_failure:0,request_failure:0};
  if(ids.length){
    const {graphql}=await client('shopify',env,AbortSignal.timeout(90000),budget);
    for(let i=0;i<ids.length;i+=50){
      const batch=ids.slice(i,i+50);
      try {
        const data=await graphql('query GapOrders($ids:[ID!]!){nodes(ids:$ids){... on Order{id customer{id}}}}',{ids:batch});
        if(!Array.isArray(data?.nodes)||data.nodes.length!==batch.length){counts.extraction_failure+=batch.length;continue;}
        data.nodes.forEach((node,j)=>bump(counts,classifyOrder(node,batch[j])));
      } catch {counts.request_failure+=batch.length;}
    }
  }
  return {read_only:true,source:'shopify',gap_orders:ids.length,counts,complete:!counts.request_failure&&!counts.extraction_failure&&!counts.unavailable_order,
    repair_candidate_rows:counts.customerless_order+counts.attached_customer_missing_row,
    limitation:'A current customer=null establishes current customerlessness only. Both successful categories lack collection rows; neither establishes historical collector cause.'};
}

// Select two distinct orders per quarter and warehouse registered/guest stratum.
// Membership is checked again against the native API customer_id below.
export function wooSampleSql(project,o) {
  const s=SOURCES[o.source];
  return `WITH orders AS (SELECT CAST(order_id AS STRING) order_id,
    MIN(DATE(order_created_at)) order_date,ARRAY_AGG(TO_JSON_STRING(t) ORDER BY TO_JSON_STRING(t) LIMIT 1)[OFFSET(0)] retained
    FROM ${fq(project,s.dataset,'orders')} t WHERE DATE(order_created_at) BETWEEN @start AND @end GROUP BY 1),
    classified AS (SELECT *,FORMAT_DATE('%Y-Q%Q',order_date) quarter,
      IF(JSON_VALUE(retained,'$.customer_id') IS NULL OR JSON_VALUE(retained,'$.customer_id') IN ('','0'),'guest','registered') warehouse_kind FROM orders)
    SELECT * FROM classified QUALIFY ROW_NUMBER() OVER(PARTITION BY quarter,warehouse_kind ORDER BY order_date,order_id)<=2
    ORDER BY quarter,warehouse_kind,order_date,order_id LIMIT 81`;
}
export function fieldState(object,key) {
  if(!object||!Object.hasOwn(object,key))return 'extraction_failure';
  if(object[key]===null)return 'null';
  if(typeof object[key]!=='string')return 'extraction_failure';
  return object[key].trim()===''?'empty':emailState(object[key]).state;
}
export function retainedEmails(row) {
  const data=typeof row==='string'?JSON.parse(row):row;
  const values=[data?.email,data?.billing_email,data?.customer_email,data?.billing?.email,data?.customer?.email];
  if(data?.raw_json){const raw=typeof data.raw_json==='string'?JSON.parse(data.raw_json):data.raw_json;values.push(raw.email,raw.billing?.email,raw.customer?.email);}
  return values.filter(v=>typeof v==='string');
}
export async function wooSamples({bigquery,project,o,client=sourceClient,env=process.env}) {
  const [rows]=await read(bigquery,wooSampleSql(project,o),{start:o.start,end:o.end},{start:'DATE',end:'DATE'});
  if(rows.length>80)throw Error('Woo sample cap exceeded');
  const raw=new Map(),counts={},strata={};let retainedRead='not_configured_for_source';
  // UK retained native Woo evidence is additional to the Metorik order payload.
  if(o.source==='ww'&&rows.length){
    try {
      const [evidence]=await read(bigquery,`SELECT CAST(order_id AS STRING) order_id,TO_JSON_STRING(t) retained FROM ${fq(project,'woocommerce_uk','orders_api')} t WHERE CAST(order_id AS STRING) IN UNNEST(@ids) LIMIT 801`,{ids:rows.map(r=>r.order_id)},{ids:['STRING']});
      if(evidence.length>800)throw Error('Retained evidence cap exceeded');
      for(const r of evidence)raw.set(r.order_id,[...(raw.get(r.order_id)||[]),...retainedEmails(r.retained)]);
      retainedRead='succeeded';
    } catch {retainedRead='unavailable_or_incompatible';}
  }
  const budget={requests:0,bytes:0,maxRequests:160,maxBytes:33554432};
  const {woo}=rows.length?await client(o.source,env,AbortSignal.timeout(180000),budget):{};
  for(const row of rows){
    if(!/^\d+$/.test(row.order_id))throw Error('Invalid Woo identity');
    const key=`${row.quarter}/${row.warehouse_kind}`;bump(strata,key);
    let evidence=[];
    try {evidence=[...retainedEmails(row.retained),...(raw.get(row.order_id)||[])];}
    catch {bump(counts,'retained_extraction_failure');}
    const usable=evidence.filter(v=>emailState(v).state==='usable');
    if(usable.length)bump(counts,'retained_usable_orders');
    let order;
    try {order=await woo(`orders/${row.order_id}`);}catch {bump(counts,'order_unavailable');continue;}
    if(String(order?.id)!==row.order_id){bump(counts,'order_extraction_failure');continue;}
    const state=fieldState(order.billing,'email');bump(counts,`api_order_${state}`);
    if(usable.length&&state!=='usable')bump(counts,'retain_usable_despite_missing_or_unusable_api');
    if(state==='usable'&&usable.length){bump(counts,usable.some(v=>emailState(v).normalized===emailState(order.billing.email).normalized)?'retained_api_agree':'retained_api_differ');}
    if(!Object.hasOwn(order,'customer_id')||!Number.isSafeInteger(order.customer_id)||order.customer_id<0){bump(counts,'customer_id_extraction_failure');continue;}
    if(order.customer_id===0){bump(counts,'api_guest');continue;}
    bump(counts,'api_registered');
    try {
      const customer=await woo(`customers/${order.customer_id}`);
      bump(counts,String(customer?.id)!==String(order.customer_id)?'customer_extraction_failure':`api_customer_${fieldState(customer,'email')}`);
    } catch {bump(counts,'customer_unavailable');}
  }
  return {read_only:true,source:o.source,sampled_orders:rows.length,strata,counts,additional_retained_woo_read:retainedRead,
    limitation:'Purposive bounded samples are not prevalence estimates or proof of redaction. Unavailable reads are not null emails; omitted fields are extraction failures. Guest/registered strata initially use warehouse IDs, never as native customer lookup IDs.'};
}
export async function main(argv=process.argv.slice(2)) {
  const o=options(argv);if(o.apply)throw Error('Read-only operation');
  const {bigquery,project}=createBigQueryClient();
  return o.source==='shopify'?shopifyGaps({bigquery,project,o}):wooSamples({bigquery,project,o});
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(r=>{console.log(JSON.stringify(r));if(r.complete===false)process.exitCode=2;}).catch(error=>{console.error(JSON.stringify({read_only:true,status:'unavailable',failure:safeReadFailure(error,'diagnostic')}));process.exitCode=2;});
