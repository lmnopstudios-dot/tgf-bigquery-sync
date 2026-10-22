import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runRetentionUnresolvedEvidence,retainedEvidenceSql,reconciliationSql,reconciliationReason,coverageProjection,INCIDENT} from '../diagnostics/oracle-retention-unresolved.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {safeReadFailure} from '../oracle/read-failure.js';
const options={project:'fixture',journeySql:customerJourneySql,parseSql:cohortRelations,safeReadFailure};
const base={collection_id:INCIDENT.collections[0],display_name:'Sammi',collaboration_name:'sammi',products:21,eligible_customers:1,historical_named_products:1,persisted_members:21,source_routes:4,historical_routed_products:3,unclassified_products:0,conflicting_products:0};
function fixture({failed=[],providerFailure=false}={}){
 const calls=[],metadata=[];
 const bigquery={dataset:dataset=>({getMetadata:async opts=>{metadata.push({dataset,...opts});if(failed.includes('metadata/'+dataset))throw Object.assign(Error('private credential@example.org'),{code:403});return [{location:'US'}];}}),job:(id,opts)=>({getMetadata:async more=>{metadata.push({id,...opts,...more});if(providerFailure)throw Object.assign(Error('private SQL'),{code:403});return [{configuration:{query:{query:'secret SQL'}},status:{state:'DONE',errorResult:{reason:'invalidQuery',message:'Unrecognized name: private@example.org at [123:45]'}}}];}}),query:async q=>{
  calls.push(q);assert.equal(q.location,'US');assert.ok(q.jobTimeoutMs<=10000);assert.equal(q.useLegacySql,false);assert.equal(q.autoPaginate,false);
  assert.doesNotMatch(q.query,/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|COMMIT|BEGIN|DROP)\b/i);
  if(q.query.includes('WITH saved AS')){
   if(failed.includes('retained'))throw Object.assign(Error('private SQL'),{code:403});
   return [[{job_id:INCIDENT.job,status:'completed',entry_start:INCIDENT.start,entry_end:INCIDENT.end,observation_end:INCIDENT.end,baseline_outcomes:[{state:'rejected',stage:'population_query',query_id:'retained-shopify-job',code:'COHORT_RETRIEVAL_FAILED',http_status:400,bigquery_reason:'invalidQuery'}],displayed_names:['emily_malice'],stored_followup:[{source_store:'shopify',status:'unverified',start_date:null,end_date:null,evidence:'private@example.org'}]}]];
  }
  if(q.query.includes('INFORMATION_SCHEMA.COLUMNS')){
   if(q.query.includes('shopify_data')&&failed.includes('coverage'))throw Object.assign(Error('private SQL'),{code:403});
   if(!q.query.includes('customer_identity'))return [[]];
   const fields={history_progress:['source','adapter','revision','complete','updated_at'],identity_snapshots:['snapshot_id','state','start_date','end_date','mapping_count'],followup_coverage:['source_store','start_date','end_date','time_zone','status','evidence','email']};
   return [Object.entries(fields).flatMap(([table_name,names])=>names.map(column_name=>({table_name,column_name,data_type:'STRING'})))];
  }
  if(q.query.includes('diagnostic_targets AS')){if(failed.includes(q.params.diagnostic_store))throw Object.assign(Error('private SQL'),{code:400,errors:[{reason:'resourcesExceeded'}]});return [[{...base}]];}
  if(q.query.includes('.history_progress`'))return [[{source:'ww',adapter:'metorik_orders',revision:'history-20261021-billing-v3',complete:true}]];
  if(q.query.includes('.identity_snapshots`'))return [[{snapshot_id:INCIDENT.snapshot,state:'ready',start_date:'1900-01-01',end_date:INCIDENT.end,mapping_count:58465}]];
  if(q.query.includes('.followup_coverage`'))return [[{store:'ww',start:'2022-01-01',end:INCIDENT.end,zone:'Europe/London',status:'verified_continuous',evidence:'private@example.org'}]];
  throw Error('Unexpected query');
 }};return {bigquery,calls,metadata};
}

test('targeted diagnostic reads exact retained outcome, metadata, existing records and independent source aggregates',async()=>{
 const f=fixture(),r=await runRetentionUnresolvedEvidence({...options,...f});
 assert.equal(r.read_only,true);assert.equal(r.report_replayed,false);assert.ok(r.bounds.queries<=15);
 assert.equal(f.calls.filter(c=>c.query.includes('diagnostic_targets AS')).length,3);
 const saved=f.calls.find(c=>c.query.includes('WITH saved AS'));assert.equal(saved.params.request_id,INCIDENT.request);assert.equal(saved.params.job_id,INCIDENT.job);
 const outcome=r.checks.find(c=>c.check==='retained_shopify_baseline');assert.equal(outcome.provider_metadata.failure.error_category,'schema_field_missing');assert.deepEqual(outcome.provider_metadata.failure.statement_location,{line:123,column:45});
 assert.deepEqual(f.metadata.find(m=>m.id),{id:'retained-shopify-job',location:'US',maxRetries:0});
 assert.equal(r.checks.filter(c=>c.check.startsWith('absent_collections/')&&c.status==='partial').length,3);
 assert.doesNotMatch(JSON.stringify(r),/private@example|secret SQL|configuration|"customer_id":|owner_key/);
 assert.ok(f.calls.filter(c=>c.query.includes('INFORMATION_SCHEMA')).every(c=>c.query.includes('LIMIT 501')));
 assert.ok(f.calls.filter(c=>c.query.includes('history_progress`')).every(c=>c.query.includes('history-20261021-billing-v3')));
 assert.ok(f.calls.find(c=>c.query.includes('followup_coverage`')).query.includes('CAST(`evidence` AS STRING) evidence'));
 assert.doesNotMatch(f.calls.find(c=>c.query.includes('followup_coverage`')).query,/`email`/);
});

test('retained lookup, one coverage inventory and one source failure never suppress successful independent results',async()=>{
 const f=fixture({failed:['retained','coverage','usd']}),r=await runRetentionUnresolvedEvidence({...options,...f});
 for(const key of ['retained_shopify_baseline','coverage_inventory/shopify_data','absent_collections/usd'])assert.equal(r.checks.find(c=>c.check===key).status,'unavailable');
 for(const key of ['absent_collections/ww','absent_collections/shopify'])assert.equal(r.checks.find(c=>c.check===key).status,'partial');assert.equal(r.checks.find(c=>c.check==='coverage_records/customer_identity/followup_coverage').status,'read_completed');
 assert.ok(!f.metadata.some(m=>m.id));
});

test('provider metadata failure preserves the retained error fields',async()=>{
 const f=fixture({providerFailure:true}),r=await runRetentionUnresolvedEvidence({...options,...f});
 const c=r.checks.find(c=>c.check==='retained_shopify_baseline');assert.equal(c.status,'read_completed');assert.equal(c.baseline_outcomes[0].bigquery_reason,'invalidQuery');assert.equal(c.provider_metadata.status,'unavailable');
});

test('aggregate query uses deployed linked sequencing and governed routes with no windows, retention outputs or identity fallback',()=>{
 for(const [platform,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']]){
  const sql=reconciliationSql('fixture',platform,store,customerJourneySql,cohortRelations);
  assert.match(sql,/history-20261022-billing-v3/);assert.match(sql,/Identity snapshot integrity failed/);assert.match(sql,/NOT migrated AND NOT cancelled/);assert.match(sql,/order_sequence=1/);assert.match(sql,/cr_routes/);assert.match(sql,/g.collection_id IN UNNEST\(@collection_ids\)/);
  assert.doesNotMatch(sql,/retention_members|retention_totals|median_days|days_to_second|window_days|PERCENTILE/);
  const parameters=[...sql.matchAll(/@([a-z_]+)/g)].map(m=>m[1]);
  assert.ok(parameters.every(p=>['collection_ids','diagnostic_store','source_prefix','cohort_entry_start','cohort_entry_end','observation_end','time_zone','first_order_semantic','entry_source','entry_channel','entry_classification','entry_product_ref','matrixify_app_id'].includes(p)),[...new Set(parameters)].join(','));
 }
 assert.throws(()=>retainedEvidenceSql('fixture','commerce;DROP','table'),/Invalid/);
 assert.deepEqual(coverageProjection(['email','customer_id','source_store','start_date','end_date']),['CAST(`source_store` AS STRING) store','CAST(`start_date` AS STRING) start','CAST(`end_date` AS STRING) end']);
});

test('reason labels distinguish present eligibility from unproven historical truncation',()=>{
 assert.equal(reconciliationReason(base),'eligible_now_check_retained_omission');
 assert.equal(reconciliationReason({...base,eligible_customers:0}),'no_eligible_first_purchase_customers_in_current_read');
 assert.equal(reconciliationReason({...base,products:0}),'no_current_products');
 assert.equal(reconciliationReason({...base,eligible_customers:0,historical_named_products:0,source_routes:0}),'governed_source_product_mapping_missing');
 assert.equal(reconciliationReason({...base,eligible_customers:0,historical_named_products:0,unclassified_products:1}),'historical_classification_absent_or_conflicting');
});

test('expired shared deadline submits no warehouse query and records independent failures',async()=>{
 const f=fixture(),r=await runRetentionUnresolvedEvidence({...options,...f,maximumMs:0});
 assert.equal(f.calls.length,0);assert.equal(f.metadata.length,0);assert.ok(r.checks.some(c=>c.check==='retained_shopify_baseline'&&c.failure.diagnostic_code==='DIAGNOSTIC_DEADLINE'));
});

test('diagnostic module can load from memory without repository or package imports',async()=>{
 const source=readFileSync(new URL('../diagnostics/oracle-retention-unresolved.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/^import\s/m);
 const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 assert.equal(typeof module.runRetentionUnresolvedEvidence,'function');
});

test('current governed aliases are compared to retained names rather than assumed absent from incident target IDs',async()=>{
 const f=fixture(),query=f.bigquery.query;
 f.bigquery.query=async q=>{const result=await query(q);if(q.query.includes('WITH saved AS'))result[0][0].displayed_names=['sammi'];return result;};
 const r=await runRetentionUnresolvedEvidence({...options,...f});
 for(const c of r.checks.filter(c=>c.check.startsWith('absent_collections/'))){assert.equal(c.results[0].retained_name_displayed,true);assert.equal(c.results[0].reason,'governed_name_already_in_retained_report');}
});


test('incompatible deployed SQL cannot silently return unlinked reconciliation populations',()=>{
 assert.throws(()=>reconciliationSql('fixture','woo','ww',(p,g,s,t)=>customerJourneySql(p,g,s,t,null),cohortRelations),/frozen order-snapshot guard/);
});
