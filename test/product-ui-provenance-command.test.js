import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('actual UI destination and positive-control command preserves uncertainty when control or parser checks fail (mocked)',()=>{
for(const scenario of ['positive','variation_key','receipt_key','missing_control','parser_mismatch']){
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ui-provenance-')),file=path.join(dir,'evidence.json');
const vars=Array.from({length:40},(_,i)=>({prefix:'woo:ww:',parent_id:'11737',variation_id:String(900000+i)}));
const ids=['oracle_ui_routes_da143f25-c64c-4841-8cd1-8706345c59e6','oracle_ui_routes_4e9314d8-46bd-4a7a-bbeb-d5915c464031'];
fs.writeFileSync(file,JSON.stringify({project:'diagnostic-project',checks:[{job_id:ids[0],groups:{variation_keys:{records:scenario==='parser_mismatch'?[vars[0],...vars.slice(2),vars.at(-1)]:vars}}},{job_id:ids[1],groups:{}}]}));
let code=fs.readFileSync(new URL('../docs/oracle/product-ui-decision-provenance-383.md',import.meta.url),'utf8').split("<<'JS'\n")[1].split('\nJS\n')[0];
code=code.replace("const file='/tmp/oracle-ui-product-routes-383.json';",`const file=${JSON.stringify(file)};`).replace("import {loadBigQueryConfig} from './bigquery/client.js';",`const loadBigQueryConfig=()=>({project:'diagnostic-project',credentials:{}});delete process.env.GOOGLE_PROJECT_ID;`);
code=code.replace("import {BigQuery} from '@google-cloud/bigquery';",`const scenarioMock='${scenario}';class BigQuery{
 static timestamp=value=>({value});constructor(o){this.project=o.projectId;}
 dataset(){return {getMetadata:async()=>[{location:'US'}]};}
 job(id){assert.equal(this.project,'diagnostic-project');return {getMetadata:async()=>[{status:{state:'DONE'},configuration:{query:{query:'SELECT retained'}}}],getQueryResults:async()=>{const rows=id.includes('da143f25')?${JSON.stringify(vars)}.map(v=>({kind:'variation_keys',record:JSON.stringify(v)})):[];return [rows,null,{totalRows:String(rows.length)}];}};}
 async createQueryJob(q){assert.equal(this.project,'gf-full-data');assert.ok(q.query.includes('gf-full-data.commerce.'));let rows;
 const fam=[{decision_id:'247926596db75119da1e545bee604951',source_ref:'woo:ww:114959',shopify_parent_ref:'shopify:shopify:gid://shopify/Product/10549750563143',status:'active'},{decision_id:'fixture-iron',source_ref:'${scenario==='variation_key'?'woo:ww:900000':scenario==='receipt_key'?'legacy:alternate':'woo:ww:11737'}',shopify_parent_ref:'shopify:shopify:10434361590087',status:'active'}].filter(r=>${scenario!=='missing_control'}||r.source_ref!=='woo:ww:114959');
 if(q.query.startsWith('WITH raw AS')){if(scenarioMock==='receipt_key'&&q.query.includes('.product_family_decisions'))assert.ok(q.params.pattern.includes('fixture-iron'));const records=q.query.includes('.product_family_decisions')?fam:scenarioMock==='receipt_key'&&q.query.includes('.product_mapping_operations')?[{source_ref:'woo:ww:11737',decision_event_id:'fixture-iron',status:'saved'}]:[];rows=[{kind:'inventory',record:JSON.stringify({total_records:records.length,matching_records:records.length})},...records.map(r=>({kind:'record',record:JSON.stringify(r)}))];}
 else {rows=fam.flatMap(r=>[{kind:'current_family',record:JSON.stringify(r),available_records:2},{kind:'routes',record:JSON.stringify({source_ref:r.source_ref,classification_ref:r.shopify_parent_ref.replace('gid://shopify/Product/','')}),available_records:2},{kind:'classifications',record:JSON.stringify({subject_ref:r.source_ref,classification_type:'collaboration_name',classification_value:r.source_ref==='woo:ww:114959'?'end':'iron_maiden'}),available_records:2}]);}
 return [{id:q.jobId,getQueryResults:async()=>[rows]}];
 }
}`);
code="import assertMock from 'node:assert/strict';\n"+code;
const run=spawnSync(process.execPath,['--input-type=module'],{input:code,encoding:'utf8',cwd:process.cwd()});assert.equal(run.status,['positive','variation_key','receipt_key'].includes(scenario)?0:1,run.stderr+run.stdout);
const r=JSON.parse(fs.readFileSync(file));assert.equal(r.destination.project_mismatch,true);assert.equal(r.reconciliation.length,24);assert.equal(r.allocated_queries.length,5);assert.equal(JSON.parse(fs.readFileSync(r.previous_evidence_file)).project,'diagnostic-project');
if(scenario==='receipt_key'){assert.equal(r.reconciliation[0].finding,'persisted_decision_under_other_key_linked_by_UI_receipt');assert.equal(r.reconciliation[0].receipt_linked_decisions[0].source_ref,'legacy:alternate');assert.equal(r.reconciliation[0].routes.length,0);}
else if(scenario==='variation_key'){assert.equal(r.reconciliation[0].finding,'existing_approval_under_persisted_variation_key_not_parent_ref');assert.equal(r.reconciliation[0].decisions.length,0);assert.equal(r.reconciliation[0].routes.length,0);assert.equal(r.reconciliation[0].variation_decisions.length,1);}
else if(scenario==='positive'){assert.ok(Object.values(r.positive_control).every(Boolean));assert.equal(r.reconciliation[0].finding,'existing_decisions_located_and_consumed');assert.equal(r.reconciliation[1].finding,'no_persisted_decision_at_exact_current_UI_ref');assert.ok(r.parser_control_passed);}
else {assert.equal(r.finding,'still_unverified');if(scenario==='parser_mismatch'){assert.equal(r.parser_control_passed,false);assert.equal(r.reconciliation[0].finding,'existing_decisions_located_and_consumed');assert.ok(r.reconciliation.slice(1).every(x=>x.finding==='still_unverified'));}else assert.ok(r.reconciliation.every(x=>x.finding==='still_unverified'));}
fs.rmSync(dir,{recursive:true,force:true});
}
});
