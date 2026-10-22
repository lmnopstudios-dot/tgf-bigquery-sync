// Standalone: paste this file into `timeout --signal=TERM --kill-after=5s 95s
// node --input-type=module <<'NODE' ... NODE` from the existing Render app root.
// Installed SDK only; no setup, deployment, repository imports or source reads.
import {BigQuery} from '@google-cloud/bigquery';
const snapshot='history-20261022-billing-v3',revision='history-20261020-v2';
const dataset='customer_identity';
let active,stopped=false;
const deadline=Date.now()+85000;
const stop=()=>{stopped=true;active?.cancel({maxRetries:0}).catch(()=>{});};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
const timer=setTimeout(()=>{stop();console.error(JSON.stringify({read_only:true,status:'deadline',evidence_complete:false}));process.exit(2);},90000);
const owned=()=>{if(stopped||Date.now()>=deadline)throw Error('bounded_stop');};
const bounded=async work=>{
  owned();let timer;
  try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('bounded_stop')),Math.max(1,deadline-Date.now()));})]);}
  finally{clearTimeout(timer);}
};
const safeError=e=>({status:'unavailable',http_status:[400,401,403,404,408,429,500,502,503,504].includes(Number(e?.code))?Number(e.code):null});
try{
  // Never print config, error messages, query settings or job objects.
  const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
  const project=process.env.GOOGLE_PROJECT_ID||credentials?.project_id||'gf-full-data';
  if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('configuration');
  const bq=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  const ds=bq.dataset(dataset);
  const [metadata]=await bounded(()=>ds.getMetadata());
  const location=metadata.location;
  if(!/^[A-Za-z0-9-]+$/.test(location||''))throw Error('location');
  const fields=['snapshot_id','source_store','source_order_id','source_customer_id','canonical_customer_ref','resolution','financial_status','cancelled','conflicting_email','shared_email'];
  const [linkSchema]=await bounded(()=>ds.table('identity_order_links').getMetadata());
  const [markerSchema]=await bounded(()=>ds.table('identity_snapshots').getMetadata());
  const same=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
  if(!same(fields,linkSchema.schema.fields.map(x=>x.name))||!same(['snapshot_id','state','start_date','end_date','mapping_count','created_at'],markerSchema.schema.fields.map(x=>x.name)))throw Error('schema');
  const t=name=>'`'+project+'.'+dataset+'.'+name+'`';
  const query=async sql=>{
    owned();
    const [job]=await bounded(()=>bq.createQueryJob({query:sql,location,params:{snapshot},maximumBytesBilled:'1000000000',jobTimeoutMs:Math.min(60000,deadline-Date.now()),useLegacySql:false,labels:{component:'history_diagnostic',operation:'read_only'}}));
    active=job;let rows=[],next={},response;
    do{
      const [page,continuation,meta]=await bounded(()=>job.getQueryResults({...next,autoPaginate:false,maxResults:202,timeoutMs:1000}));
      owned();response=meta;
      if(meta?.jobComplete!==false)rows.push(...page);
      if(rows.length>201)throw Error('output_bound');
      next=continuation;
    }while(next||response?.jobComplete===false);
    active=null;return rows;
  };
  const [evidence]=await query(`WITH markers AS (SELECT * FROM ${t('identity_snapshots')} WHERE snapshot_id=@snapshot),
    links AS (SELECT * FROM ${t('identity_order_links')} WHERE snapshot_id=@snapshot),
    keys AS (SELECT source_store,source_order_id,COUNT(*) copies,
      COUNT(DISTINCT TO_JSON_STRING(STRUCT(source_customer_id,canonical_customer_ref,resolution,financial_status,cancelled,conflicting_email,shared_email))) variants
      FROM links GROUP BY source_store,source_order_id),
    sources AS (SELECT source_store,COUNT(*) total_rows,COUNT(DISTINCT TO_JSON_STRING(STRUCT(source_store,source_order_id))) distinct_keys,
      COUNTIF(resolution='matched') matched_rows,COUNTIF(resolution='unmatched') unmatched_rows,COUNTIF(resolution='ambiguous') ambiguous_rows,COUNTIF(resolution='unavailable') unavailable_rows
      FROM links GROUP BY source_store)
    SELECT (SELECT COUNT(*) FROM markers) marker_count,
      (SELECT COUNT(DISTINCT TO_JSON_STRING(STRUCT(state,start_date,end_date,mapping_count))) FROM markers) marker_metadata_variants,
      (SELECT COUNT(DISTINCT TO_JSON_STRING(STRUCT(state,start_date,end_date,mapping_count,created_at))) FROM markers) marker_full_row_variants,
      (SELECT MIN(created_at) FROM markers) earliest_created_at,(SELECT MAX(created_at) FROM markers) latest_created_at,
      (SELECT COUNTIF(state='ready' AND start_date=DATE '1900-01-01' AND end_date=DATE '2026-10-19' AND mapping_count=58465) FROM markers) intended_metadata_markers,
      (SELECT COUNT(*) FROM links) total_link_rows,(SELECT COUNT(*) FROM keys) distinct_order_keys,
      (SELECT COUNTIF(copies>1) FROM keys) duplicate_key_count,
      (SELECT COALESCE(SUM(copies-1),0) FROM keys) excess_link_rows,
      (SELECT COUNTIF(copies>1 AND variants=1) FROM keys) identical_duplicate_keys,
      (SELECT COUNTIF(copies>1 AND variants>1) FROM keys) conflicting_duplicate_keys,
      (SELECT COUNTIF(source_store IS NULL OR source_store NOT IN ('ww','usd','shopify') OR source_order_id IS NULL OR source_order_id='' OR canonical_customer_ref IS NULL OR NOT REGEXP_CONTAINS(canonical_customer_ref,r'^c_[A-Fa-f0-9]{64}$')) FROM links) invalid_mapping_keys,
      ARRAY(SELECT AS STRUCT IF(source_store IN ('ww','usd','shopify'),source_store,'other_or_null') source,total_rows,distinct_keys,matched_rows,unmatched_rows,ambiguous_rows,unavailable_rows FROM sources ORDER BY source_store) sources`);
  console.log(JSON.stringify({read_only:true,status:'snapshot_evidence',evidence}));
  // Bounded job inspection is separate: lack of listAll/get permissions must not
  // conceal successful snapshot aggregates. Raw text/params stay in memory only.
  try{
    const jobs=await query(`SELECT job_id,parent_job_id,statement_type,transaction_id,start_time,end_time,state,error_result IS NULL successful
      FROM \`${project}.region-${location.toLowerCase()}.INFORMATION_SCHEMA.JOBS_BY_PROJECT\`
      WHERE creation_time BETWEEN TIMESTAMP '2026-10-22 07:25:00+00' AND TIMESTAMP '2026-10-22 07:40:00+00'
      AND job_type='QUERY' AND (parent_job_id IS NOT NULL OR (query LIKE '%identity_order_links%' AND query LIKE '%identity_snapshots%'))
      ORDER BY creation_time LIMIT 201`);
    if(jobs.length>200)throw Error('metadata_bound');
    const parents=jobs.filter(j=>!j.parent_job_id);
    if(parents.length>20)throw Error('metadata_bound');
    const scoped=[];
    for(const parent of parents){
      const [m]=await bounded(()=>bq.job(parent.job_id,{location}).getMetadata({maxRetries:0}));
      const parameters=m.configuration?.query?.queryParameters||[];
      const param=name=>parameters.find(p=>p.name===name)?.parameterValue?.value;
      if(param('snapshot')===snapshot&&param('revision')===revision)scoped.push(parent);
    }
    const timestamp=x=>Date.parse(x?.value||x);
    let overlappingSuccessfulTransactions=0;
    const committed=[];
    for(const parent of scoped){
      const children=jobs.filter(j=>j.parent_job_id===parent.job_id);
      const begin=children.find(j=>j.statement_type==='BEGIN_TRANSACTION'&&j.successful&&j.state==='DONE');
      const commit=children.find(j=>j.statement_type==='COMMIT_TRANSACTION'&&j.successful&&j.state==='DONE');
      if(parent.successful&&parent.state==='DONE'&&begin&&commit&&commit.transaction_id&&begin.transaction_id===commit.transaction_id&&Number.isFinite(timestamp(begin.end_time))&&Number.isFinite(timestamp(commit.start_time)))
        committed.push({id:commit.transaction_id,start:timestamp(begin.end_time),end:timestamp(commit.start_time)});
    }
    for(let i=0;i<committed.length;i++)for(let j=i+1;j<committed.length;j++)if(committed[i].id!==committed[j].id&&Math.max(committed[i].start,committed[j].start)<Math.min(committed[i].end,committed[j].end))overlappingSuccessfulTransactions++;
    console.log(JSON.stringify({read_only:true,status:'job_evidence',candidate_parent_jobs:parents.length,target_parent_jobs:scoped.length,target_successful_parent_jobs:scoped.filter(j=>j.successful&&j.state==='DONE').length,verified_committed_transactions:committed.length,overlapping_successful_transaction_pairs:overlappingSuccessfulTransactions,proves_overlapping_successful_transactions:overlappingSuccessfulTransactions>0,limitation:'Zero is inconclusive: bounded interval, metadata access, retention and child visibility may exclude evidence. Overlap does not independently prove which rows each transaction inserted.'}));
  }catch(e){console.log(JSON.stringify({read_only:true,job_evidence:safeError(e),proves_overlapping_successful_transactions:false}));}
}catch(e){stop();console.error(JSON.stringify({read_only:true,evidence_complete:false,...safeError(e)}));process.exitCode=2;}
finally{clearTimeout(timer);process.off('SIGTERM',stop);process.off('SIGINT',stop);}
