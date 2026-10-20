import test from 'node:test';
import assert from 'node:assert/strict';
import { RETENTION_REQUEST,retentionEvents,fixtureRetention } from './helpers/retention-events.js';
import { acceptanceFixture,acceptanceServer } from './helpers/oracle-acceptance.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { executeGovernedAgentAnalysis,assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
import { customerJourneySql,createCustomerJourneyService } from '../oracle/customer-journey.js';
import { answerCohortRetention,retentionDefinition,retentionRows,retentionMarkdown } from '../oracle/cohort-retention.js';
const now=Date.parse('2026-10-19T12:00:00Z');
const context=()=>transitionAnalysisContext(null,RETENTION_REQUEST,{now}).context;
function verify(r,f){
 assert.equal(r.evidence.kind,'governed_cohort_retention');assert.equal(r.analysis_context.journey_group_by,'collaboration_piece');
 assert.deepEqual([r.analysis_context.start_date,r.analysis_context.end_date],['2023-10-19','2026-10-18']);
 assert.equal(r.analysis_context.current_day_included,false);assert.equal(r.evidence.definition.time_zone,'Europe/London');
 assert.equal(r.evidence.ranking_window,90);assert.equal(f.calls.length,6);
 assert.deepEqual(f.calls.map(c=>c.args.entry_source).sort(),['shopify','shopify','woo','woo','woo','woo']);
 for(const q of f.queries){assert.equal(q.params.time_zone,'Europe/London');assert.equal(q.params.ranking_window,90);assert.equal(q.params.observation_end,'2026-10-18');assert.equal(q.params.first_order_semantic,'first_observed_ever');assert.equal(q.params.entry_channel,null);assert.equal(q.params.subsequent_channel,null);assert.equal(q.maximumBytesBilled,'2500000000');assert.doesNotMatch(q.query,q.params.entry_source==='woo'?/shopify_data\./:/metorik_uk\.|metorik_us\./);}
 const row=(name,window,piece)=>r.evidence.rows.find(x=>x.source_platform==='woo'&&x.collaboration_name===name&&x.window_days===window&&(piece?x.entry_product_ref?.endsWith(':'+piece):!x.entry_product_ref));
 assert.deepEqual([row('alpha',90).cohort_customers,row('alpha',90).mature_customers,row('alpha',90).repeat_customers],[4,3,1]);
 assert.equal(row('alpha',90).repeat_rate,1/3);assert.equal(row('alpha',90).median_days_to_second,10);
 assert.deepEqual([row('alpha',180).repeat_customers,row('alpha',180).median_days_to_second,row('alpha',180).same_collaboration,row('alpha',180).core_range],[2,65,1,1]);
 assert.deepEqual([row('beta',90).cohort_customers,row('beta',90).repeat_customers,row('beta',90).different_collaboration,row('beta',90).unknown],[2,2,1,1]);
 assert.equal(row('alpha',90,'a2').cohort_customers,1);assert.equal(row('alpha',90,'a').cohort_customers,4);
 const coverage=r.evidence.coverage.classification.find(c=>c.source_platform==='woo');
 assert.deepEqual([coverage.eligible_first_customers,coverage.named_customers,coverage.generic_only_customers,coverage.unknown_customers],[8,5,1,2]);
 assert.equal(coverage.history_start,'2022-01-01');assert.equal(coverage.anonymous_orders,1);
 assert.match(r.answer,/Beta\*\* has the highest observed repeat purchase rate at 90 days: \*\*100.00%/);
 assert.match(r.answer,/Pieces within Alpha/);assert.match(r.answer,/33.33%/);assert.match(r.answer,/first-ever purchases are not established/);
 assert.match(r.answer,/<details>\n<summary>Show details<\/summary>/);assert.doesNotMatch(r.answer,/woo\/ww|woo:ww:|UTC order dates|collaborations\*\*/);
 assert.equal(deliverOracleResult(structuredClone(r),r.analysis_context).delivery.status,'partial');
}
for(const mode of ['direct','interactive','durable'])for(const unrelated of [false,true])test(`unchanged incident ${mode}, unrelated context ${unrelated}: membership, coverage, ranking and recovery`,async t=>{
 const f=acceptanceFixture({retention:true,now});f.state.retention_events=true;const h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
 if(unrelated&&mode!=='direct')await h.submit('Show online sales last month.');f.calls.length=0;f.queries.length=0;
 const prior=unrelated?transitionAnalysisContext(null,'Show online sales last month.',{now}).context:null;
 const r=mode==='direct'?await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:RETENTION_REQUEST,analysis_context:prior})})).json():await h.submit(RETENTION_REQUEST);
 verify(r,f);
 if(mode==='durable'){const count=f.calls.length;const recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.answer,r.answer);assert.equal(f.calls.length,count);}
 if(mode!=='direct'){
  const count=f.calls.length,optional=await h.submit('Export that to Excel and show a chart.');
  assert.deepEqual(optional.component_outcomes.filter(c=>['chart','xlsx'].includes(c.component)).map(c=>c.status),['unsupported','unsupported']);assert.ok(optional.evidence.rows.length);assert.match(optional.answer,/supported table is retained/);assert.equal(f.calls.length,count);
 }
});
test('ranking uses requested window, never the longest available window or generic membership',()=>{
 const base={observation_coverage_status:'verified_continuous',verified_coverage_start:'2020-01-01',verified_coverage_end:'2026-10-18',coverage_evidence:'fixture:hand-counted',observed_repeat_customers:20,source_platform:'woo',source_store:'ww',cohort_customers:20,mature_customers:20,median_days_to_second:20};
 const rows=retentionRows([{...base,collaboration_name:'collaborations',window_days:90,repeat_customers:20},{...base,collaboration_name:'alpha',window_days:90,repeat_customers:10},{...base,collaboration_name:'beta',window_days:90,repeat_customers:5},{...base,collaboration_name:'alpha',window_days:180,repeat_customers:10},{...base,collaboration_name:'beta',window_days:180,repeat_customers:15}]);
 const e={rows,periods:[{start_date:'2025-01-01',end_date:'2025-12-31'}],observation_end:'2026-10-18',definition:{}};
 assert.match(retentionMarkdown(e),/Alpha\*\* has the highest observed repeat purchase rate at 90/);
 assert.match(retentionMarkdown({...e,ranking_window:180}),/Beta\*\* has the highest observed repeat purchase rate at 180/);
 assert.equal(rows.length,4);assert.doesNotMatch(retentionMarkdown(e),/\*\*Collaborations\*\*/);
});
test('scope proof rejects generic competitors, wrong window/timezone, invalid second classifications',async()=>{
 const f=acceptanceFixture({retention:true,now});f.state.retention_events=true;const r=await executeGovernedAgentAnalysis({message:RETENTION_REQUEST,baselineOverview:f.baseline,now});
 for(const mutate of [r=>r.evidence.rows[0].collaboration_name='collaborations',r=>r.evidence.ranking_window=180,r=>r.evidence.definition.time_zone='UTC',r=>r.evidence.rows[0].unknown=99]){
  const bad=structuredClone(r);mutate(bad);assert.throws(()=>assertEvidenceAgreement(bad.analysis_context,bad.evidence),{code:'EVIDENCE_SCOPE_MISMATCH'});
 }
});
test('partial platform/group failure retains independently supported calculations',async()=>{
 const c=context(),definition=retentionDefinition(c),calls=[];
 const provider={analyzeCustomerJourney:async (input,{sourceStore})=>{calls.push(input);if(input.cohort.entry_source==='woo'&&input.group_by[0]==='retention_piece_windows')throw Error('private error');const results=fixtureRetention(retentionEvents.filter(e=>e.source_store===sourceStore),{...input,entry_source:input.cohort.entry_source},{pieces:input.group_by[0]!=='retention_windows'});return {results,classification_coverage:results[0]?.coverage};}};
 const r=await answerCohortRetention({context:c,provider});assert.ok(r.evidence.rows.length);assert.equal(calls.length,6);assert.deepEqual(r.evidence.coverage.failed_sources,['woo/retention_piece_windows']);assert.match(r.answer,/Source evidence unavailable/);assert.doesNotMatch(r.answer,/private error/);
 assert.equal(definition.observation_end,'2026-10-18');
});
test('calendar maturity, London cutoff, first-observed prior history, and unknown versus core are explicit',()=>{
 const c=context(),args={...retentionDefinition(c),entry_source:'woo'};
 const rows=fixtureRetention(retentionEvents,args);assert.equal(rows.find(r=>r.collaboration_name==='alpha'&&r.window_days===90).cohort_customers,4);
 for(const subject of ['collaboration repeat customers','online sales','Shopify customers','Klaviyo campaigns']){
  const p=transitionAnalysisContext(null,`Show ${subject} for the past three years through the latest completed day`,{now:Date.parse('2026-10-18T23:30:00Z')}).context;
  assert.equal(p.end_date,'2026-10-18');assert.equal(p.current_day_included,false);
 }
 const sql=customerJourneySql('fixture','retention_piece_windows','woo');
 assert.match(sql,/family_current/);assert.match(sql,/DATE\(em.entry_timestamp,@time_zone\)/);assert.match(sql,/window_days=@ranking_window/);assert.match(sql,/product_group=core_range/);assert.match(sql,/ELSE 'unknown' END/);assert.match(sql,/collaboration_name NOT IN \('collaboration','collaborations'\)/);assert.doesNotMatch(sql,/is_published|published_at|LOWER\(.*title.*LIKE/i);
});

test('requested ranking window survives secondary measures and presentation-only followups',()=>{
 const base=context();const changed=transitionAnalysisContext(base,'Rank primarily by 180-day repeat-purchase rate; retain the 90-day figures.',{now}).context;
 assert.equal(changed.ranking_metric,'repeat_rate_180');assert.equal(retentionDefinition(changed).ranking_window,180);
 const exported=transitionAnalysisContext(changed,'Export that to Excel.',{now}).context;assert.equal(exported.ranking_metric,'repeat_rate_180');
 const switched=transitionAnalysisContext(exported,'Show online sales last month.',{now}).context;assert.deepEqual(switched.requested_formats,[]);assert.equal(switched.output_preference,null);
});
test('coverage-only provider results survive empty named populations and invalid coverage never certifies a source',async()=>{
 const c=context(),coverage={source_platform:'woo',source_store:'ww',eligible_first_customers:2,named_customers:0,generic_only_customers:1,unknown_customers:1,identified_orders:2,anonymous_orders:0,migrated_orders:0,excluded_orders:0,history_start:'2024-01-01',history_end:'2025-01-01'};
 const provider={analyzeCustomerJourney:async (d,{sourceStore})=>({results:[],classification_coverage:sourceStore==='ww'?[coverage]:[]})};
 const r=await answerCohortRetention({context:c,provider});assert.equal(r.analysis_unavailable,true);assert.equal(r.evidence.coverage.classification[0].generic_only_customers,1);assert.match(r.answer,/does not establish zero customers/);
 const f=acceptanceFixture({retention:true,now});f.state.retention_events=true;const supported=await executeGovernedAgentAnalysis({message:RETENTION_REQUEST,baselineOverview:f.baseline,now});
 supported.evidence.coverage.classification[0].named_customers=999;assert.throws(()=>assertEvidenceAgreement(supported.analysis_context,supported.evidence),{code:'EVIDENCE_SCOPE_MISMATCH'});
});
test('London calendar-day repeats, tied timestamps, cancellations, migrations and unclassified second products',()=>{
 const pieces=[{id:'a',title:'A',names:['alpha'],group:null}];
 const events=[
  {source_platform:'woo',source_store:'ww',customer:'one',order:'1',timestamp:'2025-06-01T23:30:00Z',pieces},
  {source_platform:'woo',source_store:'ww',customer:'one',order:'2',timestamp:'2025-06-01T23:30:00Z',pieces:[{id:'tie',title:'Tie',names:[],group:null}]},
  {source_platform:'woo',source_store:'ww',customer:'one',order:'3',timestamp:'2025-08-31T22:59:00Z',pieces:[{id:'u',title:'Unknown',names:[],group:null}]},
  {source_platform:'woo',source_store:'ww',customer:'one',order:'0',timestamp:'2025-01-01T00:00:00Z',pieces,migrated:true},
  {source_platform:'woo',source_store:'ww',customer:'one',order:'00',timestamp:'2025-01-02T00:00:00Z',pieces,cancelled:true}
 ];
 const rows=fixtureRetention(events,{entry_source:'woo',time_zone:'Europe/London',cohort_entry_start:'2025-06-02',cohort_entry_end:'2025-06-02',observation_end:'2025-12-31'});
 assert.equal(rows[0].cohort_customers,1);assert.equal(rows[0].repeat_customers,1);assert.equal(rows[0].unknown,1);assert.equal(rows[0].core_range,0);
 assert.ok(rows[0].median_days_to_second>90);assert.doesNotThrow(()=>retentionRows(rows));
});
