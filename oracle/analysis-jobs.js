import crypto from 'node:crypto';

export const JOB_SCHEMA = [
  {name:'job_id',type:'STRING',mode:'REQUIRED'}, {name:'owner_key',type:'STRING',mode:'REQUIRED'},
  {name:'request_id',type:'STRING',mode:'REQUIRED'}, {name:'status',type:'STRING',mode:'REQUIRED'},
  {name:'payload_json',type:'JSON',mode:'REQUIRED'}, {name:'result_json',type:'JSON'},
  {name:'error_code',type:'STRING'}, {name:'created_at',type:'TIMESTAMP',mode:'REQUIRED'},
  {name:'updated_at',type:'TIMESTAMP',mode:'REQUIRED'}, {name:'lease_until',type:'TIMESTAMP'},
  {name:'attempts',type:'INT64',mode:'REQUIRED'}, {name:'cancel_requested',type:'BOOL',mode:'REQUIRED'},
  {name:'claim_token',type:'STRING'}, {name:'worker_id',type:'STRING'}
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

const safeStage=(value,fallback='analysis')=>/^[a-z][a-z0-9_.:-]{0,79}$/.test(String(value||''))?String(value):fallback;
const safeToken=(value,fallback='unknown')=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(value||''))?String(value):fallback;
const errorDetail=error=>{const outer=Array.isArray(error?.errors)?error.errors[0]:null;return Array.isArray(outer?.errors)?outer.errors[0]:outer;};
export function bigQueryErrorDiagnostic(error) {
  const detail=errorDetail(error);
  return {
    reason:safeToken(detail?.reason||error?.reason||error?.code),
    ...(safeToken(detail?.location||error?.location,'')?{location:safeToken(detail?.location||error?.location)}:{})
  };
}
export function isConcurrentUpdateAbort(error) {
  const diagnostic=bigQueryErrorDiagnostic(error);
  // Inspect text only for this exact retry classification; never emit it.
  return diagnostic.reason==='aborted'||(
    diagnostic.reason==='invalidQuery'&&/transaction aborted due to concurrent update/i.test(String(errorDetail(error)?.message||''))
  );
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
export function createBigQueryAnalysisJobStore({bigquery,project,dataset=ORACLE_JOB_DEFAULTS.dataset,table=ORACLE_JOB_DEFAULTS.table,location=ORACLE_JOB_DEFAULTS.location,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),claimRetries=3}) {
  const fq=`\`${project}.${dataset}.${table}\``;
  let datasetLocation;
  const resolveDatasetLocation=async ds=>{if(datasetLocation)return datasetLocation;const [metadata]=await ds.getMetadata();datasetLocation=metadata.location;return datasetLocation;};
  const query=async(sql,params={})=>(await bigquery.query({query:sql,params,location:await resolveDatasetLocation(bigquery.dataset(dataset))}))[0];
  const contentionDelay=attempt=>sleep(Math.floor((50*2**attempt)*(0.5+Math.random())));
  const terminalWrite=async(sql,params)=>{for(let attempt=0;attempt<claimRetries;attempt++){try{const [job]=await bigquery.createQueryJob({query:sql,params,location:await resolveDatasetLocation(bigquery.dataset(dataset)),useLegacySql:false});await job.getQueryResults();const [metadata]=await job.getMetadata();return Number(metadata.statistics?.query?.numDmlAffectedRows)===1;}catch(error){if(!isConcurrentUpdateAbort(error)||attempt===claimRetries-1)throw error;const row=normalize((await query(`SELECT status,lease_until,claim_token FROM ${fq} WHERE job_id=@job_id LIMIT 1`,{job_id:params.job_id}))[0]);if(!row||['completed','failed','cancelled'].includes(row.status))return false;if(row.claim_token!==params.claim_token||String(value(row.lease_until))!==params.lease.toISOString())return false;await contentionDelay(attempt);}}};
  return {
    async setup(){const ds=bigquery.dataset(dataset);const [exists]=await ds.exists();if(!exists)await ds.create({location});await resolveDatasetLocation(ds);const t=ds.table(table);const [present]=await t.exists();if(!present){await t.create({schema:JOB_SCHEMA});return;}let [metadata]=await t.getMetadata();const fields=metadata.schema?.fields||[],missingLeaseFields=JOB_SCHEMA.filter(field=>['claim_token','worker_id'].includes(field.name)&&!fields.some(existing=>existing.name===field.name));if(missingLeaseFields.length){await t.setMetadata({schema:{fields:[...fields,...missingLeaseFields]}});[metadata]=await t.getMetadata();}const inspection=inspectJobTableSchema(metadata.schema?.fields||[]);if(!inspection.matches)throw Object.assign(new Error(`Oracle job table schema mismatch: ${table}`),{code:'SCHEMA_MISMATCH',schema_diff:inspection});},
    // Do not use table.insert here. That API uses BigQuery's legacy streaming
    // buffer, whose rows cannot reliably be mutated by the claim UPDATE. A
    // query MERGE is committed before it returns, is immediately eligible for
    // the queue lifecycle, and makes a repeated owner/request submission safe.
    async create({owner_key,request_id,payload_json}){const job_id=crypto.randomUUID(),created_at=new Date(),params={job_id,owner_key,request_id,payload_json:JSON.stringify(payload_json),created_at};for(let attempt=0;attempt<claimRetries;attempt++){try{await query(`MERGE ${fq} AS jobs USING (SELECT @owner_key AS owner_key,@request_id AS request_id) AS submission ON jobs.owner_key=submission.owner_key AND jobs.request_id=submission.request_id WHEN NOT MATCHED THEN INSERT (job_id,owner_key,request_id,status,payload_json,result_json,error_code,created_at,updated_at,lease_until,attempts,cancel_requested,claim_token,worker_id) VALUES (@job_id,@owner_key,@request_id,'queued',PARSE_JSON(@payload_json),NULL,NULL,@created_at,@created_at,NULL,0,FALSE,NULL,NULL);`,params);break;}catch(error){if(!isConcurrentUpdateAbort(error)||attempt===claimRetries-1)throw error;await contentionDelay(attempt);}}return normalize((await query(`SELECT * FROM ${fq} WHERE owner_key=@owner_key AND request_id=@request_id ORDER BY created_at LIMIT 1`,{owner_key,request_id}))[0]);},
    async get(job_id,owner_key){return normalize((await query(`SELECT * FROM ${fq} WHERE job_id=@job_id AND owner_key=@owner_key LIMIT 1`,{job_id,owner_key}))[0]);},
    async getByRequest(request_id,owner_key){return normalize((await query(`SELECT * FROM ${fq} WHERE request_id=@request_id AND owner_key=@owner_key ORDER BY created_at DESC LIMIT 1`,{request_id,owner_key}))[0]);},
    // Ordinary polling deliberately performs a read-only candidate lookup first.
    // Besides making an empty queue cheap, this removes the ordinary-only
    // scalar-subquery/script-variable branch that returned 400 in production.
    // (The targeted smoke never exercised that SQL branch.) The
    // targeted transaction still makes the queued -> running transition atomic;
    // if another worker wins the race this worker simply receives no row.
    async peekOrdinary(){return (await query(`SELECT job_id FROM ${fq} AS candidate WHERE candidate.status='queued' AND candidate.cancel_requested=FALSE AND NOT STARTS_WITH(candidate.request_id,'oracle-smoke-') ORDER BY candidate.created_at LIMIT 1`))[0]||null;},
    async claim({worker_id,leaseMs,now=Date.now(),job_id=null}){const candidate=job_id?{job_id}:await this.peekOrdinary();if(!candidate)return null;const lease=new Date(now+leaseMs),targetJobId=candidate.job_id,claim_token=crypto.randomUUID(),params={lease,job_id:targetJobId,claim_token,worker_id:String(worker_id)};for(let attempt=0;attempt<claimRetries;attempt++){try{const rows=await query(`BEGIN TRANSACTION; UPDATE ${fq} AS queued SET status='running',attempts=queued.attempts+1,updated_at=CURRENT_TIMESTAMP(),lease_until=@lease,claim_token=@claim_token,worker_id=@worker_id WHERE queued.job_id=@job_id AND queued.status='queued' AND queued.cancel_requested=FALSE; COMMIT TRANSACTION; SELECT * FROM ${fq} AS claimed WHERE claimed.job_id=@job_id AND claimed.status='running' AND claimed.claim_token=@claim_token AND claimed.lease_until=@lease LIMIT 1;`,params);return normalize(rows[0]);}catch(error){if(!isConcurrentUpdateAbort(error)||attempt===claimRetries-1)throw error;const current=normalize((await query(`SELECT status,lease_until,claim_token FROM ${fq} WHERE job_id=@job_id LIMIT 1`,{job_id:targetJobId}))[0]);if(current?.status!=='queued')return current?.claim_token===claim_token?current:null;await contentionDelay(attempt);}}return null;},
    async checkpoint(job_id,result_json,claim){return terminalWrite(`UPDATE ${fq} SET result_json=PARSE_JSON(@result),updated_at=CURRENT_TIMESTAMP() WHERE job_id=@job_id AND status='running' AND claim_token=@claim_token AND lease_until=@lease AND lease_until>=CURRENT_TIMESTAMP()`,{job_id,result:JSON.stringify(result_json),claim_token:claim.claim_token,lease:new Date(value(claim.lease_until))});},
    async finish(job_id,result_json,claim){return terminalWrite(`UPDATE ${fq} SET status=IF(cancel_requested,'cancelled','completed'),result_json=IF(cancel_requested,NULL,PARSE_JSON(@result)),updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE job_id=@job_id AND status='running' AND claim_token=@claim_token AND lease_until=@lease AND lease_until>=CURRENT_TIMESTAMP()`,{job_id,result:JSON.stringify(result_json),claim_token:claim.claim_token,lease:new Date(value(claim.lease_until))});},
    async fail(job_id,error_code,failure_json=null,claim){return terminalWrite(`UPDATE ${fq} SET status=IF(cancel_requested,'cancelled','failed'),error_code=IF(cancel_requested,NULL,@code),result_json=IF(cancel_requested,result_json,COALESCE(result_json,PARSE_JSON(@result))),updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE job_id=@job_id AND status='running' AND claim_token=@claim_token AND lease_until=@lease AND lease_until>=CURRENT_TIMESTAMP()`,{job_id,code:error_code,result:JSON.stringify(failure_json||{}),claim_token:claim.claim_token,lease:new Date(value(claim.lease_until))});},
    async cancel(job_id,owner_key){await query(`UPDATE ${fq} SET cancel_requested=TRUE,status=IF(status IN ('queued','running'),'cancelled',status),updated_at=CURRENT_TIMESTAMP() WHERE job_id=@job_id AND owner_key=@owner_key`,{job_id,owner_key});},
    async isCancelled(job_id){const row=(await query(`SELECT cancel_requested,status FROM ${fq} WHERE job_id=@job_id LIMIT 1`,{job_id}))[0];return !row||row.cancel_requested||row.status==='cancelled';}
  };
}

export function createAnalysisJobWorker({store,run,pollMs=1000,leaseMs=9*60_000,runtimeMs=8*60_000,maxBackoffMs=60_000,logger=console,workerId=`${process.pid}-${crypto.randomUUID()}`}) {
  let timer=null,running=false,controller=null,stopped=true,failures=0,stage='claim';
  let context={};
  const diagnostic=(error,failedStage=stage)=>{const bq=bigQueryErrorDiagnostic(error);return {...context,stage:safeStage(error?.failed_stage||error?.stage||failedStage),code:safeToken(error?.code),...(bq.reason!=='unknown'?{bigquery_reason:bq.reason}:{}),...(bq.location?{bigquery_location:bq.location}:{}),...(Number.isInteger(error?.status)?{status:error.status}:{})};};
  const tick=async()=>{
    if(running)return;
    running=true;context={worker_id:safeToken(workerId)};
    try{
      stage='claim';
      const job=await store.claim({worker_id:workerId,leaseMs});if(!job)return;
      context={request_id:safeToken(job.request_id),job_id:safeToken(job.job_id),attempt:Number(job.attempts)||0,worker_id:safeToken(workerId)};
      logger.info?.('Oracle job worker stage:',{...context,stage:'claimed',status:'success'});
      controller=new AbortController();const activeController=controller;
      const cancelPoll=setInterval(async()=>{try{if(await store.isCancelled(job.job_id))activeController.abort(new Error('cancelled'));}catch(error){logger.error('Oracle job worker stage failed:',diagnostic(error,'cancel_check'));}},Math.min(pollMs,1000));
      let runtimeTimer,result;
      try{
        const timeout=new Promise((_,reject)=>{runtimeTimer=setTimeout(()=>{activeController.abort(new Error('runtime'));reject(Object.assign(new Error('runtime'),{code:'JOB_RUNTIME_EXCEEDED'}));},runtimeMs)});
        stage='analysis';result=await Promise.race([run(job,controller.signal),timeout]);
        stage='evidence_checkpoint';
        if(await store.checkpoint?.(job.job_id,result,job)===false)throw Object.assign(new Error('Lease rejected'),{code:'LEASE_NOT_OWNED'});
        logger.info?.('Oracle job worker stage:',{...context,stage,status:'success'});
        stage='finish';
        if(await store.finish(job.job_id,result,job)===false)throw Object.assign(new Error('Lease rejected'),{code:'LEASE_NOT_OWNED'});
        logger.info?.('Oracle job worker stage:',{...context,stage,status:'success'});
      }catch(error){
        const failedStage=safeStage(error?.failed_stage||error?.stage||stage,'analysis');
        logger.error('Oracle job worker stage failed:',diagnostic(error,failedStage));
        // A rejected lease must never cause a terminal write by the stale worker.
        if(error?.code==='LEASE_NOT_OWNED')return;
        const code=error?.code==='JOB_RUNTIME_EXCEEDED'?'JOB_RUNTIME_EXCEEDED':safeToken(error?.code,'ANALYSIS_FAILED');
        try{
          stage='fail';
          // Keep successful evidence/artifact references even if checkpoint failed.
          const written=await store.fail(job.job_id,code,{...result,failed_stage:failedStage,code},job);
          if(written===false)logger.error('Oracle job worker stage failed:',{...context,stage,code:'LEASE_NOT_OWNED'});
        }catch(failError){logger.error('Oracle job worker stage failed:',diagnostic(failError));throw failError;}
      }finally{clearTimeout(runtimeTimer);clearInterval(cancelPoll);controller=null;}
    }finally{running=false;context={};}
  };
  const schedule=delay=>{if(stopped)return;timer=setTimeout(async()=>{try{await tick();failures=0;}catch(error){failures++;logger.error('Oracle job worker failed:',diagnostic(error));}schedule(failures?Math.min(maxBackoffMs,pollMs*2**Math.min(failures,10)):pollMs);},delay);timer.unref?.();};
  return {start(){if(!stopped)return;stopped=false;schedule(0);},stop(){stopped=true;clearTimeout(timer);timer=null;controller?.abort(new Error('worker stopped'));},tick,get backoffMs(){return failures?Math.min(maxBackoffMs,pollMs*2**Math.min(failures,10)):pollMs;}};
}

export function createMemoryAnalysisJobStore(seed=[]) {
  const jobs=new Map(seed.map(job=>[job.job_id,{...job}]));
  const owns=(job,claim)=>job?.status==='running'&&job.claim_token===claim?.claim_token&&job.lease_until===claim?.lease_until&&Date.parse(job.lease_until)>=Date.now();
  return {jobs,async setup(){},async create(input){const existing=[...jobs.values()].find(job=>job.owner_key===input.owner_key&&job.request_id===input.request_id);if(existing)return structuredClone(existing);const now=new Date().toISOString(),job={...input,job_id:crypto.randomUUID(),status:'queued',created_at:now,updated_at:now,attempts:0,cancel_requested:false};jobs.set(job.job_id,job);return structuredClone(job);},async get(id,owner){const job=jobs.get(id);return job?.owner_key===owner?structuredClone(job):null;},async getByRequest(request,owner){const job=[...jobs.values()].find(x=>x.request_id===request&&x.owner_key===owner);return job?structuredClone(job):null;},async claim({leaseMs,job_id=null,worker_id='memory-worker'}){for(const stale of jobs.values())if(stale.status==='running'&&Date.parse(stale.lease_until)<Date.now()){stale.status='failed';stale.error_code='WORKER_RESTARTED';stale.lease_until=null;}const job=[...jobs.values()].find(x=>x.status==='queued'&&!x.cancel_requested&&(!job_id?!String(x.request_id||'').startsWith('oracle-smoke-'):x.job_id===job_id));if(!job)return null;job.status='running';job.attempts++;job.lease_until=new Date(Date.now()+leaseMs).toISOString();job.claim_token=crypto.randomUUID();job.worker_id=String(worker_id);return structuredClone(job);},async checkpoint(id,result,claim){const job=jobs.get(id);if(!owns(job,claim))return false;job.result_json=structuredClone(result);job.updated_at=new Date().toISOString();return true;},async finish(id,result,claim){const job=jobs.get(id);if(!owns(job,claim))return false;job.status=job.cancel_requested?'cancelled':'completed';job.result_json=job.cancel_requested?null:result;job.updated_at=new Date().toISOString();job.lease_until=null;return true;},async fail(id,code,failure=null,claim){const job=jobs.get(id);if(!owns(job,claim))return false;job.status=job.cancel_requested?'cancelled':'failed';job.error_code=job.cancel_requested?null:code;job.result_json=job.cancel_requested?job.result_json:(job.result_json||failure);job.updated_at=new Date().toISOString();job.lease_until=null;return true;},async cancel(id,owner){const job=jobs.get(id);if(job?.owner_key===owner){job.cancel_requested=true;if(['queued','running'].includes(job.status))job.status='cancelled';}},async isCancelled(id){const job=jobs.get(id);return !job||job.cancel_requested||job.status==='cancelled';}};
}

export function ownerKey(sessionCookie,secret){return crypto.createHmac('sha256',secret).update(sessionCookie||'').digest('hex');}
