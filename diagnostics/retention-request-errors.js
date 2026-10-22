// Exact retained evidence only. No report/provider execution, source reads,
// collection, queue mutation or fallback calculation. Dependency-free for a
// checksum-pinned Render import using the deployed BigQuery SDK.
export const REQUEST='15118146-147f-480c-90f7-4b21d27182f8';
const ident=v=>{if(!/^[A-Za-z0-9_-]+$/.test(v||''))throw Error('Invalid identifier');return v;};
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:/+-]{1,180}$/.test(v)?v:null;
export const diagnosticMessage=v=>String(v||'').replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/(access_token|refresh_token|client_secret|private_key|authorization)(["'\s:=]+)[^,}\]\s]+/gi,'$1$2[redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]').slice(0,800);
export function requestErrorsSql(project,dataset='commerce',table='oracle_analysis_jobs_v1'){
 return `SELECT job_id,status,error_code,JSON_VALUE(payload_json,'$.execution_revision') requested_revision,JSON_VALUE(lifecycle_json,'$.execution_revision') execution_revision,JSON_VALUE(lifecycle_json,'$.stage') lifecycle_stage,TO_JSON_STRING(result_json) retained_result FROM \`${ident(project)}.${ident(dataset)}.${ident(table)}\` WHERE request_id=@request_id ORDER BY created_at DESC LIMIT 2`;
}
function unpack(value){for(let i=0;i<6;i++){if(typeof value==='string'){try{value=JSON.parse(value);}catch{return {};}}else if(value?.evidence||value?.source_outcomes)return value;else if(value?.result_json!=null)value=value.result_json;else if(value?.result!=null)value=value.result;else return value||{};}return {};}
export function retainedRequestRow(row){
 const result=unpack(row.retained_result),e=result.evidence||result;
 const outcomes=Array.isArray(e.source_outcomes)?e.source_outcomes:[];
 return {job_id:token(row.job_id),status:token(row.status),error_code:token(row.error_code),requested_revision:token(row.requested_revision),execution_revision:token(row.execution_revision),lifecycle_stage:token(row.lifecycle_stage),outcomes_truncated:outcomes.length>9,
   outcomes:outcomes.slice(0,9).map(o=>({...Object.fromEntries(['source_platform','source_store','group','state','stage','code','status','provider_reason','bigquery_reason','error_category','timeout_category','query_id','population_read','validation_reason','validation_field','validation_rule'].map(k=>[k,token(o[k])])),http_status:Number.isInteger(o.http_status)?o.http_status:null,statement_location:o.statement_location&&Number.isInteger(o.statement_location.line)&&Number.isInteger(o.statement_location.column)?{line:o.statement_location.line,column:o.statement_location.column}:null})),
   section_outcomes:(Array.isArray(e.section_outcomes)?e.section_outcomes:[]).slice(0,6).map(o=>Object.fromEntries(['source_platform','source_store','component','state','stage','code','query_id'].map(k=>[k,token(o[k])]))),
   root_validation:Object.fromEntries(['code','failed_stage','validation_field','validation_rule'].map(k=>[k,token(result[k])]))};
}
export async function readRetainedRequestErrors({bigquery,project,dataset='commerce',table='oracle_analysis_jobs_v1',deployedRevision=null,now=()=>Date.now(),maximumMs=35000}){
 const deadline=now()+maximumMs,checks=[],remaining=()=>{const ms=deadline-now();if(ms<=0)throw Error('deadline');return Math.min(ms,8000);};
 const bounded=async fn=>{const ms=remaining();let timer;try{return await Promise.race([fn(ms),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline')),ms);})]);}finally{clearTimeout(timer);}};
 const fail=e=>({status:'unavailable',http_status:Number(e?.code)>=400&&Number(e?.code)<=599?Number(e.code):null,message:diagnosticMessage(e?.message)});
 const output={read_only:true,request_id:REQUEST,report_replayed:false,current_deployed_revision:token(deployedRevision),bounds:{select_jobs:1,maximum_bytes:'1000000000',saved_rows:2,source_outcomes_per_row:9,metadata_gets:10,shared_deadline_ms:maximumMs},checks};
 let rows,location;
 try{const [m]=await bounded(()=>bigquery.dataset(dataset).getMetadata({maxRetries:0}));location=m.location;if(!location)throw Error('Dataset location unavailable');checks.push({check:'job_dataset_location',status:'read_completed',location:token(location)});}catch(e){checks.push({check:'job_dataset_location',...fail(e)});return output;}
 try{const [r,next,response]=await bounded(ms=>bigquery.query({query:requestErrorsSql(project,dataset,table),params:{request_id:REQUEST},types:{request_id:'STRING'},location,useLegacySql:false,jobTimeoutMs:ms,maximumBytesBilled:'1000000000',autoPaginate:false,maxResults:2,labels:{component:'retention_exact_errors'}}));rows=r;if(next||response?.pageToken)throw Error('Retained row bound reached');checks.push({check:'exact_retained_request',status:rows.length?'read_completed':'not_found',ambiguous_saved_job:rows.length>1,records:rows.map(retainedRequestRow)});}catch(e){checks.push({check:'exact_retained_request',...fail(e)});return output;}
 const ids=[...new Set(rows.flatMap(r=>retainedRequestRow(r).outcomes.map(o=>o.query_id)).filter(Boolean))];
 for(const id of ids.slice(0,9))try{const [m]=await bounded(()=>bigquery.job(id,{location}).getMetadata({maxRetries:0}));const errors=[m.status?.errorResult,...(m.status?.errors||[])].filter(Boolean);checks.push({check:'retained_warehouse_job',query_id:id,status:'read_completed',warehouse_state:token(m.status?.state),statement_type:token(m.statistics?.query?.statementType),warehouse_location:token(m.jobReference?.location)||token(location),errors:errors.slice(0,3).map(e=>{const at=String(e.message||'').match(/\[(\d+):(\d+)\]/);return {reason:token(e.reason),location:token(e.location),statement_location:at?{line:Number(at[1]),column:Number(at[2])}:null,message:diagnosticMessage(e.message)};})});}catch(e){checks.push({check:'retained_warehouse_job',query_id:id,...fail(e)});}
 if(ids.length>9)checks.push({check:'retained_warehouse_job_bound',status:'not_read',remaining_job_ids:ids.slice(9)});
 return output;
}
