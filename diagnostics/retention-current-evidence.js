// Exact retained evidence only. getQueryResults reads an existing job; it never
// creates/replays a report. No result/customer payload is printed.
export async function readCurrentRankingFailure({bigquery,project,dataset='commerce',validateRows}){
 for(const id of [project,dataset])if(!/^[A-Za-z0-9_-]+$/.test(id))throw Error('Invalid identifier');
 const [rows]=await bigquery.query({query:`SELECT job_id,status,attempts,created_at,updated_at,JSON_VALUE(lifecycle_json,'$.execution_revision') execution_revision,TO_JSON_STRING(result_json) retained_result,COUNT(*) OVER() matching_rows FROM \`${project}.${dataset}.oracle_analysis_jobs_v1\` WHERE request_id=@request_id ORDER BY created_at,job_id,attempts,updated_at LIMIT 5`,params:{request_id:'cf531490-b044-4ddd-b2fe-818a3ab91406'},location:'US',jobTimeoutMs:10000,maximumBytesBilled:'1000000000',autoPaginate:false,maxResults:5});
 const inventory=rows.map(({retained_result,...r})=>r);console.log(JSON.stringify({check:'exact_request_inventory',read_only:true,inventory,truncated:rows.length>4}));
 const checks=[];
 for(const row of rows.slice(0,4)){
  let e=row.retained_result;for(let i=0;i<8;i++){if(typeof e==='string'){e=JSON.parse(e);continue;}if(e?.evidence){e=e.evidence;break;}if(e?.result){e=e.result;continue;}break;}
  const outcomes=(e?.section_outcomes||[]).filter(o=>o.source_platform==='shopify'&&o.component==='product_ranking_rows');
  for(const outcome of outcomes.slice(0,2)){
   const record={job_id:row.job_id,execution_revision:row.execution_revision,section_outcome:outcome};
   try{
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(outcome.query_id||''))throw Error('Original warehouse job ID unavailable; no replay permitted');
    const job=bigquery.job(outcome.query_id,{location:'US'});const [meta]=await job.getMetadata();
    if(meta.status?.state!=='DONE'||meta.status?.errorResult)throw Error('Original query not successful');
    const [result]=await job.getQueryResults({maxResults:1,autoPaginate:false,timeoutMs:10000});
    const ranking=result[0]?.product_ranking_rows;if(!Array.isArray(ranking)||ranking.length>90)throw Error('Original ranking result unavailable or bound exceeded');
    record.warehouse_status='completed';record.original_rows=ranking.length;
    record.rejections=[];
    ranking.forEach((r,index)=>{try{const [v]=validateRows([{...r,entry_product:r.entry_product_title}]);if(v.source_platform!=='shopify'||v.source_store!=='shopify'||!v.entry_product_ref||!Number.isInteger(v.count_rank)||v.count_rank<1||v.rate_rank!=null&&(!Number.isInteger(v.rate_rank)||v.rate_rank<1)||v.provisional_rate_rank!=null&&(!Number.isInteger(v.provisional_rate_rank)||v.provisional_rate_rank<1||v.provisional_repeat_rate==null))throw Error('Invalid retention section');}catch(error){record.rejections.push({row:index,rejection:error.message,window_days:r.window_days,provisional_rate_rank:r.provisional_rate_rank,provisional_eligible_customers:r.provisional_eligible_customers,provisional_repeat_rate:r.provisional_repeat_rate});}});
    record.retained_row_validation=record.rejections.length?'rejected':'passed';
   }catch(error){record.read_status='unavailable';record.reason=String(error.message).slice(0,250);}
   checks.push(record);
  }
 }
 return {check:'retained_shopify_ranking',read_only:true,report_replayed:false,checks};
}
