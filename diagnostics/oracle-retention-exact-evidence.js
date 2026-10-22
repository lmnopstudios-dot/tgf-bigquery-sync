// Historical validators copied verbatim from a64543c1052e35e977a11c44e69ea7a8998396ef
// oracle/cohort-retention.js. Diagnostic only; never used to accept report evidence.
export function retentionRows(rows,sort='repeat_rate_desc',rankingWindow=90){
  if(!Array.isArray(rows)||rows.length>200)throw new Error('Retention row bound exceeded');
  return rows.filter(row=>!['collaboration','collaborations'].includes(row.collaboration_name)).map(row=>{
    const count=key=>{const n=Number(row[key]);if(row[key]===null||row[key]===undefined||typeof row[key]==='boolean'||row[key]===''||!Number.isInteger(n)||n<0)throw new Error('Invalid retention count');return n;};
    const cohort_customers=count('cohort_customers'),mature_customers=count('mature_customers'),repeat_customers=count('repeat_customers');
    if(repeat_customers>mature_customers||mature_customers>cohort_customers||![90,180,360].includes(Number(row.window_days)))throw new Error('Invalid retention denominator');
    if(row.observation_coverage_status!=null){
      if(!['unverified','verified_continuous'].includes(row.observation_coverage_status))throw Error('Invalid observation coverage');
      if(row.observation_coverage_status==='unverified'&&(mature_customers!==0||repeat_customers!==0))throw Error('Unsupported mature denominator');
      if(count('observed_repeat_customers')>cohort_customers||count('observed_repeat_customers')<repeat_customers)throw Error('Invalid observed repeat count');
      if(row.observation_coverage_status==='verified_continuous'&&(!row.verified_coverage_start||!row.verified_coverage_end||!row.coverage_evidence))throw Error('Missing verified coverage boundary');
    }
    const median=row.median_days_to_second==null?null:Number(row.median_days_to_second);
    if(median!==null&&(!Number.isFinite(median)||median<0||median>=Number(row.window_days)+2)||repeat_customers===0&&median!==null||repeat_customers>0&&median===null)throw new Error('Invalid conditional retention median');
    if(!((row.source_platform==='woo'&&['ww','usd'].includes(row.source_store))||(row.source_platform==='shopify'&&row.source_store==='shopify'))||!row.collaboration_name&&!row.entry_product_ref)throw new Error('Missing retention population');
    const products=row.second_order_products;
    if(products!=null&&(!Array.isArray(products)||products.length>10||new Set(products.map(p=>p.product_ref)).size!==products.length||products.some(p=>typeof p.product_ref!=='string'||!p.product_ref||typeof p.product!=='string'||!['observed_customers','mature_repeat_customers'].every(k=>Number.isSafeInteger(Number(p[k]))&&Number(p[k])>=0)||Number(p.observed_customers)>Number(row.observed_repeat_customers)||Number(p.mature_repeat_customers)>repeat_customers||Number(p.mature_repeat_customers)>Number(p.observed_customers))))throw Error('Invalid second-order products');
    const secondKeys=['same_collaboration','different_collaboration','core_range','unknown'];
    const second=Object.fromEntries(secondKeys.map(k=>[k,row[k]==null?null:count(k)]));
    if(secondKeys.some(k=>second[k]!==null)&&(!secondKeys.every(k=>second[k]!==null)||secondKeys.reduce((n,k)=>n+second[k],0)!==repeat_customers))throw new Error('Invalid second-purchase classification');
    return {...(products!=null?{second_order_products:products.map(p=>({...p,observed_customers:Number(p.observed_customers),mature_repeat_customers:Number(p.mature_repeat_customers)}))}:{}),...(row.observation_coverage_status?{coverage_evidence:row.coverage_evidence||null,observation_coverage_status:row.observation_coverage_status,verified_coverage_start:row.verified_coverage_start?.value||row.verified_coverage_start||null,verified_coverage_end:row.verified_coverage_end?.value||row.verified_coverage_end||null,observed_repeat_customers:count('observed_repeat_customers')}:{}),...second,...(row.entry_product_ref?{entry_product_ref:row.entry_product_ref,entry_product:row.entry_product}:{}),source_platform:row.source_platform,source_store:row.source_store,collaboration_name:row.collaboration_name,window_days:Number(row.window_days),cohort_customers,mature_customers,repeat_customers,repeat_rate:mature_customers?repeat_customers/mature_customers:null,median_days_to_second:median};
  }).sort((a,b)=>a.source_platform.localeCompare(b.source_platform)||a.source_store.localeCompare(b.source_store)||(a.window_days===rankingWindow?0:1)-(b.window_days===rankingWindow?0:1)||(sort==='returning_customers_desc'?b.repeat_customers-a.repeat_customers:0)||(b.repeat_rate??-1)-(a.repeat_rate??-1)||b.mature_customers-a.mature_customers||String(a.entry_product_ref||a.collaboration_name).localeCompare(String(b.entry_product_ref||b.collaboration_name)));
}
export function retentionCoverage(rows=[]){
  if(!Array.isArray(rows)||rows.length>3)throw new Error('Invalid retention coverage');
  return rows.map(c=>{
    const keys=['eligible_first_customers','named_customers','generic_only_customers','unknown_customers','identified_orders','anonymous_orders','migrated_orders','excluded_orders'];
    if(!['woo','shopify'].includes(c.source_platform)||typeof c.source_store!=='string'||!keys.every(k=>c[k]!==null&&c[k]!==undefined&&typeof c[k]!=='boolean'&&c[k]!==''&&Number.isSafeInteger(Number(c[k]))&&Number(c[k])>=0))throw new Error('Invalid retention coverage count');
    const out=Object.fromEntries(keys.map(k=>[k,Number(c[k])]));
    if(out.named_customers+out.generic_only_customers+out.unknown_customers+Number(c.core_only_customers||0)!==out.eligible_first_customers)throw new Error('Invalid retention coverage partition');
    const day=k=>c[k]?.value||c[k];
    if(!['history_start','history_end'].every(k=>/^\d{4}-\d{2}-\d{2}$/.test(day(k)))||day('history_start')>day('history_end'))throw new Error('Invalid retention history coverage');
    if(c.conflicting_customers!=null&&(!Number.isSafeInteger(Number(c.conflicting_customers))||Number(c.conflicting_customers)<0||Number(c.conflicting_customers)>out.eligible_first_customers))throw new Error('Invalid conflicting coverage');
    const stages=c.classification_stages;
    if(stages!=null&&(!Array.isArray(stages)||stages.some(x=>!['product_identity_unmatched','classification_absent','generic_only','named','conflicting','core'].includes(x.collaboration_state)||!['product_lines','customers'].every(k=>Number.isSafeInteger(Number(x[k]))&&Number(x[k])>=0))))throw new Error('Invalid classification stages');
    if(c.core_only_customers!=null&&(!Number.isSafeInteger(Number(c.core_only_customers))||Number(c.core_only_customers)<0))throw Error('Invalid core coverage');
    return {...out,...(c.core_only_customers!=null?{core_only_customers:Number(c.core_only_customers)}:{}),...(stages?{classification_stages:stages.map(x=>({...x,product_lines:Number(x.product_lines),customers:Number(x.customers)}))}:{}),conflicting_customers:c.conflicting_customers==null?null:Number(c.conflicting_customers),source_platform:c.source_platform,source_store:c.source_store,history_start:day('history_start'),history_end:day('history_end'),cancelled_orders:c.cancelled_orders==null?null:Number(c.cancelled_orders)};
  });
}

// Execute the historical provider projection and validation in memory. No SQL,
// report execution, mutation, fallback to new data or validation relaxation.
export function reproduceRetainedBaseline(raw){
  const plain=JSON.parse(JSON.stringify(raw));
  const results=plain.filter(r=>r.window_days!=null).map(r=>({...r,...(r.entry_product_ref?{entry_product:r.entry_product_title}:{})}));
  const reads=[];
  const describe=v=>({type:v===null?'null':Array.isArray(v)?'array':typeof v,...(typeof v==='number'?{number:v}:{}),...(typeof v==='string'?{length:v.length,...(['shopify','woo','ww','usd','Sitewide','unverified','verified_continuous'].includes(v)?{scope_value:v}:{})}:{})});
  const wrap=(v,path)=>v&&typeof v==='object'?new Proxy(v,{get(target,key){const next=path+(String(key).match(/^\d+$/)?`[${key}]`:'.'+String(key)),value=Reflect.get(target,key);if(typeof key==='string'&&typeof value!=='function')reads.push({path:next,...describe(value)});if(reads.length>80)reads.shift();return wrap(value,next);}}):v;
  let stage='retention_rows';
  try{
    const validated=retentionRows(wrap(results,'results'));
    stage='baseline_identity';
    if(validated.length>3||validated.some(r=>r.collaboration_name!=='Sitewide'||r.entry_product_ref))throw Error('Invalid sitewide baseline');
    stage='source_scope';
    if(validated.some(r=>r.source_platform!=='shopify'||r.source_store!=='shopify'))throw Error('Retention source mismatch');
    stage='grouping_scope';
    if(validated.some(r=>Boolean(r.entry_product_ref)))throw Error('Retention grouping mismatch');
    stage='coverage';const coverage=retentionCoverage(wrap(plain[0]?.coverage||[],'classification_coverage'));
    stage='coverage_source';if(coverage.some(c=>c.source_platform!=='shopify'||c.source_store!=='shopify'))throw Error('Retention coverage source mismatch');
    return {state:'accepted_by_historical_component_validator',rows:results.length,coverage_rows:coverage.length,live_fix_verified:false};
  }catch(error){
    return {state:'reproduced_rejection',code:'EVIDENCE_SCOPE_MISMATCH',stage,predicate:error.message,
      // A predicate may involve several fields. These are inputs, not an assertion
      // that its last property access alone establishes the cause.
      predicate_inputs:reads.slice(-30),identity_inputs:results.map((r,i)=>({row:i,...Object.fromEntries(['source_platform','source_store','collaboration_name','entry_product_ref'].map(k=>[k,{...describe(r[k]),...(typeof r[k]==='string'&&/^[a-zA-Z0-9_:. -]{1,100}$/.test(r[k])?{value:r[k]}:{})}]))})),row_inputs:results.map((r,i)=>({row:i,...Object.fromEntries(['window_days','cohort_customers','mature_customers','repeat_customers','observed_repeat_customers','median_days_to_second','same_collaboration','different_collaboration','core_range','unknown'].map(k=>[k,describe(r[k])]))})),live_fix_verified:false};
  }
}

export function ingestionRunSql(project,kind){
  if(!/^[a-zA-Z0-9_-]+$/.test(project)||!['finance','customer'].includes(kind))throw Error('Invalid diagnostic scope');
  const table=kind==='finance'?'finance_refresh_runs':'customer_refresh_runs',state=kind==='finance'?'finance_refresh_state':'customer_refresh_state';
  return `WITH runs AS (SELECT * FROM \`${project}.shopify_data.${table}\` WHERE window_start<TIMESTAMP('2026-10-20', 'Europe/London') AND window_end>TIMESTAMP('2022-10-19','Europe/London')),
    successful AS (SELECT *,MAX(window_end) OVER(ORDER BY window_start,window_end,run_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end FROM runs WHERE status='succeeded'${kind==='customer'?" AND mode='scheduled'":''}),
    summary AS (SELECT COUNT(*) succeeded_runs,MIN(window_start) first_update_start,MAX(window_end) last_update_end,COUNTIF(prior_end IS NOT NULL AND window_start>prior_end) internal_update_gaps FROM successful)
    SELECT *, (SELECT COUNT(*) FROM runs) total_runs,
      ARRAY(SELECT AS STRUCT run_id,mode,window_start,window_end,status,${kind==='finance'?'order_count,refund_count,page_count':'requested_count,returned_count,ARRAY_LENGTH(unresolved_ids) unresolved_count'},started_at,finished_at FROM runs ORDER BY started_at DESC LIMIT 12) recent_runs,
      ARRAY(SELECT AS STRUCT window_start,prior_end FROM successful WHERE prior_end IS NOT NULL AND window_start>prior_end ORDER BY window_start LIMIT 12) update_gap_examples,
      ARRAY(SELECT AS STRUCT collector,successful_watermark,run_id,updated_at FROM \`${project}.shopify_data.${state}\` LIMIT 2) current_state,
      'update-window/selected-ID evidence only; not a created-order coverage certificate' interpretation FROM summary`;
}

export async function readExactRetentionEvidence({bigquery,project,now=()=>Date.now(),maximumMs=40000}){
  const start=now(),checks=[];
  const failure=e=>({status:'unavailable',http_status:Number.isInteger(Number(e.code))?Number(e.code):null,reason:['EXACT_CHECK_DEADLINE','EXACT_RESULT_TRUNCATED'].includes(e.code)?e.code:'existing_evidence_read_failed'});
  const remaining=()=>{const ms=maximumMs-(now()-start);if(ms<=0)throw Object.assign(Error(),{code:'EXACT_CHECK_DEADLINE'});return Math.min(ms,10000);};
  const independently=async(name,fn)=>{try{checks.push({check:name,status:'read_completed',...await fn()});}catch(e){checks.push({check:name,...failure(e)});}};
  await independently('retained_baseline_result',async()=>{
    remaining();const job=bigquery.job('6026f7a6-44c6-4449-9814-398b028296f1',{location:'US'});
    const [metadata]=await job.getMetadata({maxRetries:0});
    if(metadata.status?.state!=='DONE'||metadata.status?.errorResult)return {warehouse_state:metadata.status?.state,warehouse_failed:Boolean(metadata.status?.errorResult),validation_not_attempted:true};
    const [rows,next,response]=await job.getQueryResults({autoPaginate:false,maxResults:4,timeoutMs:remaining(),maxRetries:0});
    if(next||response?.pageToken||rows.length>3)throw Object.assign(Error(),{code:'EXACT_RESULT_TRUNCATED'});
    return {warehouse_state:'DONE',warehouse_failed:false,validation:reproduceRetainedBaseline(rows)};
  });
  let location;
  await independently('shopify_dataset_location',async()=>{remaining();const [m]=await bigquery.dataset('shopify_data').getMetadata({maxRetries:0});location=m.location;if(!location)throw Error();return {location};});
  for(const kind of ['finance','customer'])await independently(kind+'_transaction_ingestion_records',async()=>{
    if(!location)throw Error();const [rows]=await bigquery.query({query:ingestionRunSql(project,kind),location,useLegacySql:false,autoPaginate:false,maxResults:2,jobTimeoutMs:remaining(),maximumBytesBilled:'100000000',labels:{component:'retention_exact_evidence'},maxRetries:0});
    return {records:JSON.parse(JSON.stringify(rows)),certification:'not_inferred'};
  });
  return {read_only:true,report_replayed:false,query_id:'6026f7a6-44c6-4449-9814-398b028296f1',historical_validator_revision:'a64543c1052e35e977a11c44e69ea7a8998396ef',bounds:{existing_result_gets:1,metadata_gets:2,select_jobs:2,maximum_bytes_total:200000000,deadline_ms:maximumMs},checks};
}
