import crypto from 'node:crypto';

export const JOB_SCHEMA = [
  {name:'job_id',type:'STRING',mode:'REQUIRED'}, {name:'owner_key',type:'STRING',mode:'REQUIRED'},
  {name:'request_id',type:'STRING',mode:'REQUIRED'}, {name:'status',type:'STRING',mode:'REQUIRED'},
  {name:'payload_json',type:'JSON',mode:'REQUIRED'}, {name:'result_json',type:'JSON'},
  {name:'error_code',type:'STRING'}, {name:'created_at',type:'TIMESTAMP',mode:'REQUIRED'},
  {name:'updated_at',type:'TIMESTAMP',mode:'REQUIRED'}, {name:'lease_until',type:'TIMESTAMP'},
  {name:'attempts',type:'INT64',mode:'REQUIRED'}, {name:'cancel_requested',type:'BOOL',mode:'REQUIRED'}
];

export const ORACLE_JOB_DEFAULTS = Object.freeze({dataset:'commerce',table:'oracle_analysis_jobs_v1',location:'EU'});
export const SCHEMA_DIFF_LIMIT = 20;
const ORACLE_OWNERSHIP_COLUMNS = ['job_id','owner_key','request_id','status','payload_json','created_at','updated_at'];
const BIGQUERY_TYPE_ALIASES = Object.freeze({
  BOOLEAN:'BOOL', INTEGER:'INT64', FLOAT:'FLOAT64', DECIMAL:'NUMERIC',
  BIGDECIMAL:'BIGNUMERIC', RECORD:'STRUCT'
});
const normalizedType = type => {
  const upper=String(type||'').toUpperCase();
  return BIGQUERY_TYPE_ALIASES[upper]||upper;
};
const signature = field => `${normalizedType(field.type)}:${String(field.mode||'NULLABLE').toUpperCase()}`;

const safeToken=(value,fallback='unknown')=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(value||''))?String(value):fallback;
const QUERY_MESSAGE_LIMIT=300;
export function bigQueryErrorDiagnostic(error) {
  const outer=Array.isArray(error?.errors)?error.errors[0]:null;
  const detail=Array.isArray(outer?.errors)?outer.errors[0]:outer;
  // Only BigQuery's structured error detail is eligible for output. Generic
  // application errors can contain prompts, credentials, or row values.
  const raw=String(detail?.message||'');
  const message=raw.replace(/`[^`]*`|'[^']*'|"[^"]*"/g,'[redacted]').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,QUERY_MESSAGE_LIMIT);
  return {
    reason:safeToken(detail?.reason||error?.reason||error?.code),
    ...(message?{message}:{}),
    ...(safeToken(detail?.location||error?.location,'')?{location:safeToken(detail?.location||error?.location)}:{})
  };
}
/** BigQuery PartialFailureError contains the rejected row. Never return or log it. */
export function streamingInsertDiagnostic(error) {
  const failure=Array.isArray(error?.errors)?error.errors[0]:null;
  const detail=Array.isArray(failure?.errors)?failure.errors[0]:failure;
  const message=String(detail?.message||'');
  const knownField=JOB_SCHEMA.map(field=>field.name).find(name=>new RegExp(`(?:field|column|name)[^A-Za-z0-9_]+${name}(?:[^A-Za-z0-9_]|$)`,'i').test(message));
  return {
    error_class:error?.name==='PartialFailureError'?'PartialFailureError':safeToken(error?.name,'Error'),
    reason:safeToken(detail?.reason||error?.reason),
    code:safeToken(detail?.code||error?.code),
    field:knownField||'unknown'
  };
}

/** Compares metadata only. The returned, bounded diagnostic can never contain row values. */
export function inspectJobTableSchema(fields=[],expected=JOB_SCHEMA,limit=SCHEMA_DIFF_LIMIT) {
  const actualByName=new Map(fields.map(field=>[field.name,field]));
  const expectedByName=new Map(expected.map(field=>[field.name,field]));
  const missing_columns=expected.filter(field=>!actualByName.has(field.name)).map(field=>field.name).slice(0,limit);
  const incompatible_columns=expected.flatMap(field=>{const actual=actualByName.get(field.name);return actual&&signature(actual)!==signature(field)?[{name:field.name,expected_type:String(field.type).toUpperCase(),expected_mode:String(field.mode||'NULLABLE').toUpperCase(),actual_type:String(actual.type||'UNKNOWN').toUpperCase(),actual_mode:String(actual.mode||'NULLABLE').toUpperCase()}]:[];}).slice(0,limit);
  const unexpected_columns=fields.filter(field=>!expectedByName.has(field.name)).map(field=>field.name).slice(0,limit);
  const ownershipMatches=ORACLE_OWNERSHIP_COLUMNS.filter(name=>{const expectedField=expectedByName.get(name),actual=actualByName.get(name);return actual&&expectedField&&signature(actual)===signature(expectedField);});
  const table_ownership=ownershipMatches.length===ORACLE_OWNERSHIP_COLUMNS.length?'earlier_oracle_job_table':'another_feature';
  return {matches:missing_columns.length===0&&incompatible_columns.length===0&&unexpected_columns.length===0,table_ownership,missing_columns,incompatible_columns,unexpected_columns,truncated:{missing:Math.max(0,expected.filter(field=>!actualByName.has(field.name)).length-limit),incompatible:Math.max(0,expected.filter(field=>actualByName.has(field.name)&&signature(actualByName.get(field.name))!==signature(field)).length-limit),unexpected:Math.max(0,fields.filter(field=>!expectedByName.has(field.name)).length-limit)}};
}

const value = date => date?.value || date || null;
const normalize = row => row && ({...row,payload_json:typeof row.payload_json==='string'?JSON.parse(row.payload_json):row.payload_json,result_json:typeof row.result_json==='string'?JSON.parse(row.result_json):row.result_json,created_at:value(row.created_at),updated_at:value(row.updated_at),lease_until:value(row.lease_until)});

/** Durable BigQuery queue. A lease is acquired atomically; stale running work is
 * failed rather than replayed because model/tool calls are not transactional. */
export function createBigQueryAnalysisJobStore({bigquery,project,dataset=ORACLE_JOB_DEFAULTS.dataset,table=ORACLE_JOB_DEFAULTS.table,location=ORACLE_JOB_DEFAULTS.location}) {
  const fq=`\`${project}.${dataset}.${table}\``;
  let datasetLocation;
  const resolveDatasetLocation=async ds=>{if(datasetLocation)return datasetLocation;const [metadata]=await ds.getMetadata();datasetLocation=metadata.location;return datasetLocation;};
  const query=async(sql,params={})=>(await bigquery.query({query:sql,params,location:await resolveDatasetLocation(bigquery.dataset(dataset))}))[0];
  return {
    async setup(){const ds=bigquery.dataset(dataset);const [exists]=await ds.exists();if(!exists)await ds.create({location});await resolveDatasetLocation(ds);const t=ds.table(table);const [present]=await t.exists();if(!present){await t.create({schema:JOB_SCHEMA});return;}const [metadata]=await t.getMetadata();const inspection=inspectJobTableSchema(metadata.schema?.fields||[]);if(!inspection.matches)throw Object.assign(new Error(`Oracle job table schema mismatch: ${table}`),{code:'SCHEMA_MISMATCH',schema_diff:inspection});},
    // Do not use table.insert here. That API uses BigQuery's legacy streaming
    // buffer, whose rows cannot reliably be mutated by the claim UPDATE. A
    // query INSERT is committed before it returns and is immediately eligible
    // for the queue's transactional UPDATE lifecycle.
    async create({owner_key,request_id,payload_json}){const job_id=crypto.randomUUID(),created_at=new Date();await query(`INSERT INTO ${fq} (job_id,owner_key,request_id,status,payload_json,result_json,error_code,created_at,updated_at,lease_until,attempts,cancel_requested) VALUES (@job_id,@owner_key,@request_id,'queued',PARSE_JSON(@payload_json),NULL,NULL,@created_at,@created_at,NULL,0,FALSE)`,{job_id,owner_key,request_id,payload_json:JSON.stringify(payload_json),created_at});return {job_id,status:'queued',created_at:created_at.toISOString()};},
    async get(job_id,owner_key){return normalize((await query(`SELECT * FROM ${fq} WHERE job_id=@job_id AND owner_key=@owner_key LIMIT 1`,{job_id,owner_key}))[0]);},
    async getByRequest(request_id,owner_key){return normalize((await query(`SELECT * FROM ${fq} WHERE request_id=@request_id AND owner_key=@owner_key ORDER BY created_at DESC LIMIT 1`,{request_id,owner_key}))[0]);},
    // Ordinary polling deliberately performs a read-only candidate lookup first.
    // Besides making an empty queue cheap, this removes the ordinary-only
    // scalar-subquery/script-variable branch that returned 400 in production.
    // (The targeted smoke never exercised that SQL branch.) The
    // targeted transaction still makes the queued -> running transition atomic;
    // if another worker wins the race this worker simply receives no row.
    async peekOrdinary(){return (await query(`SELECT job_id FROM ${fq} AS candidate WHERE candidate.status='queued' AND candidate.cancel_requested=FALSE AND NOT STARTS_WITH(candidate.request_id,'oracle-smoke-') ORDER BY candidate.created_at LIMIT 1`))[0]||null;},
    async claim({worker_id,leaseMs,now=Date.now(),job_id=null}){const candidate=job_id?{job_id}:await this.peekOrdinary();if(!candidate)return null;const lease=new Date(now+leaseMs),targetJobId=candidate.job_id;const rows=await query(`BEGIN TRANSACTION; UPDATE ${fq} AS stale SET status='failed',error_code='WORKER_RESTARTED',updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE stale.status='running' AND stale.lease_until<CURRENT_TIMESTAMP(); UPDATE ${fq} AS queued SET status='running',attempts=queued.attempts+1,updated_at=CURRENT_TIMESTAMP(),lease_until=@lease WHERE queued.job_id=@job_id AND queued.status='queued' AND queued.cancel_requested=FALSE; COMMIT TRANSACTION; SELECT * FROM ${fq} AS claimed WHERE claimed.job_id=@job_id AND claimed.status='running' AND claimed.lease_until=@lease LIMIT 1;`,{lease,job_id:targetJobId});return normalize(rows[0]);},
    async finish(job_id,result_json){await query(`UPDATE ${fq} SET status=IF(cancel_requested,'cancelled','completed'),result_json=IF(cancel_requested,NULL,PARSE_JSON(@result)),updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE job_id=@job_id AND status='running'`,{job_id,result:JSON.stringify(result_json)});},
    async fail(job_id,error_code){await query(`UPDATE ${fq} SET status=IF(cancel_requested,'cancelled','failed'),error_code=IF(cancel_requested,NULL,@code),updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE job_id=@job_id AND status='running'`,{job_id,code:error_code});},
    async cancel(job_id,owner_key){await query(`UPDATE ${fq} SET cancel_requested=TRUE,status=IF(status IN ('queued','running'),'cancelled',status),updated_at=CURRENT_TIMESTAMP() WHERE job_id=@job_id AND owner_key=@owner_key`,{job_id,owner_key});},
    async isCancelled(job_id){const row=(await query(`SELECT cancel_requested,status FROM ${fq} WHERE job_id=@job_id LIMIT 1`,{job_id}))[0];return !row||row.cancel_requested||row.status==='cancelled';}
  };
}

export function createAnalysisJobWorker({store,run,pollMs=1000,leaseMs=9*60_000,runtimeMs=8*60_000,maxBackoffMs=60_000,logger=console}) {
  let timer=null,running=false,controller=null,stopped=true,failures=0,stage='claim';
  const diagnostic=error=>{const bq=bigQueryErrorDiagnostic(error);return {stage,error_class:safeToken(error?.name,'Error'),code:safeToken(error?.code),...(bq.reason!=='unknown'?{bigquery_reason:bq.reason}:{}),...(bq.message?{bigquery_message:bq.message}:{}),...(bq.location?{bigquery_location:bq.location}:{})};};
  const tick=async()=>{if(running)return;running=true;try{stage='claim';const job=await store.claim({worker_id:process.pid,leaseMs});if(!job)return;controller=new AbortController();const cancelPoll=setInterval(async()=>{try{stage='cancel_check';if(await store.isCancelled(job.job_id))controller.abort(new Error('cancelled'));}catch(error){logger.error('Oracle job worker stage failed:',diagnostic(error));}},Math.min(pollMs,1000));let runtimeTimer;try{const timeout=new Promise((_,reject)=>{runtimeTimer=setTimeout(()=>{controller.abort(new Error('runtime'));reject(Object.assign(new Error('runtime'),{code:'JOB_RUNTIME_EXCEEDED'}));},runtimeMs)});stage='analysis';const result=await Promise.race([run(job,controller.signal),timeout]);stage='finish';await store.finish(job.job_id,result);}catch(error){try{stage='fail';await store.fail(job.job_id,error?.code==='JOB_RUNTIME_EXCEEDED'?'JOB_RUNTIME_EXCEEDED':'ANALYSIS_FAILED');}catch(failError){logger.error('Oracle job worker stage failed:',diagnostic(failError));throw failError;}}finally{clearTimeout(runtimeTimer);clearInterval(cancelPoll);controller=null;}}finally{running=false;}};
  const schedule=delay=>{if(stopped)return;timer=setTimeout(async()=>{try{await tick();failures=0;}catch(error){failures++;logger.error('Oracle job worker failed:',diagnostic(error));}schedule(failures?Math.min(maxBackoffMs,pollMs*2**Math.min(failures,10)):pollMs);},delay);timer.unref?.();};
  return {start(){if(!stopped)return;stopped=false;schedule(0);},stop(){stopped=true;clearTimeout(timer);timer=null;controller?.abort(new Error('worker stopped'));},tick,get backoffMs(){return failures?Math.min(maxBackoffMs,pollMs*2**Math.min(failures,10)):pollMs;}};
}

export function createMemoryAnalysisJobStore(seed=[]) {
  const jobs=new Map(seed.map(job=>[job.job_id,{...job}]));
  return {jobs,async setup(){},async create(input){const existing=[...jobs.values()].find(job=>job.owner_key===input.owner_key&&job.request_id===input.request_id);if(existing)return structuredClone(existing);const now=new Date().toISOString(),job={...input,job_id:crypto.randomUUID(),status:'queued',created_at:now,updated_at:now,attempts:0,cancel_requested:false};jobs.set(job.job_id,job);return job;},async get(id,owner){const job=jobs.get(id);return job?.owner_key===owner?structuredClone(job):null;},async getByRequest(request,owner){const job=[...jobs.values()].find(x=>x.request_id===request&&x.owner_key===owner);return job?structuredClone(job):null;},async claim({leaseMs,job_id=null}){const stale=[...jobs.values()].find(x=>x.status==='running'&&Date.parse(x.lease_until)<Date.now());if(stale){stale.status='failed';stale.error_code='WORKER_RESTARTED';stale.lease_until=null;}const job=[...jobs.values()].find(x=>x.status==='queued'&&!x.cancel_requested&&(!job_id? !String(x.request_id||'').startsWith('oracle-smoke-'):x.job_id===job_id));if(!job)return null;job.status='running';job.attempts++;job.lease_until=new Date(Date.now()+leaseMs).toISOString();return structuredClone(job);},async finish(id,result){const job=jobs.get(id);if(job.status!=='running')return;job.status=job.cancel_requested?'cancelled':'completed';job.result_json=job.cancel_requested?null:result;job.updated_at=new Date().toISOString();},async fail(id,code){const job=jobs.get(id);if(job.status!=='running')return;job.status=job.cancel_requested?'cancelled':'failed';job.error_code=job.cancel_requested?null:code;},async cancel(id,owner){const job=jobs.get(id);if(job?.owner_key===owner){job.cancel_requested=true;if(['queued','running'].includes(job.status))job.status='cancelled';}},async isCancelled(id){const job=jobs.get(id);return !job||job.cancel_requested||job.status==='cancelled';}};
}

export function ownerKey(sessionCookie,secret){return crypto.createHmac('sha256',secret).update(sessionCookie||'').digest('hex');}
