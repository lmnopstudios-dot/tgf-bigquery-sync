import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import {retentionEvents} from './helpers/retention-events.js';
import {cohortRelations,decomposedCohortSql} from '../oracle/cohort-execution.js';
import {customerJourneySql,validateJourneyDefinition,CUSTOMER_JOURNEY_TOOL_DEFINITION} from '../oracle/customer-journey.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
import {answerCohortRetention} from '../oracle/cohort-retention.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {createBigQueryAnalysisJobStore} from '../oracle/analysis-jobs.js';
import {loadOracleJobReadinessConfig} from '../diagnostics/oracle-job-readiness.js';
import {inspectRetentionIncidentJobs} from '../diagnostics/oracle-retention-incident-jobs.js';

const INCIDENT_JOBS={ww:'fixture-ww-job',usd:'fixture-usd-job',shopify:'fixture-shopify-job'};
const question=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
const now=Date.parse('2026-10-22T12:00:00Z');
const identityEnv={ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture-order-email-v2'};
const identity={dataset:identityEnv.ORACLE_CUSTOMER_IDENTITY_DATASET,snapshot:identityEnv.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT,orderLinks:true};
const events=[...retentionEvents,...retentionEvents.filter(e=>['one','two'].includes(e.customer)).map(e=>({...e,source_store:'usd'}))];

test('all source/group SQL routes bind alias guards to input columns and preserve snapshot sequencing',()=>{
  for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']]){
    for(const group of ['retention_windows','retention_product_windows','retention_piece_windows','retention_baseline_windows','summary']){
      const sql=customerJourneySql('fixture',group,source,store,identity);
      const aliases=cohortRelations(sql).relations.find(r=>r.name==='ci_aliases').body;
      assert.match(aliases,/HAVING COUNT\(DISTINCT ci_mapping\.canonical_customer_ref\)=1/);
      assert.match(sql,/GROUP BY source_store,source_order_id HAVING COUNT\(\*\)>1/);
      assert.match(sql,/fixture-order-email-v2/);
      assert.match(sql,/LEFT JOIN ci_aliases a ON a.local_ref=q.governed_customer_ref/);
      assert.match(sql,/NOT migrated/);
      assert.match(sql,new RegExp("h.source_store='"+store+"'"));
      for(const table of ['metorik_uk.orders','metorik_us.orders','shopify_data.order_locations'])assert.ok(sql.includes(table));
      if(group.startsWith('retention_')){
        const script=decomposedCohortSql(sql);
        assert.match(script,/UNNEST\(\[90,180,360\]\)/);
        assert.match(script,/COUNT\(DISTINCT m.governed_customer_ref\) observed_customers/);
        assert.match(script,/LIMIT 10\) second_order_products/);
      }
    }
  }
  const legacy=customerJourneySql('fixture','summary',null,null,{...identity,orderLinks:false});
  assert.match(legacy,/HAVING COUNT\(DISTINCT links.canonical_customer_ref\)=1/);
});

for(const mode of ['direct','interactive','durable'])for(const partial of [false,true])test(`full retained-report scope, linked v2 and partial sources: ${mode}, partial=${partial}`,async t=>{
  const f=acceptanceFixture({retention_events:events,observationCertificates:[],identityEnv,now});
  if(partial)f.state.fail_retention_stores=['usd'];
  const h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
  const send=async(message,analysis_context)=>mode==='direct'?
    (await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,analysis_context})})).json()):h.submit(message);
  if(mode!=='direct')await send('Show online sales last month.');
  const r=await send(question);
  assert.equal(r.evidence.kind,'governed_cohort_retention');
  assert.equal(r.analysis_context.journey_group_by,'collaboration_piece');
  assert.deepEqual(r.evidence.periods,[{start_date:'2022-10-19',end_date:'2026-10-19'}]);
  assert.equal(r.evidence.observation_end,'2026-10-19');
  assert.equal(r.evidence.definition.time_zone,'Europe/London');
  assert.equal(r.evidence.ranking_window,90);
  assert.equal(r.evidence.source_outcomes.length,9);
  assert.deepEqual([...new Set(r.evidence.rows.map(x=>x.window_days))].sort((a,b)=>a-b),[90,180,360]);
  assert.ok(r.evidence.rows.some(x=>x.entry_product_ref));
  assert.ok(r.evidence.rows.some(x=>x.entry_product_ref&&x.collaboration_name===null));
  assert.ok(r.evidence.rows.some(x=>!x.entry_product_ref));
  assert.ok(r.evidence.baseline_rows.length>0);
  for(const row of [...r.evidence.rows,...r.evidence.baseline_rows]){
    assert.equal(row.observation_coverage_status,'unverified');
    assert.equal(row.mature_customers,0);assert.equal(row.repeat_rate,null);
    assert.ok(Array.isArray(row.second_order_products));
    const baseline=r.evidence.baseline_rows.find(b=>b.source_store===row.source_store&&b.window_days===row.window_days);
    assert.ok(baseline.cohort_customers>=row.cohort_customers);
  }
  assert.ok(r.evidence.rows.some(x=>x.second_order_products.length));
  assert.ok(r.evidence.coverage.identity_activation.every(x=>x.activation==='active'&&x.configured_mode==='email_candidate_v2'&&x.snapshot===identityEnv.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT));
  assert.match(r.answer,/360-day rate/);assert.match(r.answer,/Comparable sitewide/);assert.match(r.answer,/Second-order products/);assert.match(r.answer,/\(360 days\)/);
  assert.match(r.answer,/email-linked records/);assert.ok([...r.evidence.rows,...r.evidence.baseline_rows].every(row=>row.repeat_rate===null));assert.ok(r.evidence.rows.some(row=>row.provisional_repeat_rate!=null));assert.doesNotMatch(r.answer,/customer linkage has not been verified/);
  if(partial){assert.ok(r.evidence.source_outcomes.filter(x=>x.source_store==='usd').every(x=>x.state==='rejected'));assert.ok(!r.evidence.rows.some(x=>x.source_store==='usd'));}
  assert.equal(deliverOracleResult(structuredClone(r),r.analysis_context).delivery.status,'partial');
  const provisionalCorrupt=structuredClone(r);provisionalCorrupt.evidence.rows[0].provisional_repeat_rate=1.1;assert.equal(deliverOracleResult(provisionalCorrupt,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
  const corrupt=structuredClone(r);corrupt.evidence.baseline_rows[0].repeat_rate=.5;
  assert.equal(deliverOracleResult(corrupt,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
  const missingWindow=structuredClone(r);missingWindow.evidence.rows=missingWindow.evidence.rows.filter(x=>x.window_days!==360);
  assert.equal(deliverOracleResult(missingWindow,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
  if(mode==='durable'){
    const calls=f.wireQueries.length,recovered=await h.get('/jobs/'+r.job_id);
    assert.deepEqual(recovered.evidence,r.evidence);assert.equal(f.wireQueries.length,calls);
  }
  const follow=await send('Rank primarily by 360-day repeat-purchase rate.',r.analysis_context);
  assert.equal(follow.evidence.ranking_window,360);
  assert.equal(follow.analysis_context.retention_baseline,true);
  assert.equal(follow.analysis_context.retention_second_products,true);
  const sales=transitionAnalysisContext(follow.analysis_context,'New question: show online sales last month.',{now}).context;
  assert.equal(sales.retention_windows,null);assert.equal(sales.retention_baseline,false);
});

test('active v2 provider errors retain linkage provenance, exact locations and query IDs without replay',async()=>{
  const calls=[];
  // Use readiness answers from the shared fixture and fail only allocated population jobs.
  const bq={query:async q=>{
    calls.push(q);
    if(q.query.startsWith('SELECT state,start_date,end_date,mapping_count'))return [[{state:'ready',start_date:'1900-01-01',end_date:'2026-10-19',mapping_count:3}]];
    if(q.query.includes('unmatched_profiles'))return [[...['ww','usd','shopify'].map(source_store=>({source_store,identified_profiles:1,mapped_profiles:1,unmatched_profiles:0,qualifying_orders:1,matched_orders:1,unmatched_orders:0,ambiguous_orders:0,unavailable_orders:0,email_linked_guest_or_unknown_records:0,conflicting_orders:0,shared_address_orders:0}))]];
    return [[]];
  }};
  bq.createQueryJob=async q=>{
    if(!q.query.includes('retention_members'))return [{getQueryResults:async()=>[...(await bq.query(q)),null,{jobComplete:true}]}];
    calls.push(q);const store=q.query.match(/WHERE source_store='(ww|usd|shopify)' AND order_sequence=1/)?.[1];
    return [{id:INCIDENT_JOBS[store],cancel:async()=>{},getMetadata:async()=>[{status:{state:'DONE'}}],getQueryResults:async()=>{throw Object.assign(Error('private SQL and customer email'),{code:400,errors:[{reason:'invalidQuery',message:'Aggregations of aggregations are not allowed at [22:359]'}]});}}];
  };
  const deps=createOracleProviderDependencies({bigquery:bq,project:'fixture',env:identityEnv});
  deps.customerJourney.retentionPopulationScope='source_local'; // Historical source-separated incident contract.
  const context=transitionAnalysisContext(null,question,{now}).context;
  const result=await answerCohortRetention({context,provider:deps.customerJourney,requestId:'fixture-retention-request'});
  assert.equal(calls.filter(q=>q.query.includes('retention_members')).length,9);
  for(const o of result.evidence.source_outcomes){assert.equal(o.identity_evidence.activation,'active');assert.equal(o.query_id,INCIDENT_JOBS[o.source_store]);assert.equal(o.bigquery_reason,'invalidQuery');assert.equal(o.error_category,'nested_aggregation');assert.deepEqual(o.statement_location,{line:22,column:359});}
  assert.match(result.answer,/Activated email candidate snapshots/);
  assert.doesNotMatch(result.answer,/private SQL|customer email|first-observed source cohorts/);
});

test('US metadata is authoritative for runtime jobs even when diagnostics default to EU',async()=>{
  const config=loadOracleJobReadinessConfig({GOOGLE_SERVICE_ACCOUNT_JSON:'{}'});
  assert.equal(config.expectedLocation,'EU');
  let read;
  const store=createBigQueryAnalysisJobStore({project:'fixture',location:'EU',bigquery:{dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{read=q;return [[]];}}});
  await store.getByRequest('retained-request','owner');
  assert.equal(read.location,'US');assert.match(read.query,/SELECT/);
});

test('sitewide baseline survives when all named/item calculations fail, without provider replay',async t=>{
  const f=acceptanceFixture({retention_events:events,identityEnv,observationCertificates:[],now});
  f.state.fail_retention_groups=['ww','usd','shopify'].flatMap(s=>[s+'/named',s+'/items']);
  const h=await acceptanceServer(f,{durable:true,now});t.after(h.close);
  const r=await h.submit(question);
  assert.equal(r.evidence.rows.length,0);assert.equal(r.evidence.baseline_rows.length,9);
  assert.equal(r.evidence.coverage.classification.length,3);
  assert.match(r.answer,/independently validated sitewide baselines are retained/);
  assert.match(r.answer,/Comparable sitewide/);assert.doesNotMatch(r.answer,/No result was calculated/);
  assert.equal(r.delivery.status,'partial');
  const reads=f.wireQueries.length,recovered=await h.get('/jobs/'+r.job_id);
  assert.equal(recovered.answer,r.answer);assert.equal(f.wireQueries.length,reads);
});

test('supplied-job metadata inspection is US-only and never emits SQL or raw messages',async()=>{
  let calls=0;
  const result=await inspectRetentionIncidentJobs({job:(id,options)=>{
    calls++;assert.ok(Object.values(INCIDENT_JOBS).includes(id));assert.equal(options.location,'US');
    return {getMetadata:async options=>{assert.equal(options.maxRetries,0);return [{configuration:{query:{query:'private SQL'}},status:{state:'DONE',errorResult:{reason:'invalidQuery',message:'Aggregations of aggregations are not allowed at [22:359]; private@example.org'}}}];}};
  }},INCIDENT_JOBS);
  assert.equal(calls,3);assert.ok(result.every(r=>r.failure.error_category==='nested_aggregation'));
  assert.doesNotMatch(JSON.stringify(result),/private|@example|configuration/);
  assert.equal(validateJourneyDefinition({start_date:'2022-10-19',end_date:'2026-10-19',ranking_window:360}).ranking_window,360);
  assert.ok(CUSTOMER_JOURNEY_TOOL_DEFINITION.parameters.properties.ranking_window.enum.includes(360));
});


test('shared context keeps observation cutoff distinct and rejects unsupported windows',()=>{
  const c=transitionAnalysisContext(null,'Compare named collaboration retention from 2025-01-01 to 2025-12-31; observation cutoff 2026-10-19. Include sitewide cohorts at 90/180/360 days.',{now}).context;
  assert.deepEqual([c.start_date,c.end_date,c.observation_end],['2025-01-01','2025-12-31','2026-10-19']);
  assert.throws(()=>validateJourneyDefinition({start_date:c.start_date,end_date:c.end_date,ranking_window:365}),/ranking_window/);
  assert.throws(()=>validateJourneyDefinition({start_date:c.start_date,end_date:c.end_date,observation_end:'2025-01-01'}),/observation_end/);
});

// Excluded advertising language must not steal an order-history retention request.
for(const mode of ['direct','interactive','durable'])test(`retention exclusions and campaign-to-cohort switch reach providers: ${mode}`,async t=>{
  const f=acceptanceFixture({retention_events:events,observationCertificates:[],identityEnv,now});
  const h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
  const send=async(message,analysis_context)=>mode==='direct'?(await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,analysis_context})})).json()):h.submit(message);
  const blocked=await send('Which products were bought from the last email campaign?');
  assert.match(blocked.answer,/Product attribution is unavailable/);
  const campaign=transitionAnalysisContext({},'How did the last Klaviyo campaign perform?',{now}).context;
  const prompt=question+'\nUse approved product attribution. This is customer purchase-retention analysis, not advertising or campaign attribution.';
  const r=await send(prompt,campaign);
  assert.equal(r.analysis_context.tool_route,'analyze_customer_journey');assert.equal(r.analysis_context.campaign_request,null);assert.deepEqual(r.analysis_context.requested_operations,[]);
  assert.equal(r.evidence.kind,'governed_cohort_retention');assert.ok(r.evidence.rows.length);assert.ok(r.evidence.baseline_rows.length);assert.deepEqual(r.analysis_context.retention_windows,[90,180,360]);assert.doesNotMatch(r.answer,/current governed campaign bindings/);
  if(mode==='durable'){const n=f.wireQueries.length;const saved=await h.get('/jobs/'+r.job_id);assert.deepEqual(saved.evidence,r.evidence);assert.equal(f.wireQueries.length,n);}
});

test('retention routing accepts plural repeats and does not inherit campaign attribution',async()=>{
  const {resolveAnalysisDecision}=await import('../oracle/analysis-decision.js');
  const {requestedAttributionOperation}=await import('../oracle/requested-operations.js');
  const previous=transitionAnalysisContext({},'How did the last Klaviyo campaign perform?',{now}).context;
  for(const text of [
    'Run customer_journey cohort_retention analysis, not advertising or campaign attribution. Compare named collaboration first-purchase cohorts and products. Entry dates: 2022-10-19 through 2026-10-19. Show 90/180/360-day observed repeats and second-order products.',
    'Compare collaboration customer repeats and product attribution from 2022-10-19 through 2026-10-19. Without ads or email attribution.',
    'Compare collaboration retention and second-order product attribution from 2022-10-19 through 2026-10-19.'
  ])for(const base of [{},previous]){const c=transitionAnalysisContext(base,text,{now}).context;assert.equal(c.tool_route,'analyze_customer_journey');assert.equal(c.campaign_request,null);assert.deepEqual(c.requested_operations,[]);assert.equal(resolveAnalysisDecision(c).outcome,'execution');}
  for(const text of ['Which products were bought from the last email campaign?','Not only campaign revenue: show products purchased from ads.','Not advertising attribution; instead show which products were bought through the email campaign.']){assert.equal(requestedAttributionOperation(text),'product_attribution');const c=transitionAnalysisContext({},text,{now}).context;assert.match(resolveAnalysisDecision(c).answer,/Product attribution is unavailable/);}
  assert.equal(requestedAttributionOperation('Which products were bought from it?',previous),'product_attribution');
});
