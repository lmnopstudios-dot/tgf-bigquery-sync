import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {BigQuery} from '@google-cloud/bigquery';
import {createBigQueryClient} from '../bigquery/client.js';
import {fq,SCOPE,options} from './collect.js';
import {read,setup as legacySetup} from './operations.js';
import {sourceClient,boundedFetch} from './runtime.js';
import {emailFields} from './historical-evidence.js';
import {emailState} from './email.js';
import {HISTORY_TABLES,HISTORY_SCOPE,historyRosterSql,historyCoverageSql,historyLinkCtes} from './history-sql.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const stamp=value=>{if(!value)return null;const text=String(value);const d=new Date(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)?text+'Z':text);return Number.isNaN(d.valueOf())?null:d.toISOString();};
const id=value=>value==null||String(value)==='0'||String(value)===''?null:String(value);
const profile=(source,cid)=>cid?`${source==='shopify'?'shopify':'woo'}:${source}:${cid}`:null;
export function observations({source,record,provider,orderId=null,profileKey=null,recordId,now=new Date().toISOString(),failure=null}){
  const observed=stamp(record?.updatedAt||record?.date_modified_gmt||record?.updated_at||record?.order_updated_at||record?.date_modified);
  const native=id(record?.customer_id),metorik=id(record?.metorik_customer_id||record?.customer?.metorik_customer_id);
  const values=failure?[{field:'availability',value:null,state:failure}]:emailFields(record);
  return values.map(f=>{
    if(f.value!=null&&(typeof f.value!=='string'||f.value.length>320))return {...f,value:null,state:'extraction_failure'};return f;
  }).map(f=>{
    const state=failure||(['omitted','invalid_type'].includes(f.state)?'extraction_failure':f.state);
    const row={source,order_id:orderId,profile_key:profileKey,provider,record_id:String(recordId),field_path:f.field,email:typeof f.value==='string'?f.value:null,
      normalized:emailState(f.value).normalized,email_state:state,native_customer_id:native,metorik_customer_id:metorik,observed_at:observed,retrieved_at:now};
    return {evidence_id:hash(JSON.stringify([source,orderId,profileKey,provider,recordId,f.field,row.email,state,observed])),...row};
  });
}
export async function setupHistory({bigquery,project,dataset}){
  // Reuse the existing ACL/location/schema gates; never provision implicitly.
  await legacySetup({bigquery,project,dataset});
  const ds=bigquery.dataset(dataset);
  for(const [name,fields] of Object.entries(HISTORY_TABLES)){
    const table=ds.table(name),[exists]=await table.exists();
    if(!exists)await ds.createTable(name,{schema:{fields}});
    else {const [m]=await table.getMetadata();if(fields.some(f=>!m.schema?.fields?.some(x=>x.name===f.name&&({BOOL:'BOOLEAN',INT64:'INTEGER'}[x.type]||x.type)===f.type)))throw Error('Incompatible history schema');}
  }
  return {status:'ready',tables:Object.keys(HISTORY_TABLES).length};
}
export function batchMergeSql(project,dataset,stages,jobKey,cursor,complete){
  const statements=[];
  for(const [name,stage] of Object.entries(stages)){
    const keys=name==='history_orders'?['source','order_id']:['evidence_id'];
    statements.push(`MERGE ${fq(project,dataset,name)} T USING ${fq(project,dataset,stage)} S ON ${keys.map(k=>`T.${k}=S.${k}`).join(' AND ')} ${name==='history_orders'?`WHEN MATCHED THEN UPDATE SET ${HISTORY_TABLES[name].filter(f=>!keys.includes(f.name)).map(f=>`${f.name}=${['financial_status','cancelled'].includes(f.name)?`COALESCE(S.${f.name},T.${f.name})`:`COALESCE(T.${f.name},S.${f.name})`}`).join(',')}`:''} WHEN NOT MATCHED THEN INSERT ROW;`);
  }
  return `BEGIN TRANSACTION; ASSERT COALESCE((SELECT cursor FROM ${fq(project,dataset,'history_progress')} WHERE job_key=@job),'')=@expected_cursor AS 'Concurrent progress changed'; ${statements.join('\n')}
    MERGE ${fq(project,dataset,'history_progress')} T USING (SELECT @job job_key,@source source,@adapter adapter,@revision revision,@cursor cursor,@complete complete,CURRENT_TIMESTAMP() updated_at) S ON T.job_key=S.job_key
    WHEN MATCHED THEN UPDATE SET cursor=S.cursor,complete=S.complete,updated_at=S.updated_at WHEN NOT MATCHED THEN INSERT ROW; COMMIT TRANSACTION;`;
}
export async function commitBatch({bigquery,project,dataset,jobKey,source,adapter,revision,cursor,expectedCursor='',complete,orders=[],evidence=[]}){
  if(orders.length>100||evidence.length>3000)throw Error('Batch row cap exceeded');
  orders=[...new Map(orders.map(r=>[r.source+'|'+r.order_id,{...r,created_at:stamp(r.created_at?.value||r.created_at)}])).values()];
  evidence=[...new Map(evidence.map(r=>[r.evidence_id,r])).values()];
  const ds=bigquery.dataset(dataset),dir=await mkdtemp(join(tmpdir(),'history-evidence-')),stages={};
  try{
    for(const [name,rows] of [['history_orders',orders],['email_observations',evidence]])if(rows.length){
      const stage=`_history_${randomUUID().replaceAll('-','')}`,table=ds.table(stage);stages[name]=stage;
      await ds.createTable(stage,{schema:{fields:HISTORY_TABLES[name]},expirationTime:Date.now()+3600000});
      const file=join(dir,name+'.ndjson');await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n'),{mode:0o600});
      await table.load(file,{schema:{fields:HISTORY_TABLES[name]},sourceFormat:'NEWLINE_DELIMITED_JSON',writeDisposition:'WRITE_TRUNCATE'});
    }
    await bigquery.query({query:batchMergeSql(project,dataset,stages),params:{job:jobKey,source,adapter,revision,cursor,expected_cursor:expectedCursor,complete},maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:20000});
  }finally{for(const stage of Object.values(stages))await ds.table(stage).delete({ignoreNotFound:true}).catch(()=>{});await rm(dir,{recursive:true,force:true});}
}
export async function nativeHistoryClient(source,env,signal,budget){
  const prefix=`WOO_${source==='ww'?'UK':'US'}`,base=env[prefix+'_URL'],key=env[prefix+'_CONSUMER_KEY'],secret=env[prefix+'_CONSUMER_SECRET'];
  if(!base||new URL(base).protocol!=='https:'||!key||!secret)throw Error('Missing native configuration');
  const request=boundedFetch(budget);
  return async path=>{
    const fields=path.startsWith('orders/')?'id,customer_id,currency,billing.email,date_created_gmt,date_modified_gmt':'id,email';
    const response=await request(`${base.replace(/\/$/,'')}/wp-json/wc/v3/${path}?_fields=${fields}`,{signal,redirect:'error',headers:{Authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,Accept:'application/json'}});
    if(response.status===404)return null;if(!response.ok)throw Error('Native request unavailable');return response.json();
  };
}
export function correspondence(order,roster){
  const oid=String(order?.order_id??order?.id??'');
  if(oid!==roster.order_id)return false;
  const date=stamp(order?.order_created_at||order?.created_at||order?.date_created_gmt||order?.createdAt||order?.date_created);
  const expected=stamp(roster.created_at?.value||roster.created_at);
  return !!date&&!!expected&&date===expected&&(!roster.currency||String(order.currency).toUpperCase()===roster.currency.toUpperCase());
}
export async function collectHistory({bigquery,project,o,adapter,batches=5,revision='history-20261020-v2',evidenceTable=null,env=process.env,commit=commitBatch,client=sourceClient,nativeClient=nativeHistoryClient,fetchImpl=fetch}){
  if(!['roster','retained','native','metorik_orders','metorik_customers','shopify','migration'].includes(adapter)||!Number.isInteger(batches)||batches<1||batches>1200)throw Error('Invalid collection bounds');
  if((adapter==='shopify')!==(o.source==='shopify')&&adapter!=='roster'&&adapter!=='retained'&&adapter!=='migration')throw Error('Adapter/source mismatch');
  if(['retained','migration'].includes(adapter)&&!/^\w+\.\w+$/.test(evidenceTable||''))throw Error('Explicit existing evidence table required');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(revision))throw Error('Invalid revision');
  const jobKey=hash(JSON.stringify([o.source,adapter,o.start,o.end,evidenceTable,revision]));
  const [progress]=await read(bigquery,`SELECT cursor,complete FROM ${fq(project,o.dataset,'history_progress')} WHERE job_key=@job LIMIT 2`,{job:jobKey});
  if(progress.length>1)throw Error('Duplicate progress');
  if(progress[0]?.complete)return {source:o.source,adapter,status:'complete',batches:0,records:0};
  if(adapter==='roster'){
    const [counts]=await read(bigquery,`WITH selected AS (${historyRosterSql(project,o.source)}) SELECT COUNT(*) orders FROM selected`,{start:o.start,end:o.end},{start:'DATE',end:'DATE'});
    if(!counts[0]||Number(counts[0].orders)>60000||Number(counts[0].orders)<1)throw Error('Roster bound/empty selection');
  }
  let cursor=progress[0]?.cursor||'',records=0,processed=0,complete=false;
  const deadline=Date.now()+600000,budget={requests:0,bytes:0,maxRequests:adapter==='native'?120000:2400,maxBytes:268435456};
  const signal=AbortSignal.timeout(600000);let transport;
  if(adapter==='native')transport=await nativeClient(o.source,env,signal,budget);
  if(adapter==='shopify')transport=await client('shopify',env,signal,budget);
  const fetchPage=boundedFetch(budget,fetchImpl);
  for(;processed<batches&&!complete;processed++){
    if(Date.now()>=deadline)break;
    let orders=[],evidence=[],next=cursor;
    if(adapter==='roster'){
      const [rows]=await read(bigquery,`WITH selected AS (${historyRosterSql(project,o.source)}) SELECT * FROM selected WHERE order_id>@cursor ORDER BY order_id LIMIT 101`,{start:o.start,end:o.end,cursor},{start:'DATE',end:'DATE'});
      orders=rows.slice(0,100);complete=rows.length<=100;next=orders.at(-1)?.order_id||cursor;
    }else if(adapter.startsWith('metorik_')){
      const page=Number(cursor||0)+1;if(page>1200)throw Error('Metorik historical cap exceeded');
      const resource=adapter==='metorik_orders'?'orders':'customers',key=env[`METORIK_${o.source==='ww'?'UK':'US'}_API_KEY`];if(!key)throw Error('Missing Metorik configuration');
      const url=new URL(`https://app.metorik.com/api/v1/store/${resource}`);url.searchParams.set('per_page','50');url.searchParams.set('page',String(page));
      const response=await fetchPage(url,{signal,redirect:'error',headers:{Accept:'application/json',Authorization:`Bearer ${key}`}});if(!response.ok)throw Error('Metorik unavailable');
      const body=await response.json(),rows=Array.isArray(body)?body:Array.isArray(body?.data)?body.data:body?.[resource],p=body?.pagination||body?.meta||body?.links;
      if(!Array.isArray(rows)||rows.length>50||!p||Number(p.current_page)!==page||Number(p.per_page)!==50||typeof p.has_more_pages!=='boolean'||(p.has_more_pages&&rows.length===0))throw Error('Metorik page contract failed');
      if(resource==='customers'){
        for(const r of rows){const mid=id(r.metorik_customer_id);if(!mid||!/^\d+$/.test(mid))throw Error('Invalid Metorik customer identity');
          evidence.push(...observations({source:o.source,record:r,provider:adapter,recordId:mid,profileKey:`metorik:${o.source}:${mid}`}));}
      }else{
        const ids=rows.map(r=>String(r.order_id??r.id));if(new Set(ids).size!==ids.length||ids.some(x=>!/^\d+$/.test(x)))throw Error('Invalid Metorik order identities');
        const [roster]=await read(bigquery,`SELECT * FROM ${fq(project,o.dataset,'history_orders')} WHERE source=@source AND order_id IN UNNEST(@ids)`,{source:o.source,ids},{ids:['STRING']});
        for(const r of rows){const oid=String(r.order_id??r.id),original=roster.find(x=>x.order_id===oid);if(!original)continue;
          if(!correspondence(r,original))throw Error('Metorik order correspondence failed');
          const mid=id(r.metorik_customer_id||r.customer?.metorik_customer_id),native=id(r.customer_id);
          const pk=native&&native===original.customer_id?profile(o.source,native):mid?`metorik:${o.source}:${mid}`:null;
          evidence.push(...observations({source:o.source,record:r,provider:adapter,recordId:oid,orderId:oid,profileKey:pk}));}
      }
      complete=!p.has_more_pages;next=String(page);records+=rows.length;
    }else if(['native','shopify'].includes(adapter)){
      const [selected]=await read(bigquery,`SELECT * FROM ${fq(project,o.dataset,'history_orders')} WHERE source=@source AND order_id>@cursor ORDER BY order_id LIMIT 51`,{source:o.source,cursor});
      const batch=selected.slice(0,50);complete=selected.length<=50;next=batch.at(-1)?.order_id||cursor;
      if(adapter==='shopify'&&batch.length){
        const data=await transport.graphql('query HistoryOrders($ids:[ID!]!){nodes(ids:$ids){... on Order{id email createdAt updatedAt displayFinancialStatus cancelledAt customer{id email}}}}',{ids:batch.map(r=>r.order_id)});
        if(!Array.isArray(data.nodes)||data.nodes.length!==batch.length)throw Error('Incomplete Shopify response');
        for(let i=0;i<batch.length;i++){
          const r=data.nodes[i],original=batch[i];if(r===null){evidence.push(...observations({source:o.source,provider:adapter,recordId:original.order_id,orderId:original.order_id,failure:'unavailable'}));continue;}
          if(!correspondence(r,original)||!Object.hasOwn(r,'customer')||!r.displayFinancialStatus)throw Error('Shopify correspondence/eligibility failed');
          const cid=id(r.customer?.id);orders.push({...original,customer_id:cid,financial_status:r.displayFinancialStatus.toLowerCase(),cancelled:r.cancelledAt!=null});
          evidence.push(...observations({source:o.source,record:r,provider:adapter,recordId:r.id,orderId:r.id,profileKey:profile(o.source,cid)}));
        }
      }else if(adapter==='native')for(const original of batch){
        const r=await transport(`orders/${original.order_id}`);
        if(r===null){evidence.push(...observations({source:o.source,provider:adapter,recordId:original.order_id,orderId:original.order_id,failure:'unavailable'}));continue;}
        if(!correspondence(r,original))throw Error('Native order correspondence failed');
        const cid=id(r.customer_id),pk=cid&&cid===original.customer_id?profile(o.source,cid):null;
        evidence.push(...observations({source:o.source,record:r,provider:adapter,recordId:r.id,orderId:original.order_id,profileKey:pk}));
        if(pk){const c=await transport(`customers/${cid}`);if(c&&String(c.id)!==cid)throw Error('Native customer mismatch');evidence.push(...observations({source:o.source,record:c,provider:'native_customer',recordId:cid,orderId:original.order_id,profileKey:pk,failure:c?null:'unavailable'}));}
      }
    }else{
      const [d,t]=evidenceTable.split('.');
      const oid=adapter==='migration'?"JSON_VALUE(TO_JSON_STRING(t),'$.source_order_id')":"COALESCE(JSON_VALUE(TO_JSON_STRING(t),'$.order_id'),JSON_VALUE(TO_JSON_STRING(t),'$.id'))";
      // Existing migration exports must explicitly carry original store/order IDs.
      const [rows]=await read(bigquery,`WITH retained AS (SELECT ${oid} order_id,TO_JSON_STRING(t) payload FROM ${fq(project,d,t)} t WHERE ${oid}>@cursor ${adapter==='migration'?"AND JSON_VALUE(TO_JSON_STRING(t),'$.source_store')=@source":''}) SELECT order_id,IF(BYTE_LENGTH(payload)<=2097152,payload,NULL) payload FROM retained ORDER BY order_id,payload LIMIT 101`,{cursor,...(adapter==='migration'?{source:o.source}:{})});
      // Never split duplicate order groups across a cursor boundary.
      let batch=rows.length>100?rows.filter(r=>r.order_id!==rows.at(-1).order_id):rows;
      if(rows.length>100&&!batch.length)throw Error('Retained duplicate group exceeds bound');
      const ids=[...new Set(batch.map(r=>r.order_id))];
      const [roster]=ids.length?await read(bigquery,`SELECT * FROM ${fq(project,o.dataset,'history_orders')} WHERE source=@source AND order_id IN UNNEST(@ids)`,{source:o.source,ids},{ids:['STRING']}):[[]];
      for(const row of batch){if(typeof row.payload!=='string')throw Error('Retained payload bound');budget.bytes+=Buffer.byteLength(row.payload);if(Buffer.byteLength(row.payload)>2097152||budget.bytes>budget.maxBytes)throw Error('Retained payload bound');const original=roster.find(r=>r.order_id===row.order_id);if(!original)continue;
        const parsed=JSON.parse(row.payload),raw=parsed.raw_json?typeof parsed.raw_json==='string'?JSON.parse(parsed.raw_json):parsed.raw_json:null;
        const corresponding=adapter==='migration'?{id:parsed.source_order_id,date_created_gmt:parsed.source_order_created_at,currency:parsed.currency}:raw||parsed;
        if(!correspondence(corresponding,original))throw Error('Retained order correspondence failed');
        for(const [field,r] of [['row',parsed],['raw_json',raw]])if(r)evidence.push(...observations({source:o.source,record:r,provider:`${adapter}:${evidenceTable}:${field}`,recordId:row.order_id,orderId:row.order_id,profileKey:profile(o.source,original.customer_id)}));
      }
      next=batch.at(-1)?.order_id||cursor;complete=rows.length<=100;
    }
    if(adapter==='roster')records+=orders.length;else if(!adapter.startsWith('metorik_'))records+=new Set(evidence.map(r=>r.order_id)).size;
    await commit({bigquery,project,dataset:o.dataset,jobKey,source:o.source,adapter,revision,expectedCursor:cursor,cursor:next,complete,orders,evidence});cursor=next;
  }
  return {source:o.source,adapter,status:complete?'complete':'resumable',batches:processed,records,requests:budget.requests,bytes:budget.bytes};
}

export async function publishHistory({bigquery,project,dataset,snapshot,revision='history-20261020-v2'}){
  const t=name=>fq(project,dataset,name);
  const query=`BEGIN TRANSACTION;
    ASSERT NOT EXISTS(SELECT 1 FROM ${t('identity_snapshots')} WHERE snapshot_id=@snapshot) AS 'Immutable snapshot exists';
    ASSERT (SELECT COUNT(DISTINCT source) FROM ${t('history_orders')})=3 AS 'Three roster sources required';
    ASSERT (SELECT COUNT(DISTINCT source) FROM ${t('history_progress')} WHERE revision=@revision AND adapter='roster' AND complete)=3 AS 'Three complete rosters required';
    ASSERT EXISTS(SELECT 1 FROM ${t('history_progress')} WHERE revision=@revision AND source='shopify' AND adapter='shopify' AND complete) AS 'Shopify collection incomplete';
    ASSERT (SELECT COUNT(DISTINCT source) FROM ${t('history_progress')} WHERE revision=@revision AND source IN ('ww','usd') AND adapter IN ('native','retained','metorik_orders','migration') AND complete)=2 AS 'Each Woo source needs a completed order-evidence adapter';
    ${['ww','usd','shopify'].map(source=>`ASSERT NOT EXISTS(SELECT order_id FROM (${historyRosterSql(project,source)}) EXCEPT DISTINCT SELECT order_id FROM ${t('history_orders')} WHERE source='${source}') AS 'Canonical roster missing';`).join('\n')}
    ASSERT NOT EXISTS(SELECT 1 FROM ${t('history_orders')} GROUP BY source,order_id HAVING COUNT(*)>1) AS 'Duplicate original orders';
    INSERT INTO ${t('identity_order_links')} WITH ${historyLinkCtes(project,dataset)}
      SELECT @snapshot,source,order_id,customer_id,canonical_customer_ref,resolution,financial_status,cancelled,conflicting_email,shared_email FROM h_resolved;
    ASSERT (SELECT COUNTIF(resolution='matched') FROM ${t('identity_order_links')} WHERE snapshot_id=@snapshot)>0 AS 'No supported cross-source matches';
    INSERT INTO ${t('identity_snapshots')} SELECT @snapshot,'ready',@start,@end,COUNT(*),CURRENT_TIMESTAMP() FROM ${t('identity_order_links')} WHERE snapshot_id=@snapshot;
    COMMIT TRANSACTION;`;
  await bigquery.query({query,params:{snapshot,revision,start:BigQuery.date(HISTORY_SCOPE.start),end:BigQuery.date(HISTORY_SCOPE.end)},types:{start:'DATE',end:'DATE'},maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:20000});
  return {status:'published',snapshot,mode:'email_candidate_v2'};
}
export async function main(argv=process.argv.slice(2),env=process.env){
  const [command,...args]=argv,extra={};
  const base=args.filter(a=>{const m=/^--(adapter|batches|evidence-table|snapshot|revision|start|end)=(.+)$/.exec(a);if(!m)return true;extra[m[1]]=m[2];return false;});
  if(!base.some(a=>a.startsWith('--source=')))base.push('--source=ww');
  if(base.some(a=>a.startsWith('--max-orders=')))throw Error('History roster has a fixed 60000-order source cap');
  const o={...options(base),start:extra.start||HISTORY_SCOPE.start,end:extra.end||HISTORY_SCOPE.end};
  for(const value of [o.start,o.end])if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('Invalid history dates');
  if(o.start<HISTORY_SCOPE.start||o.start>o.end||o.end>HISTORY_SCOPE.end)throw Error('History dates outside bound');
  if(!['plan','setup','collect','preview','status','check','publish'].includes(command)||o.apply!==['setup','collect','publish'].includes(command))throw Error('Writes require --apply; reads reject it');
  const {bigquery,project}=createBigQueryClient(env);
  if(command==='plan'){const [rows]=await read(bigquery,`WITH selected AS (${historyRosterSql(project,o.source)}) SELECT COUNT(*) orders FROM selected`,{start:o.start,end:o.end},{start:'DATE',end:'DATE'});const n=Number(rows[0]?.orders),valid=Number.isSafeInteger(n)&&n>0&&n<=60000;if(!valid)process.exitCode=2;return {read_only:true,source:o.source,orders:n,within_bound:valid};}
  if(command==='setup')return setupHistory({bigquery,project,dataset:o.dataset});
  if(command==='collect')return collectHistory({bigquery,project,o,adapter:extra.adapter,batches:Number(extra.batches||5),revision:extra.revision,evidenceTable:extra['evidence-table'],env});
  if(command==='status'){const [jobs]=await read(bigquery,`SELECT source,adapter,revision,COUNT(*) jobs,COUNTIF(complete) completed_jobs FROM ${fq(project,o.dataset,'history_progress')} GROUP BY source,adapter,revision ORDER BY source,adapter,revision`);return {read_only:true,jobs};}
  if(command==='preview'){
    const [sources]=await read(bigquery,historyCoverageSql(project,o.dataset));
    const [evidence]=await read(bigquery,`SELECT source,provider,email_state,COUNT(*) observations FROM ${fq(project,o.dataset,'email_observations')} GROUP BY source,provider,email_state ORDER BY source,provider,email_state LIMIT 501`);
    if(evidence.length>500)throw Error('Coverage output bound');
    return {read_only:true,sources,evidence};
  }
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(extra.snapshot||''))throw Error('Snapshot required');
  if(command==='check'){
    const {createCustomerJourneyService}=await import('../oracle/customer-journey.js');
    const service=createCustomerJourneyService({bigquery,project,env:{...env,ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:o.dataset,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:extra.snapshot}});
    const result=await service.analyzeCustomerJourney({start_date:o.start,end_date:o.end,group_by:['summary']},{timeoutMs:20000,decompose:false});
    const valid=result.identity_evidence?.activation==='active';if(!valid)process.exitCode=2;
    return {read_only:true,valid,identity_evidence:result.identity_evidence,cohort:result.cohort};
  }
  return publishHistory({bigquery,project,dataset:o.dataset,snapshot:extra.snapshot,revision:extra.revision});
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(JSON.stringify({status:'failed',message:'History operation stopped; resume the same bounded command after resolving access or correspondence. No customer values logged.',failure_category:/correspondence|identity|contract|pagination/.test(error.message)?'source_contract':/bound|cap|deadline/.test(error.message)?'bound':/configuration/.test(error.message)?'configuration':'access_or_storage'}));process.exitCode=2;});
