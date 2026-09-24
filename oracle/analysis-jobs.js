import crypto from 'node:crypto';

export const JOB_SCHEMA = [
  {name:'job_id',type:'STRING',mode:'REQUIRED'}, {name:'owner_key',type:'STRING',mode:'REQUIRED'},
  {name:'request_id',type:'STRING',mode:'REQUIRED'}, {name:'status',type:'STRING',mode:'REQUIRED'},
  {name:'payload_json',type:'JSON',mode:'REQUIRED'}, {name:'result_json',type:'JSON'},
  {name:'error_code',type:'STRING'}, {name:'created_at',type:'TIMESTAMP',mode:'REQUIRED'},
  {name:'updated_at',type:'TIMESTAMP',mode:'REQUIRED'}, {name:'lease_until',type:'TIMESTAMP'},
  {name:'attempts',type:'INT64',mode:'REQUIRED'}, {name:'cancel_requested',type:'BOOL',mode:'REQUIRED'}
];

const value = date => date?.value || date || null;
const normalize = row => row && ({...row,payload_json:typeof row.payload_json==='string'?JSON.parse(row.payload_json):row.payload_json,result_json:typeof row.result_json==='string'?JSON.parse(row.result_json):row.result_json,created_at:value(row.created_at),updated_at:value(row.updated_at),lease_until:value(row.lease_until)});

/** Durable BigQuery queue. A lease is acquired atomically; stale running work is
 * failed rather than replayed because model/tool calls are not transactional. */
export function createBigQueryAnalysisJobStore({bigquery,project,dataset='commerce',table='oracle_analysis_jobs'}) {
  const fq=`\`${project}.${dataset}.${table}\``;
  const query=async(sql,params={})=>(await bigquery.query({query:sql,params}))[0];
  return {
    async setup(){const ds=bigquery.dataset(dataset);const [exists]=await ds.exists();if(!exists)await ds.create();const t=ds.table(table);const [present]=await t.exists();if(!present)await t.create({schema:JOB_SCHEMA});},
    async create({owner_key,request_id,payload_json}){const job_id=crypto.randomUUID(),now=new Date().toISOString();await bigquery.dataset(dataset).table(table).insert([{job_id,owner_key,request_id,status:'queued',payload_json,result_json:null,error_code:null,created_at:now,updated_at:now,lease_until:null,attempts:0,cancel_requested:false}]);return {job_id,status:'queued',created_at:now};},
    async get(job_id,owner_key){return normalize((await query(`SELECT * FROM ${fq} WHERE job_id=@job_id AND owner_key=@owner_key LIMIT 1`,{job_id,owner_key}))[0]);},
    async claim({worker_id,leaseMs,now=Date.now()}){const lease=new Date(now+leaseMs).toISOString();const rows=await query(`BEGIN TRANSACTION; UPDATE ${fq} SET status='failed',error_code='WORKER_RESTARTED',updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE status='running' AND lease_until<CURRENT_TIMESTAMP(); UPDATE ${fq} SET status='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP(),lease_until=@lease WHERE job_id=(SELECT job_id FROM ${fq} WHERE status='queued' AND cancel_requested=FALSE ORDER BY created_at LIMIT 1) AND status='queued'; SELECT * FROM ${fq} WHERE status='running' AND lease_until=@lease LIMIT 1; COMMIT TRANSACTION;`,{lease});return normalize(rows[0]);},
    async finish(job_id,result_json){await query(`UPDATE ${fq} SET status=IF(cancel_requested,'cancelled','completed'),result_json=IF(cancel_requested,NULL,PARSE_JSON(@result)),updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE job_id=@job_id AND status='running'`,{job_id,result:JSON.stringify(result_json)});},
    async fail(job_id,error_code){await query(`UPDATE ${fq} SET status=IF(cancel_requested,'cancelled','failed'),error_code=IF(cancel_requested,NULL,@code),updated_at=CURRENT_TIMESTAMP(),lease_until=NULL WHERE job_id=@job_id AND status='running'`,{job_id,code:error_code});},
    async cancel(job_id,owner_key){await query(`UPDATE ${fq} SET cancel_requested=TRUE,status=IF(status IN ('queued','running'),'cancelled',status),updated_at=CURRENT_TIMESTAMP() WHERE job_id=@job_id AND owner_key=@owner_key`,{job_id,owner_key});},
    async isCancelled(job_id){const row=(await query(`SELECT cancel_requested,status FROM ${fq} WHERE job_id=@job_id LIMIT 1`,{job_id}))[0];return !row||row.cancel_requested||row.status==='cancelled';}
  };
}

export function createAnalysisJobWorker({store,run,pollMs=1000,leaseMs=9*60_000,runtimeMs=8*60_000}) {
  let timer=null,running=false,controller=null,current=null;
  const tick=async()=>{if(running)return;running=true;try{const job=await store.claim({worker_id:process.pid,leaseMs});if(!job)return;current=job.job_id;controller=new AbortController();const cancelPoll=setInterval(async()=>{if(await store.isCancelled(job.job_id))controller.abort(new Error('cancelled'));},Math.min(pollMs,1000));try{const result=await Promise.race([run(job,controller.signal),new Promise((_,reject)=>setTimeout(()=>{controller.abort(new Error('runtime'));reject(Object.assign(new Error('runtime'),{code:'JOB_RUNTIME_EXCEEDED'}));},runtimeMs))]);await store.finish(job.job_id,result);}catch(error){await store.fail(job.job_id,error?.code==='JOB_RUNTIME_EXCEEDED'?'JOB_RUNTIME_EXCEEDED':'ANALYSIS_FAILED');}finally{clearInterval(cancelPoll);controller=null;current=null;}}finally{running=false;}};
  return {start(){if(timer)return;timer=setInterval(()=>tick().catch(error=>console.error('Oracle job worker failed:',{error_class:error?.name||'Error'})),pollMs);timer.unref?.();tick().catch(()=>{});},stop(){clearInterval(timer);timer=null;controller?.abort(new Error('worker stopped'));},tick};
}

export function createMemoryAnalysisJobStore(seed=[]) {
  const jobs=new Map(seed.map(job=>[job.job_id,{...job}]));
  return {jobs,async setup(){},async create(input){const now=new Date().toISOString(),job={...input,job_id:crypto.randomUUID(),status:'queued',created_at:now,updated_at:now,attempts:0,cancel_requested:false};jobs.set(job.job_id,job);return job;},async get(id,owner){const job=jobs.get(id);return job?.owner_key===owner?structuredClone(job):null;},async claim({leaseMs}){const stale=[...jobs.values()].find(x=>x.status==='running'&&Date.parse(x.lease_until)<Date.now());if(stale){stale.status='failed';stale.error_code='WORKER_RESTARTED';stale.lease_until=null;}const job=[...jobs.values()].find(x=>x.status==='queued'&&!x.cancel_requested);if(!job)return null;job.status='running';job.attempts++;job.lease_until=new Date(Date.now()+leaseMs).toISOString();return structuredClone(job);},async finish(id,result){const job=jobs.get(id);if(job.status!=='running')return;job.status=job.cancel_requested?'cancelled':'completed';job.result_json=job.cancel_requested?null:result;job.updated_at=new Date().toISOString();},async fail(id,code){const job=jobs.get(id);if(job.status!=='running')return;job.status=job.cancel_requested?'cancelled':'failed';job.error_code=job.cancel_requested?null:code;},async cancel(id,owner){const job=jobs.get(id);if(job?.owner_key===owner){job.cancel_requested=true;if(['queued','running'].includes(job.status))job.status='cancelled';}},async isCancelled(id){const job=jobs.get(id);return !job||job.cancel_requested||job.status==='cancelled';}};
}

export function ownerKey(sessionCookie,secret){return crypto.createHmac('sha256',secret).update(sessionCookie||'').digest('hex');}
