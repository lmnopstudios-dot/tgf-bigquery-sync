import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {governedDecisionCtes,productFamilyCtes,resolveMappingDecisions,resolveFamilyDecisions,relationshipId} from '../oracle/product-mapping.js';
import {classificationReaderCtes} from '../oracle/classification-reader.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
const refs=Object.entries({ww:['11737','11795','23150','44905','11549','11593','11594','92837','11634','80797','60637','80795'],usd:['106660','106592','106354','106178','106807','106986','106800','108048','108303','108052','108175','108623']}).flatMap(([store,ids])=>ids.map(id=>`woo:${store}:${id}`));
export const mapping=refs.map((ref,i)=>({event_id:`m${i}`,decision_id:`m${i}`,relationship_id:null,candidate_id:null,left_ref:ref,right_ref:`shopify:shopify:${i%2?'gid://shopify/Product/':''}${100+i}`,status:'approved',reviewed_at:'2026-01-01',supersedes_decision_id:null}));
export const families=refs.map((ref,i)=>({event_id:`f${i}`,decision_id:`f${i}`,membership_id:null,source_ref:ref,shopify_parent_ref:`shopify:shopify:gid://shopify/Product/${200+i}`,status:'active',reviewed_at:'2026-01-01',supersedes_decision_id:null}));
// Replacing a source assignment without a supersession pointer still has one current source assignment.
families.push({...families[0],event_id:'f-new',decision_id:'f-new',membership_id:'new',shopify_parent_ref:'shopify:shopify:999',reviewed_at:'2026-02-01'});
mapping.push({...mapping[1],event_id:'revoked',decision_id:'revoked',status:'revoked',reviewed_at:'2026-02-01',supersedes_decision_id:'m1'});
families.push({...families[1],event_id:'family-revoked',decision_id:'family-revoked',status:'revoked',reviewed_at:'2026-02-01',supersedes_decision_id:'f1'});
test('persisted UI decisions and generated SQL select the same current relationships and source families (local SQLite dialect adaptation)',()=>{
 const sql=`WITH ${governedDecisionCtes('fixture','m')},${productFamilyCtes('fixture','f')} SELECT 'identity' kind,left_ref source_ref,right_ref target_ref,resolved_relationship_id relationship_id FROM m_active UNION ALL SELECT 'family',source_ref,shopify_parent_ref,NULL FROM f_active`;
 const py=`import json,sqlite3,sys,hashlib\np=json.load(sys.stdin);c=sqlite3.connect(':memory:');c.execute("ATTACH DATABASE ':memory:' AS commerce")\nfor name,rows in [('product_mapping_decisions',p['mapping']),('product_family_decisions',p['families'])]:\n cols=list(rows[0]);c.execute('CREATE TABLE commerce.'+name+'('+','.join(x+' TEXT' for x in cols)+')');c.executemany('INSERT INTO commerce.'+name+' VALUES('+','.join('?' for x in cols)+')',[[r.get(x) for x in cols] for r in rows])\nc.create_function('CONCAT',-1,lambda *xs:b''.join(x if isinstance(x,bytes) else str(x).encode() for x in xs));c.create_function('LEAST',2,min);c.create_function('GREATEST',2,max);c.create_function('SHA256',1,lambda x:hashlib.sha256(x).digest());c.create_function('TO_HEX',1,lambda x:x.hex());c.create_function('zero_byte',0,lambda:b'\\x00')\ns=p['sql'].replace('\\x60fixture.commerce.','commerce.').replace('\\x60','').replace('CODE_POINTS_TO_BYTES([0])','zero_byte()').replace(' AS BYTES',' AS BLOB')\nc.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute(s)]))`;
 const run=spawnSync('python3',['-c',py],{input:JSON.stringify({sql,mapping,families}),encoding:'utf8'});assert.equal(run.status,0,run.stderr);
 const rows=JSON.parse(run.stdout),identity=rows.filter(r=>r.kind==='identity'),family=rows.filter(r=>r.kind==='family');
 assert.equal(identity.length,resolveMappingDecisions(mapping).activeApproved.length);assert.equal(family.length,resolveFamilyDecisions(families).active.length);
 for(const row of identity)assert.equal(row.relationship_id,relationshipId(row.source_ref,row.target_ref));
 assert.deepEqual(family.map(r=>[r.source_ref,r.target_ref]).sort(),resolveFamilyDecisions(families).active.map(r=>[r.source_ref,r.shopify_parent_ref]).sort());
 assert.equal(family.find(r=>r.source_ref===refs[0]).target_ref,'shopify:shopify:999');assert.ok(!family.some(r=>r.source_ref===refs[1]));
});
test('all real linked report shapes consume the UI-equivalent shared resolvers before classification and family aggregation',()=>{
 const reader=classificationReaderCtes('fixture');assert.ok(reader.includes(productFamilyCtes('fixture','cr_family')));assert.doesNotMatch(reader,/PARTITION BY membership_id/);
 for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows']){
  const sql=customerJourneySql('fixture',group,null,null,{dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true},true);
  assert.ok(sql.replace(/\s+/g,' ').includes(reader.replace(/\s+/g,' ')));assert.match(sql,/FROM cr_resolved/);assert.match(sql,/JOIN retention_reporting_lines l/);assert.match(sql,/cr_routes WHERE mapping_type='approved_reporting_family'/);
 }
});
test('narrow route diagnostic retains independent results, explicitly marks bounds, and does not submit the report',async()=>{
 const {readUiRouteReconciliation}=await import('../diagnostics/read-retention-ui-routes.js');let calls=0;
 const out=await readUiRouteReconciliation({project:'fixture',candidateQuery:'SELECT 1',deployedQuery:'SELECT 2',resolveMappingDecisions,resolveFamilyDecisions,bigquery:{createQueryJob:async q=>{assert.equal(q.maximumBytesBilled,'250000000');assert.equal(q.jobTimeoutMs,20000);if(++calls===1)throw Object.assign(Error('blocked'),{code:403});return [{id:'fixture',getQueryResults:async()=>[[{kind:'routes',available_records:502,record:'{}'}]]}];}}});
 assert.equal(out.checks[0].status,'unavailable');assert.equal(out.checks[1].status,'read_completed');assert.equal(out.checks[1].truncated,true);assert.equal(out.report_replayed,false);
});
test('pinned narrow artifact is reproducible and its deployed-query builder preserves exact scope',async()=>{
 const {readFileSync}=await import('node:fs'),{gunzipSync}=await import('node:zlib');
 const {uiRouteReconciliationSql,exactWooSubjects}=await import('../diagnostics/retention-ui-route-reconciliation.js');
 const {classificationRefSql}=await import('../oracle/classification-reader.js');
 const a=JSON.parse(gunzipSync(readFileSync(new URL('../diagnostics/retention-ui-route-reconciliation.json.gz',import.meta.url))));
 assert.equal(a.candidate_query,uiRouteReconciliationSql(a.project));assert.deepEqual(a.subjects,exactWooSubjects);assert.equal(Object.values(a.subjects).flat().length,24);
 const m=await import('data:text/javascript;base64,'+Buffer.from(a.query_builder_source).toString('base64'));
 assert.equal(m.uiRouteReconciliationSql('fixture',{reader:classificationReaderCtes('fixture'),normalizeRef:classificationRefSql,raw:false}),uiRouteReconciliationSql('fixture',{raw:false}));
 assert.doesNotMatch(a.candidate_query,/\borders\b|retention_members|LIMIT 501\) review_rows|\b(?:CREATE|INSERT|UPDATE|MERGE|DELETE)\b/);
 assert.match(a.candidate_query,/scope_variations/);assert.match(a.candidate_query,/order_line_items/);assert.doesNotMatch(a.candidate_query,/order_id|customer_id|quantity/);assert.match(a.candidate_query,/resolved_decision_id=m.supersedes_decision_id/);
});

test('UI current-state resolution reads actual BigQuery TIMESTAMP wrappers before decision-ID tie breaking',async()=>{
 const {BigQuery}=await import('@google-cloud/bigquery');
 const old={...mapping[0],event_id:'z-old',decision_id:'z-old',reviewed_at:BigQuery.timestamp('2025-01-01')};
 const newer={...old,event_id:'a-new',decision_id:'a-new',status:'revoked',reviewed_at:BigQuery.timestamp('2026-01-01')};
 assert.equal(resolveMappingDecisions([newer,old]).activeApproved.length,0);
 const fOld={...families[0],event_id:'z-old',decision_id:'z-old',reviewed_at:old.reviewed_at};
 const fNew={...fOld,event_id:'a-new',decision_id:'a-new',status:'revoked',reviewed_at:newer.reviewed_at};
 assert.equal(resolveFamilyDecisions([fNew,fOld]).active.length,0);
});

test('a deployed UI resolver failure preserves successfully read SQL evidence and the other check',async()=>{
 const {readUiRouteReconciliation}=await import('../diagnostics/read-retention-ui-routes.js');
 const out=await readUiRouteReconciliation({project:'fixture',candidateQuery:'SELECT 1',deployedQuery:'SELECT 2',resolveMappingDecisions:()=>{throw Error('UI evaluation failed')},resolveFamilyDecisions,bigquery:{createQueryJob:async()=>[{id:'fixture',getQueryResults:async()=>[[{kind:'identity_history',record:'{}',available_records:1}]]}]}});
 assert.equal(out.checks[0].status,'read_completed');assert.equal(out.checks[0].groups.identity_history.records.length,1);assert.equal(out.checks[0].ui_evaluation_complete,false);assert.equal(out.checks[1].status,'read_completed');
});

test('both diagnostic paths use distinct key joins without table IN/EXISTS correlations',async()=>{
 const {uiRouteReconciliationSql}=await import('../diagnostics/retention-ui-route-reconciliation.js');
 for(const raw of [true,false]){
  const q=uiRouteReconciliationSql('fixture',{raw});
  assert.doesNotMatch(q,/\b(?:IN|EXISTS)\s*\(\s*SELECT\b/i);
  assert.match(q,/scope_ids AS \(SELECT DISTINCT/);assert.match(q,/scope_relationship_keys AS \(SELECT DISTINCT/);
  assert.match(q,/LEFT JOIN scope_refs l ON l.ref=m.left_ref LEFT JOIN scope_refs r ON r.ref=m.right_ref/);
 }
});
test('allocated job IDs and structured SQL failure positions survive submission failure independently',async()=>{
 const {readUiRouteReconciliation}=await import('../diagnostics/read-retention-ui-routes.js');let n=0;const ids=[],allocated=[];
 const r=await readUiRouteReconciliation({project:'fixture',candidateQuery:'SELECT 1',deployedQuery:'SELECT 2',resolveMappingDecisions,resolveFamilyDecisions,jobIdFactory:()=>String(++n),onAllocated:event=>allocated.push(event.allocated_job_id),bigquery:{createQueryJob:async q=>{ids.push(q.jobId);assert.equal(allocated.at(-1),q.jobId);throw Object.assign(Error('Correlated subqueries at [145:2]'),{code:400,errors:[{reason:'invalidQuery',location:'query',message:'Correlated subqueries at [145:2]'}]});}}});
 assert.equal(r.checks.length,2);assert.deepEqual(r.checks.map(c=>c.job_id),ids);assert.notEqual(ids[0],ids[1]);assert.deepEqual(allocated,ids);
 for(const c of r.checks){assert.deepEqual(c.statement_location,{line:145,column:2});assert.equal(c.provider_reason,'invalidQuery');assert.equal(c.errors[0].location,'query');assert.equal(c.job_returned,false);}
});
