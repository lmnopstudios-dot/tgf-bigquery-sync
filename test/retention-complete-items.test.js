import test from 'node:test';
import assert from 'node:assert/strict';
import {itemCompleteness,assertItemOutcomeCompleteness,RETENTION_ITEM_ROWS} from '../oracle/retention-item-completeness.js';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
const prompt='Compare collaboration retention and individual first-purchase items from 2022-10-19 through 2026-10-19. Include 90/180/360 days, sitewide baselines and second-order products.';
const env={ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture-order-email-v2'};
const events=Array.from({length:240},(_,i)=>({source_platform:'woo',source_store:'ww',customer:'customer-'+i,order:'entry-'+i,timestamp:'2024-01-01T12:00:00Z',pieces:[{id:String(i+1),title:'Item '+i,names:['alpha'],group:'collaboration'}]}));
for(const mode of ['interactive','durable'])test(`complete 240-item list retains every window and survives delivery: ${mode}`,async t=>{
 const f=acceptanceFixture({retention_events:events,retention_combined:true,observationCertificates:[],identityEnv:env,now:Date.parse('2026-10-23T12:00:00Z')});
 const h=await acceptanceServer(f,{durable:mode==='durable',now:Date.parse('2026-10-23T12:00:00Z')});t.after(h.close);const r=await h.submit(prompt);
 const items=r.evidence.rows.filter(x=>x.entry_product_ref);assert.equal(items.length,720);assert.equal(new Set(items.map(x=>x.entry_product_ref)).size,240);
 const o=r.evidence.source_outcomes.find(o=>o.group==='retention_piece_windows');assert.equal(o.state,'fulfilled');assert.deepEqual(o.item_completeness,{total_rows:720,returned_rows:720,total_items:240,returned_items:240,complete:true});assert.equal(o.row_limit,RETENTION_ITEM_ROWS);assert.equal(o.truncated,false);
 assert.ok(items.every(row=>row.cohort_customers===1&&row.repeat_rate===null));assert.ok(r.evidence.rows.filter(x=>!x.entry_product_ref).every(x=>x.cohort_customers===240));assert.match(r.answer,/240 of 240 eligible item\/cohort groups returned/);assert.doesNotMatch(r.answer,/Individual collaboration items.*99\/99/);
 assert.notEqual(deliverOracleResult(r,r.analysis_context).delivery.status,'failed');
 const bad=structuredClone(r);bad.evidence.rows=bad.evidence.rows.filter(x=>x.entry_product_ref!==items[0].entry_product_ref);assert.equal(deliverOracleResult(bad,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
 if(mode==='durable'){const n=f.wireQueries.length;const saved=await h.get('/jobs/'+r.job_id);assert.equal(saved.evidence.rows.length,r.evidence.rows.length);assert.equal(f.wireQueries.length,n);}
});
test('item proof rejects omitted windows, duplicate members and fabricated completeness',()=>{
 const rows=Array.from({length:RETENTION_ITEM_ROWS},(_,i)=>({source_platform:'tgf',source_store:'combined',collaboration_name:'alpha',entry_product_ref:'p'+Math.floor(i/3),window_days:[90,180,360][i%3]}));
 assert.equal(itemCompleteness(rows,RETENTION_ITEM_ROWS,false).complete,true);assert.equal(itemCompleteness(rows,RETENTION_ITEM_ROWS+3,true).complete,false);
 assert.throws(()=>itemCompleteness(rows,RETENTION_ITEM_ROWS+3,false),/Invalid/);assert.throws(()=>itemCompleteness(rows.slice(1),RETENTION_ITEM_ROWS,false),/Invalid/);
 const bad=structuredClone(rows);bad[1].window_days=90;assert.throws(()=>itemCompleteness(bad,RETENTION_ITEM_ROWS,false),/Invalid/);
 assert.throws(()=>assertItemOutcomeCompleteness({rows}),/row bound/);
});
test('complete-item transport uses its own quota while public journey limit stays bounded',async()=>{
 let q;const provider=createCustomerJourneyService({project:'fixture',env:{},bigquery:{query:async settings=>{q=settings;return [[]];}}});
 await provider.analyzeCustomerJourney({start_date:'2022-10-19',end_date:'2026-10-19',cohort:{entry_source:'woo'},group_by:['retention_piece_windows'],limit:99},{sourceStore:'ww',completeItems:true});
 assert.equal(q.params.limit,6000);assert.equal(q.params.cohort_limit,2000);assert.equal(q.maximumBytesBilled,'2500000000');assert.ok(q.jobTimeoutMs<=45000);assert.match(q.query,/total_item_window_rows/);
 await provider.analyzeCustomerJourney({start_date:'2022-10-19',end_date:'2026-10-19',cohort:{entry_source:'woo'},group_by:['retention_windows'],limit:99},{sourceStore:'ww',completeItems:true});assert.equal(q.params.limit,99);assert.doesNotMatch(customerJourneySql('fixture','retention_windows'),/total_item_window_rows/);
});
