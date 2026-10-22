// Metadata only: never submits a warehouse query. Match the exact reviewed SQL,
// page deterministically, and retain matches even if a later page is unavailable.
export async function readRetainedMappingErrors({bigquery,mappingSql,onCheck=()=>{},maximumMs=20000}){
 const deadline=Date.now()+maximumMs,seenTokens=new Set(),matches=new Map();
 const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mapping metadata deadline')),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}};
 const clean=e=>String(e?.message||e||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,8000);
 let pages=0,inventoryRows=0,inventoryTruncated=true,inventoryFailure=null;
 try{
  const [trace]=await bounded(bigquery.job('234c3fa4-30b3-4d6a-86db-4f4ac0ede92c',{location:'US'}).getMetadata());
  const created=Number(trace.statistics?.creationTime);if(!Number.isFinite(created)||created<=0)throw Error('Missing trace creation time');
  let pageToken;
  for(;pages<10&&Date.now()<deadline;){
   const [jobs,next,api]=await bounded(bigquery.getJobs({allUsers:false,projection:'full',autoPaginate:false,maxResults:25,minCreationTime:created-120000,maxCreationTime:created+120000,...(pageToken?{pageToken}:{})}));
   pages++;inventoryRows+=jobs.length;
   for(const job of jobs)if(job.metadata?.jobReference?.location==='US'&&job.metadata?.configuration?.query?.query===mappingSql)matches.set(job.id,job);
   pageToken=next?.pageToken||api?.nextPageToken;
   inventoryTruncated=!!pageToken;
   onCheck({check:'mapping_inventory_page',page:pages,rows:jobs.length,matching_jobs:[...matches.keys()].sort(),inventory_truncated:inventoryTruncated});
   if(!pageToken)break;
   if(seenTokens.has(pageToken))throw Error('Repeated inventory page token');seenTokens.add(pageToken);
  }
 }catch(e){inventoryFailure=clean(e);inventoryTruncated=true;}
 const jobs=[...matches.values()].sort((a,b)=>Number(a.metadata?.statistics?.creationTime||0)-Number(b.metadata?.statistics?.creationTime||0)||String(a.id).localeCompare(String(b.id)));
 onCheck({check:'mapping_exact_sql_inventory',pages,inventory_rows:inventoryRows,inventory_truncated:inventoryTruncated,inventory_failure:inventoryFailure,matching_jobs:jobs.map(j=>({job_id:j.id,state:j.metadata?.status?.state,created_ms:j.metadata?.statistics?.creationTime})),metadata_truncated:jobs.length>4});
 const errors=[];
 await Promise.allSettled(jobs.slice(0,4).map(async job=>{
  let result;
  try{
   if(Date.now()>=deadline)throw Error('Mapping metadata deadline');
   const [m]=await bounded(job.getMetadata());
   const error=e=>e?{reason:e.reason,location:e.location,message:clean(e.message)}:null;
   result={check:'mapping_retained_error',status:'read_completed',job_id:job.id,state:m.status?.state,error_result:error(m.status?.errorResult),errors:(m.status?.errors||[]).slice(0,10).map(error),script_statistics:m.statistics?.scriptStatistics||null};
  }catch(e){result={check:'mapping_retained_error',status:'unavailable',job_id:job.id,message:clean(e)};}
  errors.push(result);onCheck(result);
 }));
 if(!jobs.length)onCheck({check:'mapping_retained_error',status:'unresolved',reason:inventoryTruncated?'bounded_inventory_incomplete_no_absence_conclusion':'no_exact_sql_match_in_exhausted_four_minute_inventory_no_global_absence_conclusion'});
 return {read_only:true,queries_submitted:0,pages,inventory_truncated:inventoryTruncated,inventory_failure:inventoryFailure,metadata_truncated:jobs.length>4,errors,status:jobs.length&&!inventoryTruncated&&jobs.length<=4&&errors.every(e=>e.status==='read_completed')?'read_completed':'unresolved'};
}
