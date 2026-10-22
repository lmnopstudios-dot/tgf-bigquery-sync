import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retentionRows,retentionMarkdown} from '../oracle/cohort-retention.js';
import {assertRetentionProductEvidence} from '../oracle/retention-product-evidence.js';
import {reproduceRetainedBaseline} from '../diagnostics/oracle-retention-exact-evidence.js';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
const production=JSON.parse(readFileSync(new URL('./fixtures/retention-exact-production-20261022.json',import.meta.url)));
const trace=production.checks.find(c=>c.check==='retained_baseline_result').validation;
// Baseline numeric values and null identity are supplied evidence. Product
// counts/titles/references were redacted, so detail values here are synthetic.
const rows=trace.row_inputs.map(r=>({source_platform:'shopify',source_store:'shopify',collaboration_name:'Sitewide',...Object.fromEntries(Object.entries(r).filter(([k])=>k!=='row').map(([k,v])=>[k,v.type==='null'?null:v.number])),observation_coverage_status:'unverified',second_order_products:[{product_ref:null,product:'Unidentified synthetic product',observed_customers:1,mature_repeat_customers:0},...Array.from({length:9},(_,i)=>({product_ref:'shopify:shopify:'+i,product:'Synthetic '+i,observed_customers:1,mature_repeat_customers:0}))]}));
test('exact production null reference rejects historically but cannot discard valid 8897-customer baseline',()=>{
 assert.equal(trace.predicate,'Invalid second-order products');assert.deepEqual(trace.predicate_inputs.at(-1),{path:'results[0].second_order_products[0].product_ref',type:'null'});
 assert.equal(reproduceRetainedBaseline(rows).predicate,'Invalid second-order products');
 const result=retentionRows(rows);assert.deepEqual(result.map(r=>[r.window_days,r.cohort_customers,r.observed_repeat_customers,r.mature_customers,r.repeat_rate]),[[90,8897,510,0,null],[180,8897,656,0,null],[360,8897,702,0,null]]);
 for(const r of result){assert.equal(r.second_order_products.length,9);assert.ok(r.second_order_products.every(p=>typeof p.product_ref==='string'));assert.deepEqual(r.second_order_product_evidence,{status:'partial',unidentified_groups:[{observed_customers:1,mature_repeat_customers:0}]});assertRetentionProductEvidence(r);}
 assert.deepEqual(retentionRows(result),result);
 const answer=retentionMarkdown({rows:[],baseline_rows:result,periods:[{start_date:'2022-10-19',end_date:'2026-10-19'}],observation_end:'2026-10-19'});assert.match(answer,/Unknown second-order product attribution/);assert.match(answer,/Groups overlap known products and must not be added/);
});
test('invalid bonus counts/identities are unavailable; source identity and mature eligibility still reject',()=>{
 for(const extra of [{product_ref:''},{product_ref:123},{product_ref:undefined},{observed_customers:9999},{observed_customers:null}]){
  const r=retentionRows([{...rows[0],second_order_products:[{...rows[0].second_order_products[1],...extra}]}])[0];assert.equal(r.cohort_customers,8897);assert.equal(r.observed_repeat_customers,510);assert.equal(r.second_order_products,null);assert.equal(r.second_order_product_evidence.status,'unavailable');assertRetentionProductEvidence(r);
 }
 assert.throws(()=>retentionRows([{...rows[0],source_store:'ww'}]),/Missing retention population/);
 assert.throws(()=>retentionRows([{...rows[0],mature_customers:1}]),/Unsupported mature denominator/);
 assert.throws(()=>assertRetentionProductEvidence({...retentionRows(rows)[0],second_order_products:[{product_ref:null,product:'Bad',observed_customers:1,mature_repeat_customers:0}]}),/Invalid second-order/);
});
for(const mode of ['direct','interactive','durable'])test(`unidentified baseline bonus survives ${mode} delivery and recovery without re-query`,async t=>{
 const f=acceptanceFixture({retention_events:true,retention_unidentified_bonus:true,observationCertificates:[],now:Date.parse('2026-10-22T12:00:00Z')});const h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
 const question=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
 const r=mode==='direct'?await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json():await h.submit(question);
 assert.ok(r.evidence.baseline_rows.some(b=>b.source_store==='shopify'));assert.ok(r.evidence.source_outcomes.some(o=>o.source_store==='shopify'&&o.group==='retention_baseline_windows'&&o.state==='fulfilled'));assert.match(r.answer,/Unknown second-order product attribution/);
 assert.equal(deliverOracleResult(r,r.analysis_context).delivery.status,'partial');
 const bad=structuredClone(r);bad.evidence.baseline_rows.find(b=>b.source_store==='shopify').second_order_products=[{product_ref:null,product:'Unknown',observed_customers:1,mature_repeat_customers:0}];assert.equal(deliverOracleResult(bad,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
 if(mode==='durable'){const count=f.wireQueries.length;const recovered=await h.get('/jobs/'+r.job_id);assert.deepEqual(recovered.evidence,r.evidence);assert.equal(f.wireQueries.length,count);}
});
