import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {reproduceRetainedBaseline,readExactRetentionEvidence,ingestionRunSql} from '../diagnostics/oracle-retention-exact-evidence.js';
const row={source_platform:'shopify',source_store:'shopify',collaboration_name:'Sitewide',window_days:90,cohort_customers:10,mature_customers:0,repeat_customers:0,observed_repeat_customers:2,observation_coverage_status:'unverified',median_days_to_second:null,second_order_products:[]};
test('historical validators are unchanged from the incident revision',()=>{
 const s=readFileSync(new URL('../diagnostics/oracle-retention-exact-evidence.js',import.meta.url),'utf8');
 const validators=s.slice(s.indexOf('export function retentionRows('),s.indexOf('// Execute the historical'));
 assert.equal(createHash('sha256').update(validators.trimEnd()).digest('hex'),'ab7b5576b232f9a1eab9abc69d050787792b986000e48d4b838b0acd20808236');
});
test('retained null product reproduces exact original predicate and field trace without accepting or changing evidence',()=>{
 const rows=[{...row,second_order_products:[{product_ref:'known',product:null,observed_customers:2,mature_repeat_customers:0}]}],before=JSON.stringify(rows);
 const r=reproduceRetainedBaseline(rows);assert.equal(r.state,'reproduced_rejection');assert.equal(r.predicate,'Invalid second-order products');
 assert.deepEqual(r.predicate_inputs.at(-1),{path:'results[0].second_order_products[0].product',type:'null'});
 assert.equal(JSON.stringify(rows),before);
 const unknown=reproduceRetainedBaseline([{...row,second_order_products:[{product_ref:null,product:'Private title',observed_customers:2,mature_repeat_customers:0}]}]);
 assert.equal(unknown.predicate_inputs.at(-1).path,'results[0].second_order_products[0].product_ref');assert.doesNotMatch(JSON.stringify(unknown),/Private title/);
});
test('scope and denominator guards still reject incompatible retained evidence',()=>{
 assert.equal(reproduceRetainedBaseline([{...row,source_store:'ww'}]).state,'reproduced_rejection');
 assert.equal(reproduceRetainedBaseline([{...row,mature_customers:11}]).predicate,'Invalid retention denominator');
 assert.equal(reproduceRetainedBaseline([{...row,collaboration_name:'Other'}]).predicate,'Invalid sitewide baseline');
 assert.equal(reproduceRetainedBaseline([row]).state,'accepted_by_historical_component_validator');
});
function fixture({expired=false,failedKind=null}={}){
 const calls=[];
 return {calls,bigquery:{job:(id,options)=>{calls.push(['job',id,options]);return {getMetadata:async()=>[{status:{state:'DONE'}}],getQueryResults:async o=>{calls.push(['getQueryResults',o]);if(expired)throw Object.assign(Error('private token'),{code:404});return [[row],null,{}];}};},dataset:name=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{calls.push(['query',q]);assert.match(q.query,/^WITH runs/);assert.doesNotMatch(q.query,/\b(?:INSERT|CREATE|UPDATE|DELETE|MERGE|CALL)\b/);assert.equal(q.maximumBytesBilled,'100000000');assert.equal(q.autoPaginate,false);if(failedKind&&q.query.includes(failedKind+'_refresh_runs'))throw Object.assign(Error('secret'),{code:403});return [[{succeeded_runs:1,certification:'not_inferred'}]];}}};
}
test('exact existing result is validated in memory and only two named ingestion tables are queried',async()=>{
 const f=fixture(),r=await readExactRetentionEvidence({...f,project:'fixture'});
 assert.equal(f.calls.filter(c=>c[0]==='getQueryResults').length,1);assert.equal(f.calls.filter(c=>c[0]==='query').length,2);
 assert.equal(r.checks[0].validation.state,'accepted_by_historical_component_validator');assert.ok(r.checks.every(c=>c.status==='read_completed'));
 assert.equal(r.report_replayed,false);assert.ok(r.checks.filter(c=>c.records).every(c=>c.certification==='not_inferred'));
});
test('expired result and one missing run table preserve the other ingestion evidence; no replacement query',async()=>{
 const f=fixture({expired:true,failedKind:'customer'}),r=await readExactRetentionEvidence({...f,project:'fixture'});
 assert.equal(r.checks[0].status,'unavailable');assert.equal(r.checks[0].http_status,404);assert.equal(r.checks.at(-1).status,'unavailable');assert.equal(r.checks[2].status,'read_completed');
 assert.equal(f.calls.filter(c=>c[0]==='query').length,2);assert.doesNotMatch(JSON.stringify(r),/private token|secret/);
});
test('records preserve half-open update windows and do not treat customer repairs as incremental completeness',()=>{
 const sql=ingestionRunSql('fixture','customer');assert.match(sql,/status='succeeded' AND mode='scheduled'/);assert.match(sql,/MAX\(window_end\).*1 PRECEDING/);
 assert.match(sql,/window_start<TIMESTAMP\('2026-10-20', 'Europe\/London'\)/);assert.match(sql,/LIMIT 12/);assert.doesNotMatch(sql,/history_progress|INFORMATION_SCHEMA|identity_snapshots/);
});
