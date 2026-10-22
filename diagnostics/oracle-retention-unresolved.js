// Dependency-injected so Render can load this pinned module in memory and use
// deployed SDK/SQL helpers. No filesystem, commerce API calls, DDL or queue mutation.
export const INCIDENT=Object.freeze({request:'cda4261c-436a-4c99-89fc-36216381d87b',job:'326dd52c-f3b4-4ade-a86e-0b53e58eb7a5',snapshot:'history-20261022-billing-v3',identityDataset:'customer_identity',start:'2022-10-19',end:'2026-10-19',zone:'Europe/London',
  // Unanswered incident rows, not a cohort/classification allowlist. Names and
  // membership must still come from current governed collection decisions.
  collections:['657944510791','690153193799','658364334407','659656573255','658346246471','658005721415','657966924103','658349228359','657939923271','657939759431']});
const DATASETS=['commerce','customer_identity','metorik_uk','metorik_us','shopify_data'];
const token=s=>typeof s==='string'&&/^[A-Za-z0-9_.:/+-]{1,180}$/.test(s)?s:null;
const ident=s=>{if(!/^[A-Za-z0-9_-]+$/.test(s||''))throw Error('Invalid diagnostic identifier');return s;};
const fq=(p,d,t)=>`\`${ident(p)}.${ident(d)}.${ident(t)}\``;
const value=v=>v?.value??v;
const json=v=>typeof v==='string'?JSON.parse(v):v;
const redact=v=>typeof value(v)==='string'?(token(value(v))||'[redacted non-machine value]'):value(v);
const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(value(v)||'')?value(v):null;

export function retainedEvidenceSql(project,dataset,table){
 return `WITH saved AS (SELECT job_id,status,result_json FROM ${fq(project,dataset,table)} WHERE request_id=@request_id AND job_id=@job_id LIMIT 2),
 normalized AS (SELECT *,COALESCE(SAFE.PARSE_JSON(JSON_VALUE(result_json,'$')),result_json) r FROM saved),
 unwrapped AS (SELECT *,COALESCE(JSON_QUERY(r,'$.result_json'),JSON_QUERY(r,'$.result'),r) u FROM normalized),
 evidence AS (SELECT job_id,status,COALESCE(JSON_QUERY(u,'$.evidence'),JSON_QUERY(SAFE.PARSE_JSON(JSON_VALUE(u,'$')),'$.evidence')) e FROM unwrapped)
 SELECT job_id,status,
 ARRAY(SELECT AS STRUCT JSON_VALUE(o,'$.state') state,JSON_VALUE(o,'$.stage') stage,JSON_VALUE(o,'$.query_id') query_id,
 JSON_VALUE(o,'$.code') code,SAFE_CAST(JSON_VALUE(o,'$.http_status') AS INT64) http_status,JSON_VALUE(o,'$.bigquery_reason') bigquery_reason,
 JSON_VALUE(o,'$.error_category') error_category,SAFE_CAST(JSON_VALUE(o,'$.statement_location.line') AS INT64) error_line,SAFE_CAST(JSON_VALUE(o,'$.statement_location.column') AS INT64) error_column
 FROM UNNEST(JSON_QUERY_ARRAY(e,'$.source_outcomes')) o WHERE JSON_VALUE(o,'$.source_store')='shopify' AND JSON_VALUE(o,'$.group')='retention_baseline_windows' LIMIT 2) baseline_outcomes,
 ARRAY(SELECT DISTINCT JSON_VALUE(x,'$.collaboration_name') FROM UNNEST(JSON_QUERY_ARRAY(e,'$.rows')) x WHERE JSON_VALUE(x,'$.entry_product_ref') IS NULL AND JSON_VALUE(x,'$.collaboration_name') IS NOT NULL ORDER BY 1 LIMIT 100) displayed_names,
 ARRAY(SELECT DISTINCT AS STRUCT JSON_VALUE(x,'$.source_store') source_store,JSON_VALUE(x,'$.observation_coverage_status') status,
 JSON_VALUE(x,'$.verified_coverage_start') start_date,JSON_VALUE(x,'$.verified_coverage_end') end_date,JSON_VALUE(x,'$.coverage_evidence') evidence
 FROM UNNEST(JSON_QUERY_ARRAY(e,'$.rows')) x LIMIT 10) stored_followup,
 JSON_VALUE(e,'$.periods[0].start_date') entry_start,JSON_VALUE(e,'$.periods[0].end_date') entry_end,JSON_VALUE(e,'$.observation_end') observation_end
 FROM evidence LIMIT 2`;
}

export function reconciliationSql(project,platform,store,journeySql,parseSql){
 const identity={dataset:INCIDENT.identityDataset,snapshot:INCIDENT.snapshot,mode:'email_candidate_v2',orderLinks:true};
 const {relations}=parseSql(journeySql(project,'retention_windows',platform,store,identity));
 const mapping=relations.find(r=>r.name==='ci_mapping');
 if(!mapping?.body.includes(INCIDENT.snapshot)||!mapping.body.includes('identity_order_links')||!mapping.body.includes('Identity snapshot integrity failed'))throw Error('Deployed SQL lacks the frozen order-snapshot guard');
 const result=`SELECT t.collection_id,t.display_name,t.collaboration_name,t.products,
 COALESCE(e.eligible_customers,0) eligible_customers,COALESCE(h.historical_named_products,0) historical_named_products,
 COALESCE(m.members,0) persisted_members,COALESCE(r.source_routes,0) source_routes,
 COALESCE(hm.historical_routed_products,0) historical_routed_products,COALESCE(hm.unclassified_products,0) unclassified_products,COALESCE(hm.conflicting_products,0) conflicting_products
 FROM diagnostic_targets t
 LEFT JOIN (SELECT collaboration_name,COUNT(DISTINCT governed_customer_ref) eligible_customers FROM entry_matches GROUP BY collaboration_name) e USING(collaboration_name)
 LEFT JOIN (SELECT name collaboration_name,COUNT(DISTINCT source_product_ref) historical_named_products FROM line_classification_sets CROSS JOIN UNNEST(names) name WHERE source_store=@diagnostic_store AND collaboration_state='named' GROUP BY name) h USING(collaboration_name)
 LEFT JOIN (SELECT collection_id,COUNT(DISTINCT product_ref) members FROM diagnostic_members GROUP BY collection_id) m USING(collection_id)
 LEFT JOIN (SELECT collection_id,COUNT(DISTINCT source_ref) source_routes FROM diagnostic_routes WHERE STARTS_WITH(source_ref,@source_prefix) GROUP BY collection_id) r USING(collection_id)
 LEFT JOIN (SELECT r.collection_id,COUNT(DISTINCT l.source_product_ref) historical_routed_products,
 COUNT(DISTINCT IF(l.collaboration_state='classification_absent',l.source_product_ref,NULL)) unclassified_products,
 COUNT(DISTINCT IF(l.collaboration_state='conflicting',l.source_product_ref,NULL)) conflicting_products
 FROM diagnostic_routes r JOIN line_classification_sets l ON l.source_product_ref=r.source_ref WHERE l.source_store=@diagnostic_store GROUP BY r.collection_id) hm USING(collection_id)
 ORDER BY t.collection_id LIMIT 11`;
 const extra=[
  {name:'diagnostic_targets',body:`SELECT g.collection_id,COALESCE(n.collection_title,c.title,g.collection_title) display_name,n.classification_value collaboration_name,c.product_count products
 FROM ${fq(project,'shopify_catalogue','collections')} c JOIN cr_collection_current g ON g.collection_id=CAST(c.collection_id AS STRING) AND g.classification_type='collection_group' AND g.status='active' AND g.classification_value='collaboration'
 LEFT JOIN cr_collection_current n ON n.collection_id=g.collection_id AND n.classification_type='collaboration_name' AND n.status='active' WHERE g.collection_id IN UNNEST(@collection_ids)`},
  {name:'diagnostic_members',body:`SELECT DISTINCT t.collection_id,CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(pc.product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) product_ref FROM diagnostic_targets t JOIN ${fq(project,'shopify_catalogue','product_collections')} pc ON CAST(pc.collection_id AS STRING)=t.collection_id`},
  {name:'diagnostic_routes',body:'SELECT collection_id,product_ref source_ref FROM diagnostic_members UNION DISTINCT SELECT m.collection_id,r.source_ref FROM diagnostic_members m JOIN cr_routes r ON r.classification_ref=m.product_ref'}];
 const candidates=[...relations,...extra],needed=new Set();
 const visit=text=>{for(const r of candidates)if(!needed.has(r.name)&&new RegExp(`\\b(?:FROM|JOIN)\\s+${r.name}\\b`,'i').test(text)){needed.add(r.name);visit(r.body);}};visit(result);
 const query='WITH '+candidates.filter(r=>needed.has(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',\n')+'\n'+result;
 if(/\b(?:CREATE|DROP|MERGE|INSERT|UPDATE|DELETE|BEGIN|COMMIT|retention_members|retention_totals)\b/i.test(query))throw Error('Diagnostic query exceeded read-only scope');
 return query;
}

export function reconciliationReason(r){
 if(Number(r.products)===0)return 'no_current_products';
 if(!r.collaboration_name)return 'governed_name_unavailable';
 if(Number(r.eligible_customers)>0)return 'eligible_now_check_retained_omission';
 if(Number(r.historical_named_products)>0)return 'no_eligible_first_purchase_customers_in_current_read';
 if(Number(r.persisted_members)===0)return 'catalogue_membership_evidence_missing';
 if(Number(r.source_routes)===0)return 'governed_source_product_mapping_missing';
 if(Number(r.unclassified_products)>0||Number(r.conflicting_products)>0)return 'historical_classification_absent_or_conflicting';
 return 'historical_product_evidence_missing_cause_unverified';
}

const fieldGroups={source:['source_platform','platform'],store:['source_store','store','source'],start:['coverage_start','start_date','window_start','start'],end:['coverage_end','end_date','window_end','end'],zone:['time_zone','timezone','calendar_timezone'],status:['status','state'],evidence:['evidence','evidence_ref','evidence_reference'],continuous:['continuous','continuous_coverage'],channel:['channel','channel_scope']};
export function coverageProjection(columns){
 const available=new Set(columns),out=[];
 for(const [key,aliases] of Object.entries(fieldGroups)){const name=aliases.find(n=>available.has(n));if(name)out.push(`CAST(\`${name}\` AS STRING) ${key}`);}
 return out;
}

export async function runRetentionUnresolvedEvidence({bigquery,project,journeySql,parseSql,safeReadFailure,jobDataset='commerce',jobTable='oracle_analysis_jobs_v1',revision=null,now=Date.now,maximumMs=45000}){
 ident(project);ident(jobDataset);ident(jobTable);
 const deadline=now()+Math.min(45000,maximumMs),locations=new Map(),checks=[];let queries=0,metadataGets=0;
 const bounded=async work=>{
  const ms=deadline-now();if(ms<=0)throw Object.assign(Error('Deadline'),{code:'DIAGNOSTIC_DEADLINE'});
  let timer;try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Deadline'),{code:'DIAGNOSTIC_DEADLINE'})),Math.min(12000,ms));})]);}finally{clearTimeout(timer);}
 };
 const failure=e=>({status:'unavailable',failure:{...safeReadFailure(e,'diagnostic'),...(e.code==='DIAGNOSTIC_DEADLINE'?{diagnostic_code:e.code}:{})}});
 const check=async(name,work)=>{try{const result={check:name,status:'read_completed',...await work()};checks.push(result);return result;}catch(e){const result={check:name,...failure(e)};checks.push(result);return result;}};
 const location=dataset=>{
  if(!locations.has(dataset))locations.set(dataset,bounded(async()=>{metadataGets++;const [m]=await bigquery.dataset(dataset).getMetadata({maxRetries:0});if(!/^[A-Za-z][A-Za-z0-9-]{0,30}$/.test(m.location||''))throw Error('Missing dataset location');return m.location;}));
  return locations.get(dataset);
 };
 const read=async(dataset,query,params={},types={},bytes='104857600',limit=101)=>{
  const loc=await location(dataset);if(++queries>15)throw Error('Query bound exceeded');
  if(!/^\s*(SELECT|WITH)\b/i.test(query)||/\b(?:CREATE|DROP|MERGE|INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b/i.test(query))throw Error('Non-read query rejected');
  return bounded(async()=>{const [rows]=await bigquery.query({query,params,types,location:loc,useLegacySql:false,maximumBytesBilled:bytes,jobTimeoutMs:Math.max(1,Math.min(10000,deadline-now())),maxResults:limit,autoPaginate:false,labels:{component:'retention_unresolved',operation:'read_only'}});if(!Array.isArray(rows)||rows.length>limit)throw Error('Result bound exceeded');return rows;});
 };
 const retained=check('retained_shopify_baseline',async()=>{
  const rows=await read(jobDataset,retainedEvidenceSql(project,jobDataset,jobTable),{request_id:INCIDENT.request,job_id:INCIDENT.job},{},'1000000000',2);
  if(rows.length!==1)return {status:'unresolved',reason:rows.length?'ambiguous_saved_job':'saved_job_not_found'};
  const row=rows[0],outcomes=(row.baseline_outcomes||[]).map(o=>({...Object.fromEntries(['state','stage','query_id','code','bigquery_reason','error_category'].map(k=>[k,token(o[k])])),http_status:Number(o.http_status)||null,statement_location:Number(o.error_line)>0&&Number(o.error_column)>0?{line:Number(o.error_line),column:Number(o.error_column)}:null}));
  const result={status:outcomes.length===1?'read_completed':'unresolved',job_status:token(row.status),scope:{entry_start:date(row.entry_start),entry_end:date(row.entry_end),observation_end:date(row.observation_end)},baseline_outcomes:outcomes,displayed_names:(row.displayed_names||[]).map(token).filter(Boolean),stored_followup:(row.stored_followup||[]).slice(0,10).map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,redact(v)])))};
  if(outcomes.length===1&&outcomes[0].query_id){
   try{metadataGets++;const [m]=await bounded(()=>bigquery.job(outcomes[0].query_id,{location:'US'}).getMetadata({maxRetries:0}));result.provider_metadata={state:token(m.status?.state),failure:m.status?.errorResult?safeReadFailure({errors:[m.status.errorResult,...(m.status.errors||[])]},'diagnostic'):null};}
   catch(e){result.provider_metadata=failure(e);}
  }else result.provider_metadata={status:'not_read',reason:outcomes.length?'no_unique_retained_query_id':'baseline_outcome_not_retained'};
  return result;
 });
 const coverage=check('existing_followup_records',async()=>{
  const inventories=await Promise.all(DATASETS.map(dataset=>check('coverage_inventory/'+dataset,async()=>{
   const rows=await read(dataset,`SELECT table_name,column_name,data_type FROM \`${ident(project)}.${ident(dataset)}.INFORMATION_SCHEMA.COLUMNS\` WHERE REGEXP_CONTAINS(LOWER(table_name),r'coverage|follow_?up|observation|ingestion|collector_runs|history_progress|identity_snapshots') AND NOT REGEXP_CONTAINS(LOWER(table_name),r'email_observations|identity_order_links') ORDER BY table_name,ordinal_position LIMIT 501`,{},{},'104857600',501);
   const tables=new Map();for(const row of rows.slice(0,500)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.table_name||'')||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.column_name||''))continue;const cols=tables.get(row.table_name)||[];if(/^(STRING|BOOL|BOOLEAN|DATE|TIMESTAMP|DATETIME|TIME|INT64|INTEGER|FLOAT64|FLOAT|NUMERIC|BIGNUMERIC)$/.test(row.data_type||''))cols.push(row.column_name);tables.set(row.table_name,cols);}
   return {dataset,truncated:rows.length>500,tables:[...tables].map(([table,columns])=>({table,columns}))};
  })));
  const candidates=inventories.filter(i=>i.status==='read_completed').flatMap(i=>i.tables.map(t=>({...t,dataset:i.dataset}))).filter(t=>['history_progress','identity_snapshots'].includes(t.table)||!/(session|conversion|pixel|email|campaign|ads)/i.test(t.table)&&['start','end','status'].every(key=>fieldGroups[key].some(c=>t.columns.includes(c)))&&['source','store'].some(key=>fieldGroups[key].some(c=>t.columns.includes(c))));
  candidates.sort((a,b)=>Number(['history_progress','identity_snapshots'].includes(b.table))-Number(['history_progress','identity_snapshots'].includes(a.table))||Number(b.columns.some(c=>fieldGroups.evidence.includes(c)))-Number(a.columns.some(c=>fieldGroups.evidence.includes(c)))||a.dataset.localeCompare(b.dataset)||a.table.localeCompare(b.table));
  const records=await Promise.all(candidates.slice(0,6).map(t=>check('coverage_records/'+t.dataset+'/'+t.table,async()=>{
   let projection,where='',params={},types={};
   if(t.table==='history_progress'){
    projection=['source','adapter','revision','complete','updated_at'].filter(c=>t.columns.includes(c)).map(c=>'`'+c+'`');
    if(t.columns.includes('source')){where=" WHERE source IN ('ww','usd','shopify') AND revision IN ('history-20261020-v2','history-20261021-billing-v3')";}
   }else if(t.table==='identity_snapshots'){
    projection=['snapshot_id','state','start_date','end_date','mapping_count'].filter(c=>t.columns.includes(c)).map(c=>'`'+c+'`');where=' WHERE snapshot_id=@snapshot';params={snapshot:INCIDENT.snapshot};
   }else {projection=coverageProjection(t.columns);const source=t.columns.includes('source_store')?'source_store':t.columns.includes('source')?'source':t.columns.includes('source_platform')?'source_platform':t.columns.includes('store')?'store':'platform';where=" WHERE CAST(`"+source+"` AS STRING) IN ('woo','ww','usd','shopify')";}
   const rows=await read(t.dataset,`SELECT ${projection.join(',')} FROM ${fq(project,t.dataset,t.table)}${where} LIMIT 101`,params,types);
   return {dataset:t.dataset,table:t.table,truncated:rows.length>100,records:rows.slice(0,100).map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,redact(v)]))),certification:'not_inferred_from_record_presence'};
  })));
  return {status:inventories.every(i=>i.status==='unavailable')?'unavailable':inventories.some(i=>i.status==='unavailable'||i.truncated)||records.some(r=>r.status==='unavailable'||r.truncated)||candidates.length>6?'partial':'read_completed',inventories:inventories.map(i=>({dataset:i.dataset||i.check.split('/')[1],status:i.status,truncated:i.truncated,tables:i.tables?.map(t=>({table:t.table,columns:t.columns})),failure:i.failure})),records:records.map(r=>({check:r.check,status:r.status,dataset:r.dataset,table:r.table,truncated:r.truncated,records:r.records,failure:r.failure})),unread_candidates:candidates.slice(6).map(t=>({dataset:t.dataset,table:t.table})),limitation:'Bounded discovery in five named datasets. Other datasets, unread candidates, truncated or failed reads are unknown. Email collection, snapshot readiness and activity endpoints do not certify transaction coverage.'};
 });
 const reconciliations=Promise.all([['woo','ww'],['woo','usd'],['shopify','shopify']].map(([platform,store])=>check('absent_collections/'+store,async()=>{
  const params={collection_ids:INCIDENT.collections,diagnostic_store:store,source_prefix:platform+':'+store+':',cohort_entry_start:INCIDENT.start,cohort_entry_end:INCIDENT.end,observation_end:INCIDENT.end,time_zone:INCIDENT.zone,first_order_semantic:'first_observed_ever',entry_source:platform,entry_channel:null,entry_classification:'collaboration',entry_product_ref:null,matrixify_app_id:'gid://shopify/App/1758145'};
  const rows=await read('commerce',reconciliationSql(project,platform,store,journeySql,parseSql),params,{collection_ids:['STRING'],cohort_entry_start:'DATE',cohort_entry_end:'DATE',observation_end:'DATE',entry_channel:'STRING',entry_product_ref:'STRING'},'2500000000',11);
  if(rows.length>10||new Set(rows.map(r=>r.collection_id)).size!==rows.length)throw Error('Collection bound exceeded');
  const counts=['products','eligible_customers','historical_named_products','persisted_members','source_routes','historical_routed_products','unclassified_products','conflicting_products'];
  const results=rows.map(r=>{if(!INCIDENT.collections.includes(r.collection_id)||counts.some(k=>r[k]==null||!Number.isSafeInteger(Number(r[k]))||Number(r[k])<0))throw Error('Invalid reconciliation aggregate');return {collection_id:r.collection_id,display_name:String(r.display_name||'').slice(0,160),collaboration_name:token(r.collaboration_name),...Object.fromEntries(counts.map(k=>[k,Number(r[k])])),reason:reconciliationReason(r)};});
  return {status:results.length===10?'read_completed':'partial',source_platform:platform,source_store:store,results,unresolved_collection_ids:INCIDENT.collections.filter(id=>!results.some(r=>r.collection_id===id)),as_of:'current governed warehouse read; not purchase-time classifications or certified reconstruction of the retained report',truncation:'Positive eligible counts support omission/truncation investigation; they do not prove the historical omission cause if source or governance evidence changed.'};
 })));
 const [saved,,sourceChecks]=await Promise.all([retained,coverage,reconciliations]);
 for(const source of sourceChecks)for(const r of source.results||[]){r.retained_name_displayed=Array.isArray(saved.displayed_names)?saved.displayed_names.includes(r.collaboration_name):null;if(r.retained_name_displayed)r.reason='governed_name_already_in_retained_report';}
 return {read_only:true,report_replayed:false,request_id:INCIDENT.request,job_id:INCIDENT.job,deployed_revision:token(revision),scope:{entry_start:INCIDENT.start,entry_end:INCIDENT.end,observation_end:INCIDENT.end,time_zone:INCIDENT.zone,snapshot:INCIDENT.identityDataset+'/'+INCIDENT.snapshot},bounds:{deadline_ms:Math.min(45000,maximumMs),queries,maximum_queries:15,metadata_gets:metadataGets,maximum_billed_bytes_total:'9653433600',maximum_metadata_gets:7,maximum_query_ms:10000},checks};
}
