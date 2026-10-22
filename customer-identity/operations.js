import {publicationGuardSql} from './publication-guard.js';
import {randomUUID} from 'node:crypto';
import {BigQuery} from '@google-cloud/bigquery';
import {SOURCES,SCOPE,SCHEMA,fq,selectionSql,retrieve,store} from './collect.js';
import {mappingSql} from './linkage.js';
import {sourceClient,requestBudget} from './runtime.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';

const canonicalType=value=>({INT64:'INTEGER',BOOL:'BOOLEAN',FLOAT64:'FLOAT',STRUCT:'RECORD'}[value]||value);
export const TABLES = {
  order_identity:SCHEMA,
  enrichment_runs:[['run_id','STRING'],['source','STRING'],['start_date','DATE'],['end_date','DATE'],['requested','INT64'],['returned','INT64'],['status','STRING'],['completed_at','TIMESTAMP']].map(([name,type])=>({name,type})),
  identity_links:[['snapshot_id','STRING'],['source_store','STRING'],['source_customer_id','STRING'],['canonical_customer_ref','STRING']].map(([name,type])=>({name,type})),
  identity_snapshots:[['snapshot_id','STRING'],['state','STRING'],['start_date','DATE'],['end_date','DATE'],['mapping_count','INT64'],['created_at','TIMESTAMP']].map(([name,type])=>({name,type})),
};
// The SDK reads .value for explicitly typed DATE parameters. Plain strings
// silently serialize without a value (SQL NULL), even with types supplied.
export const typedParams = (params,types) => Object.fromEntries(Object.entries(params).map(([key,value])=>
  [key,types[key]==='DATE' && typeof value==='string' ? BigQuery.date(value) : value]));
export const read = async (bigquery,query,params={},types={},maximumMs=20000) => {
  const result=await boundedQuery(bigquery,{query,params:typedParams(params,types),types,maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:maximumMs},{maximumMs});
  if(!Array.isArray(result?.[0]) || typeof bigquery.createQueryJob==='function' && result[2]?.jobComplete!==true)throw Object.assign(Error('Invalid warehouse result envelope'),{code:'INVALID_QUERY_RESULT'});
  const total=result[2]?.totalRows;
  if(total!=null && (!/^\d+$/.test(String(total)) || BigInt(total)!==BigInt(result[0].length)))throw Object.assign(Error('Incomplete warehouse results'),{code:'INVALID_QUERY_RESULT'});
  return result;
};
export async function selectedIds(bigquery,project,o) {
  const [rows] = await read(bigquery,selectionSql(project,o),{start:o.start,end:o.end},{start:'DATE',end:'DATE'});
  if (rows.length > o.maxOrders) throw Error('Selection exceeds cap; narrow window or increase within proposed bound');
  if(rows.some(row=>typeof row?.order_id!=='string'||!row.order_id)||new Set(rows.map(row=>row.order_id)).size!==rows.length)throw Object.assign(Error('Invalid selection rows'),{code:'INVALID_SELECTION_RESULT'});
  return rows.map(row=>row.order_id);
}
export async function destinationReadiness(bigquery,project,dataset) {
  const ds = bigquery.dataset(dataset,{projectId:project}), [exists] = await ds.exists();
  if (!exists) return {exists:false,ready:false,setup_required:true};
  const [metadata] = await ds.getMetadata();
  const publicAccess = (metadata.access || []).some(entry=>['allUsers','allAuthenticatedUsers','projectReaders','projectWriters'].includes(entry.specialGroup));
  const tables = {};
  for (const [name,schema] of Object.entries(TABLES)) {
    const table = ds.table(name), [present] = await table.exists();
    if (!present) {tables[name]={exists:false}; continue;}
    const [m] = await table.getMetadata();
    const fields = new Map((m.schema?.fields || []).map(f=>[f.name,f.type]));
    const compatible = schema.every(f=>canonicalType(fields.get(f.name))===canonicalType(f.type));
    const permissions = ['bigquery.tables.getData','bigquery.tables.updateData'];
    const [granted] = await table.testIamPermissions(permissions);
    tables[name] = {exists:true,compatible,read:(granted.permissions||[]).includes('bigquery.tables.getData'),write:(granted.permissions||[]).includes('bigquery.tables.updateData')};
  }
  return {exists:true,location:metadata.location,public_access_detected:publicAccess,tables,
    ready:!publicAccess && Object.values(tables).every(t=>t.exists&&t.compatible&&t.read&&t.write),
    setup_required:Object.values(tables).some(t=>!t.exists)};
}
export async function provision({bigquery,project,dataset,principal}) {
  if(!/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(principal||''))throw Error('Configured service account principal required');
  const [exists]=await bigquery.dataset(dataset).exists();
  if(exists)throw Error('Dataset exists; inspect its access before setup');
  const locations=[];
  for(const source of Object.values(SOURCES)){const [m]=await bigquery.dataset(source.dataset).getMetadata();locations.push(m.location);}
  if(new Set(locations).size!==1||!locations[0])throw Error('Source locations differ');
  await bigquery.createDataset(dataset,{location:locations[0],access:[{role:'OWNER',userByEmail:principal}],defaultTableExpirationMs:'31536000000'});
  return {provisioned:true,dataset,location:locations[0],retention_days:365,explicit_access:'configured_service_account_only',inherited_project_iam_requires_review:true};
}
export function relationshipSql(project,o) {
  return `WITH parent AS (SELECT DISTINCT order_id FROM ${fq(project,'shopify_data','order_locations')} WHERE DATE(created_at) BETWEEN @start AND @end),
    customers AS (SELECT order_id,COUNT(*) row_count,COUNTIF(customer_id IS NOT NULL AND NOT STARTS_WITH(customer_id,'gid://shopify/Customer/')) invalid_customer_ids FROM ${fq(project,'shopify_data','order_customers')} GROUP BY order_id)
    SELECT COUNT(*) parent_orders,COUNTIF(c.order_id IS NULL) missing_relationship_rows,
      COUNTIF(c.row_count>1) duplicate_relationship_orders,COALESCE(SUM(c.invalid_customer_ids),0) invalid_customer_ids
    FROM parent p LEFT JOIN customers c USING(order_id)`;
}
export async function setup({bigquery,project,dataset}) {
  const ds = bigquery.dataset(dataset), [exists] = await ds.exists();
  if (!exists) throw Error('Restricted dataset must be provisioned explicitly with reviewed IAM');
  const [meta] = await ds.getMetadata();
  if ((meta.access||[]).some(e=>['allUsers','allAuthenticatedUsers','projectReaders','projectWriters'].includes(e.specialGroup))) throw Error('Destination access requires restriction');
  for (const [name,schema] of Object.entries(TABLES)) {
    const table = ds.table(name), [present] = await table.exists();
    if (!present) await ds.createTable(name,{schema});
    else {
      const [m] = await table.getMetadata();
      if (!schema.every(f=>(m.schema?.fields||[]).some(x=>x.name===f.name&&canonicalType(x.type)===canonicalType(f.type)))) throw Error('Existing identity schema is incompatible');
    }
  }
  return {schema_ready:true,tables:Object.keys(TABLES)};
}
export async function preflight({bigquery,project,o,env=process.env,client=sourceClient,sourceOnly=false}) {
  const source=SOURCES[o.source];
  const result={read_only:true,source:o.source,scope:{start:o.start,end:o.end,max_orders:o.maxOrders},
    bindings:{project,source_table:fq(project,source.dataset,source.table),date_field:source.date,
      date_type:null,source_location:null,destination_dataset:`${project}.${o.dataset}`,selection_sql:selectionSql(project,o),
      ...(o.source==='shopify'?{relationship_parent_table:fq(project,source.dataset,'order_locations'),relationship_date_field:'created_at',relationship_date_type:null,relationship_sql:relationshipSql(project,o)}:{}),
      date_parameters:{start:{type:'DATE',value:o.start},end:{type:'DATE',value:o.end}}},
    stages:{source_metadata:{state:'attempted'},warehouse_selection:{state:'skipped'},
      relationship:{state:'skipped',reason:o.source==='shopify'?'selection_pending':'not_shopify'},
      source_email:{state:'skipped',reason:'selection_pending'},destination:{state:'skipped',reason:sourceOnly?'source_only':'pending'}},
    selected_orders:null,sample_orders:null,email_query_succeeded:false,source_access:'unverified'};
  const stages=result.stages;
  try {
    const ds=bigquery.dataset(source.dataset,{projectId:project});
    const [[meta],[table],parent]=await boundedEvidenceRead(()=>Promise.all([ds.getMetadata(),ds.table(source.table).getMetadata(),
      ...(o.source==='shopify'?[ds.table('order_locations').getMetadata()]:[])]),{maximumMs:10000});
    result.bindings.source_location=meta.location||null;
    result.bindings.date_type=table.schema?.fields?.find(f=>f.name===source.date)?.type||null;
    if(!['DATE','DATETIME','TIMESTAMP'].includes(result.bindings.date_type))throw Object.assign(Error('Source date type unavailable or unsupported'),{code:'INVALID_SOURCE_SCHEMA'});
    if(parent){
      result.bindings.relationship_date_type=parent[0].schema?.fields?.find(f=>f.name==='created_at')?.type||null;
      if(!['DATE','DATETIME','TIMESTAMP'].includes(result.bindings.relationship_date_type))throw Object.assign(Error('Relationship date type unavailable or unsupported'),{code:'INVALID_SOURCE_SCHEMA'});
    }
    stages.source_metadata={state:'succeeded'};
  } catch(error) {stages.source_metadata={state:'failed',failure:safeReadFailure(error,'diagnostic')};}
  if(!sourceOnly){
    stages.destination={state:'attempted'};
    try {result.destination=await boundedEvidenceRead(()=>destinationReadiness(bigquery,project,o.dataset),{maximumMs:10000});stages.destination={state:'succeeded'};}
    catch(error) {result.destination={ready:false,state:'unavailable',failure:safeReadFailure(error,'diagnostic')};stages.destination={state:'failed',failure:result.destination.failure};}
  }
  let ids;
  stages.warehouse_selection={state:'attempted'};
  try {ids=await selectedIds(bigquery,project,o);result.selected_orders=ids.length;stages.warehouse_selection={state:'succeeded'};}
  catch(error) {
    stages.warehouse_selection={state:'failed',failure:safeReadFailure(error,'diagnostic')};
    stages.source_email={state:'skipped',reason:'selection_failed'};
    if(o.source==='shopify')stages.relationship={state:'skipped',reason:'selection_failed'};
    return {...result,source_access:'unverified',failure_stage:'warehouse_selection',failure:stages.warehouse_selection.failure};
  }
  if(o.source==='shopify'){
    stages.relationship={state:'attempted'};
    try {
      const [rows]=await read(bigquery,relationshipSql(project,o),{start:o.start,end:o.end},{start:'DATE',end:'DATE'});
      const fields=['parent_orders','missing_relationship_rows','duplicate_relationship_orders','invalid_customer_ids'];
      if(rows.length!==1||fields.some(k=>rows[0]?.[k]==null||!Number.isSafeInteger(Number(rows[0][k]))||Number(rows[0][k])<0))throw Object.assign(Error('Invalid relationship result'),{code:'INVALID_QUERY_RESULT'});
      result.order_customer_relationship=Object.fromEntries(fields.map(k=>[k,Number(rows[0][k])]));
      stages.relationship={state:'succeeded'};
    } catch(error){result.order_customer_relationship={state:'unavailable',failure:safeReadFailure(error,'diagnostic')};stages.relationship={state:'failed',failure:result.order_customer_relationship.failure};}
  }
  const sample=ids.slice(0,3);
  if(!sample.length){
    stages.source_email={state:'skipped',reason:'empty_selection'};
    result.source_access='unverified_empty_selection';
  } else {
    stages.source_email={state:'attempted'};
    try {
      const transport=await client(o.source,env,AbortSignal.timeout(90000),requestBudget(o.source,true));
      let scopes=null;
      if(transport.graphql){
        const data=await transport.graphql('{currentAppInstallation{accessScopes{handle}}}',{});
        const handles=new Set(data?.currentAppInstallation?.accessScopes?.map(s=>s.handle)||[]);
        scopes={read_orders:handles.has('read_orders'),read_all_orders:handles.has('read_all_orders'),read_customers:handles.has('read_customers')};
      }
      const rows=await retrieve({source:o.source,ids:sample,...transport});
      Object.assign(result,{sample_orders:rows.length,email_query_succeeded:true,
        usable_order_emails:rows.filter(r=>r.order_email_normalized).length,
        usable_customer_emails:rows.filter(r=>r.customer_email_normalized).length,source_access:'sampled',scopes});
      stages.source_email={state:'succeeded'};
    } catch(error) {Object.assign(result,{source_access:'unavailable',failure_stage:'source_email',failure:safeReadFailure(error,'diagnostic')});stages.source_email={state:'failed',failure:result.failure};}
  }
  result.location_matches=result.destination?.location&&result.bindings.source_location ? result.destination.location===result.bindings.source_location : null;
  return {...result,limitation:'Null-only responses do not establish usable email coverage; sampled access does not certify all historical orders.'};
}

export async function enrich({bigquery,project,o,env=process.env,client=sourceClient}) {
  const readiness = await destinationReadiness(bigquery,project,o.dataset);
  if (!readiness.ready) throw Error('Destination is not ready');
  if(o.source==='shopify'){
    const [rows]=await read(bigquery,relationshipSql(project,o),{start:o.start,end:o.end},{start:'DATE',end:'DATE'});
    if(!rows[0]||['missing_relationship_rows','duplicate_relationship_orders','invalid_customer_ids'].some(k=>Number(rows[0][k])!==0))throw Error('Repair Shopify order to customer relationships before enrichment');
  }
  const ids = await selectedIds(bigquery,project,o), runId = randomUUID();
  await bigquery.query({query:`INSERT INTO ${fq(project,o.dataset,'enrichment_runs')} VALUES(@id,@source,@start,@end,@requested,0,'running',CURRENT_TIMESTAMP())`,params:{id:runId,source:o.source,start:BigQuery.date(o.start),end:BigQuery.date(o.end),requested:ids.length},types:{start:'DATE',end:'DATE'},maximumBytesBilled:SCOPE.mergeBytes,jobTimeoutMs:20000});
  let returned = 0;
  const deadline = Date.now()+SCOPE.maxMs;
  const budget=requestBudget(o.source);
  try {
    for (let i=0; i<ids.length; i+=SCOPE.batchSize) {
      if (Date.now()>=deadline) throw Error('Historical operation deadline');
      const transport = await client(o.source,env,AbortSignal.timeout(Math.min(90000,deadline-Date.now())),budget);
      const rows = await retrieve({source:o.source,ids:ids.slice(i,i+SCOPE.batchSize),...transport});
      await store({bigquery,project,dataset:o.dataset,rows});
      returned += rows.length;
    }
    await bigquery.query({query:`UPDATE ${fq(project,o.dataset,'enrichment_runs')} SET status='complete',returned=@returned,completed_at=CURRENT_TIMESTAMP() WHERE run_id=@id`,params:{id:runId,returned},maximumBytesBilled:SCOPE.mergeBytes,jobTimeoutMs:20000});
    return {source:o.source,status:'complete',requested:ids.length,returned};
  } catch {
    await bigquery.query({query:`UPDATE ${fq(project,o.dataset,'enrichment_runs')} SET status='failed',returned=@returned,completed_at=CURRENT_TIMESTAMP() WHERE run_id=@id`,params:{id:runId,returned},maximumBytesBilled:SCOPE.mergeBytes,jobTimeoutMs:20000}).catch(()=>{});
    throw Error('Historical enrichment incomplete; repeat the bounded window before publishing');
  }
}
export function verificationSql(project,o) {
  const selection = selectionSql(project,o);
  return `WITH selected AS (${selection}), identity_rows AS (
    SELECT * FROM ${fq(project,o.dataset,'order_identity')} WHERE source=@source
  ) SELECT (SELECT COUNT(*) FROM selected) selected_orders,
    COUNTIF(i.order_id IS NOT NULL) enriched_orders,
    COUNTIF(i.order_id IS NULL) missing_orders,
    COUNTIF(i.order_id IS NOT NULL AND i.customer_id IS NULL) guest_orders,
    COUNTIF(i.email_state='candidate') candidate_email_orders,
    COUNTIF(i.email_state='conflict') conflicting_email_orders,
    COUNTIF(i.email_state IN ('missing','malformed','placeholder')) unusable_email_orders,
    COUNT(*)-COUNT(DISTINCT s.order_id) duplicate_identity_rows
    FROM selected s LEFT JOIN identity_rows i USING(order_id)`;
}
export async function verify({bigquery,project,o}) {
  const [rows] = await read(bigquery,verificationSql(project,o),{source:o.source,start:o.start,end:o.end},{source:'STRING',start:'DATE',end:'DATE'});
  const r = rows[0];
  const valid = r && Number(r.selected_orders)<=o.maxOrders && Number(r.missing_orders)===0 && Number(r.duplicate_identity_rows)===0;
  return {read_only:true,source:o.source,valid,counts:r};
}
export async function publish({bigquery,project,dataset,snapshot}) {
  // Exact full proposed window and all three sources are required for publication.
  const o = {start:SCOPE.start,end:SCOPE.end,maxOrders:SCOPE.maxOrders,dataset};
  for (const source of Object.keys(SOURCES)) {
    const result = await verify({bigquery,project,o:{...o,source}});
    if (!result.valid || Number(result.counts.selected_orders)===0) throw Error('Complete nonempty proposed source coverage required');
  }
  const query = `BEGIN TRANSACTION;
    ${publicationGuardSql(project,dataset)}
    ASSERT NOT EXISTS(SELECT 1 FROM ${fq(project,dataset,'identity_snapshots')} WHERE snapshot_id=@snapshot) AS 'Immutable snapshot already exists';
    ASSERT NOT EXISTS(SELECT 1 FROM ${fq(project,dataset,'identity_links')} WHERE snapshot_id=@snapshot) AS 'Orphan snapshot links exist';
    ASSERT (SELECT COUNT(DISTINCT source) FROM ${fq(project,dataset,'enrichment_runs')} WHERE status='complete' AND start_date=@start AND end_date=@end AND requested=returned)=3 AS 'Three complete source runs required';
    ASSERT NOT EXISTS(
      SELECT 1 FROM ${fq(project,dataset,'enrichment_runs')} r LEFT JOIN (
        SELECT source,MAX(completed_at) latest_complete FROM ${fq(project,dataset,'enrichment_runs')}
        WHERE status='complete' AND start_date=@start AND end_date=@end GROUP BY source
      ) c USING(source)
      WHERE r.start_date=@start AND r.end_date=@end AND r.status!='complete'
      AND r.completed_at>=COALESCE(c.latest_complete,TIMESTAMP '1970-01-01')
    ) AS 'Incomplete later run blocks publication';
    INSERT INTO ${fq(project,dataset,'identity_links')}
      SELECT @snapshot,source_store,source_customer_id,canonical_customer_ref FROM (${mappingSql(project,dataset)});
    ASSERT (SELECT COUNT(*) FROM ${fq(project,dataset,'identity_links')} WHERE snapshot_id=@snapshot)>0 AS 'No candidate links';
    INSERT INTO ${fq(project,dataset,'identity_snapshots')}
      SELECT @snapshot,'ready',@start,@end,COUNT(*),CURRENT_TIMESTAMP() FROM ${fq(project,dataset,'identity_links')} WHERE snapshot_id=@snapshot;
    COMMIT TRANSACTION;`;
  await bigquery.query({query,params:{snapshot,start:BigQuery.date(SCOPE.start),end:BigQuery.date(SCOPE.end)},types:{start:'DATE',end:'DATE'},maximumBytesBilled:SCOPE.mergeBytes,jobTimeoutMs:20000});
  return {published:true,snapshot,mode:'email_candidate_v1'};
}

export async function verifyLinkage({bigquery,project,dataset}) {
  const [rows]=await read(bigquery,`WITH candidates AS (${mappingSql(project,dataset)})
    SELECT source_store,COUNT(*) mapped_profiles,COUNT(DISTINCT canonical_customer_ref) linked_histories
    FROM candidates GROUP BY source_store`);
  return {read_only:true,mode:'analytical_email_candidates',sources:rows};
}
export async function activationCheck({bigquery,project,dataset,snapshot,env=process.env}) {
  const {createCustomerJourneyService}=await import('../oracle/customer-journey.js');
  // Bound the ordinary shared path without changing its SQL, filters or bindings.
  const bounded={query:settings=>bigquery.query({...settings,maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:20000})};
  if(bigquery.createQueryJob)bounded.createQueryJob=settings=>bigquery.createQueryJob({...settings,maximumBytesBilled:settings.maximumBytesBilled==='10000000'?'10000000':SCOPE.bytes,jobTimeoutMs:Math.min(settings.jobTimeoutMs||20000,20000)});
  const service=createCustomerJourneyService({bigquery:bounded,project,env:{...env,
    ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v1',ORACLE_CUSTOMER_IDENTITY_DATASET:dataset,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:snapshot}});
  const result=await service.analyzeCustomerJourney({start_date:SCOPE.start,end_date:SCOPE.end,group_by:['summary']},{timeoutMs:20000,decompose:false});
  return {read_only:true,valid:result.identity_evidence?.activation==='active',identity_evidence:result.identity_evidence||null,cohort:result.cohort};
}
