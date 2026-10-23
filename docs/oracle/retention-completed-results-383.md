# #383 completed diagnostics: retained result retrieval

**Preserved:** the user confirms the successful trace results need no further denominator diagnostic. The active task is now [historical Woo collaboration listing discovery](retention-woo-collaboration-discovery.md), including Iron Maiden archived/Ready-to-Ship/size records. Do not repeat the trace/result discovery below for that task.

Both budget-corrected checks completed successfully using artifact `1f90f178e2a44ee591edc17bbb262862a0957b57`, deployed dependencies at `c22df6162b9e1abdd29c8e628cdaab045496961b`. The supplied paste ends with both `completed:true`, but starts midway through the mapping array: it contains neither allocated job IDs nor trace rows. It retains only 115 complete low-impact mapping rows (12–19 customers each), all without supported target candidates. Those unrelated/unattributed products must not be presented as collaboration relationships inferred from their titles.

The complete catalogue portion does establish:

| Collaboration | Woo WW approved routes / historical named products | Woo USD approved routes / historical named products | Shopify named entry customers |
|---|---:|---:|---:|
| Motörhead | 0 / 0 | 0 / 0 | 51 |
| Iron Maiden | 0 / 0 | 0 / 0 | 17 |

Both Woo source rows have unknown eligibility, not verified zero historical sales. The mapping audit reports zero `resolved_classification_not_consumed` products among the resolved named products it sees (WW: 12; USD: 6). That supports consumption of those resolved classifications; it does not prove completeness of every historical identity/family route.

A 360-day denominator requires a first-observed entry on or before **2025-10-24** in London. Product-range age is not the entry date. Current named attribution for these two ranges comes exclusively from Shopify; earlier supplied history endpoints put Shopify observations from 2025-11-16. This explains why the current attributed cohorts can have no age-qualified 360-day entries even with three observed 360-day repeats each. The missing Woo routes prevent older Woo purchases from acquiring these names through approved routes. This does not establish that those purchases never happened or identify which new links are valid. The exact dates, excluded-order counts and earlier-other-entry losses still require the completed trace envelope; they are not fabricated from the catalogue.

The mapping review pool has 1,340 products and `review_truncated:true`; the existing diagnostic returns only its highest-impact 500 plus a sentinel. The supplied paste omits the start of that slice. A complete prioritised collaboration review list cannot be reconstructed from this tail. Even the retained full slice cannot establish the contents of the remaining 840 products. The read below emits only rows with supported named-collaboration evidence, ordered by affected customer/order count, and discloses the original bound. Unclassified products are not assumed to be collaborations.

Direct development access to existing BigQuery job metadata remains OAuth-blocked (403 `Domain forbidden`). The following command reads completed jobs/results only. It submits **zero queries**, repeats neither error discovery nor control reads, and never recreates an expired result.

## One bounded completed-result read

Run in deployed `src`. Job selection requires the exact reviewed SQL, corrected whole-job cap, US location and successful DONE state. Inventory is bounded to the last 24 hours, ten pages of 100 jobs and a 20-second deadline. It emits all matching job IDs before reading up to the two newest successful executions per component (creation time/job ID order), with explicit remaining-job and inventory bounds. This is discovery of the newly completed result jobs, not repetition of historical failed-job discovery. Each result remains independent if another read fails. Result retrieval has a 15-second bound per selected existing job; no query allocation method is called.

```bash
timeout --signal=TERM --kill-after=5s 65s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
const emit=x=>console.log(JSON.stringify({queries_submitted:0,report_replayed:false,persistent_writes:false,...x}));
const clean=x=>String(x?.message||x||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,2000);
const bound=async(p,ms)=>{let t;try{return await Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('Retained read deadline')),Math.max(1,ms));})]);}finally{clearTimeout(t);}};
const date=x=>x?.value??x??null;
const brief=r=>({stage:r.stage,orders:r.observed_orders,customers:r.eligible_linked_customers,purchase_from:date(r.earliest_purchase_date),purchase_to:date(r.latest_purchase_date),entry_from:date(r.earliest_first_observed_entry_date),entry_to:date(r.latest_first_observed_entry_date)});
try {
 const revision='1f90f178e2a44ee591edc17bbb262862a0957b57';
 const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-mapping-coverage.json.gz`,{signal:AbortSignal.timeout(8000),redirect:'error'});assert.ok(response.ok);
 const parts=[];let size=0;for await(const part of response.body){size+=part.length;assert.ok(size<=262144);parts.push(part);}
 const bytes=Buffer.concat(parts);assert.equal(createHash('sha256').update(bytes).digest('hex'),'7a03e54e919372e303b8e882c025cdb3c26fe81d3fdf68743c7650d1df2a1234');
 const artifact=JSON.parse(gunzipSync(bytes,{maxOutputLength:4194304}));
 const {project,credentials}=loadBigQueryConfig();assert.equal(project,'gf-full-data');
 const bq=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 const kinds=['mapping_settings','trace_settings'],found=new Map(),end=Date.now(),deadline=end+20000,seen=new Set();
 let token,pages=0,truncated=true,inventory_error=null;
 try {
  do {
   const [jobs,next,api]=await bound(bq.getJobs({allUsers:false,projection:'full',stateFilter:'done',autoPaginate:false,maxResults:100,minCreationTime:end-86400000,maxCreationTime:end,...(token?{pageToken:token}:{})}),deadline-Date.now());pages++;
   for(const job of jobs){const m=job.metadata||{};if(m.jobReference?.location!=='US'||(m.status?.state||m.state)!=='DONE'||m.status?.errorResult||m.errorResult)continue;
    const kind=kinds.find(k=>m.configuration?.query?.query===artifact[k].query&&String(m.configuration?.query?.maximumBytesBilled)===artifact[k].maximumBytesBilled);
    if(kind)found.set(job.id,{job,kind,created:Number(m.statistics?.creationTime)||0});
   }
   token=next?.pageToken||api?.nextPageToken;truncated=!!token;
   if(token){assert.ok(!seen.has(token),'Repeated inventory token');seen.add(token);}
  }while(token&&pages<10&&Date.now()<deadline);
 }catch(e){inventory_error=clean(e);truncated=true;}
 const inventory=[...found.values()].sort((a,b)=>b.created-a.created||String(a.job.id).localeCompare(String(b.job.id)));
 emit({check:'completed_result_inventory',artifact_revision:revision,pages,inventory_truncated:truncated,inventory_error,window_from_ms:end-86400000,window_to_ms:end,jobs:inventory.map(x=>({kind:x.kind,job_id:x.job.id,created_ms:x.created}))});
 const selected=kinds.flatMap(kind=>inventory.filter(x=>x.kind===kind).slice(0,2));
 for(const kind of kinds)if(!selected.some(x=>x.kind===kind)){emit({check:kind,status:'unavailable',reason:'no_successful_exact_match_in_bounded_inventory_no_absence_conclusion'});process.exitCode=1;}
 emit({check:'result_read_selection',selection:'newest_two_per_component',selected: selected.map(x=>({kind:x.kind,job_id:x.job.id})),unread_matching_jobs:inventory.length-selected.length});
 await Promise.allSettled(selected.map(async({job,kind})=>{
  try {
   const [metadata]=await bound(job.getMetadata(),5000);assert.equal(metadata.status?.state,'DONE');assert.ok(!metadata.status?.errorResult);
   assert.equal(metadata.configuration?.query?.query,artifact[kind].query);assert.equal(String(metadata.configuration?.query?.maximumBytesBilled),artifact[kind].maximumBytesBilled);
   const [rows,next]=await bound(job.getQueryResults({autoPaginate:false,maxResults:1,timeoutMs:10000}),15000);assert.equal(rows.length,1);assert.ok(!next,'Unexpected additional envelope rows');const r=rows[0];
   if(kind==='trace_settings'){
    assert.equal(r.targets?.length,2);assert.equal(r.stage_counts?.length,208);
    for(const t of r.targets)emit({check:'retained_entry_age_trace',status:'read_completed',job_id:job.id,collection:t.display_name,collection_id:t.collection_id,combined_stages:r.stage_counts.filter(x=>x.collection_id===t.collection_id&&x.source_store==='combined').map(brief),entry_platforms:r.stage_counts.filter(x=>x.collection_id===t.collection_id&&x.source_store!=='combined'&&['governed_product_history','consumed_named_history','eligible_named_purchases','earlier_entry_other_order','first_observed_before_scope','entry_collaboration_members','age_qualified_360','observed_repeat_360'].includes(x.stage)).map(x=>({source:x.source_store,...brief(x)})),woo_products:(r.product_routes||[]).filter(x=>x.collection_id===t.collection_id&&x.source_store!=='shopify').slice(0,200),product_inventory_truncated:(r.product_routes||[]).length>200||Number(r.product_routes?.[0]?.total_product_rows)>200});
   }else{
    assert.ok(Array.isArray(r.review_rows));const review=r.review_rows.slice(0,500);
    const supported=review.filter(x=>x.named_classification_consumed||(x.candidates||[]).some(c=>(c.governed_collaborations||[]).some(n=>!['collaboration','collaborations'].includes(n)))).sort((a,b)=>Number(b.affected_customers)-Number(a.affected_customers)||Number(b.affected_orders)-Number(a.affected_orders)||a.source_product_ref.localeCompare(b.source_product_ref));
    emit({check:'retained_collaboration_mapping_review',status:'read_completed',job_id:job.id,total_review_products:r.review_rows[0]?.total_review_products??0,retained_review_rows:review.length,review_truncated:r.review_rows.length>500||Number(r.review_rows[0]?.total_review_products)>500,unattributed_rows_not_assumed_collaborations:review.length-supported.length,route_consumption:r.route_consumption,items:supported.map(x=>({...x,proposed_target:x.candidates?.length===1?x.candidates[0].product_ref:null,supporting_evidence:'Persisted normalized SKU and governed target name; existing graph preview/review still required. Directly named rows without candidates need product-key evidence.',conflicts:[...(x.classification_conflicts||[]),...(x.candidates?.length>1?['Multiple supported target candidates']:[]),...(x.candidates?.length===1&&(x.approved_routes||[]).some(a=>a.target_ref!==x.candidates[0].product_ref)?['Approved route differs from SKU candidate; inspect graph semantics']:[])]})),catalogue_already_supplied_entries:r.catalogue?.length});
   }
  }catch(e){emit({check:kind,job_id:job.id,status:'unavailable',message:clean(e),result_not_recreated:true});process.exitCode=1;}
 }));
 if(truncated||inventory.length>selected.length)process.exitCode=1;
}catch(e){emit({status:'unavailable',message:clean(e)});process.exitCode=1;}
JS
```

This retrieval cannot recover products omitted by the original 500-row mapping bound. No new diagnostic query, collection, snapshot change, governance decision or production-data write is authorised or performed by it.
