import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cohortRelations,cohortExecutionPlan} from '../oracle/cohort-execution.js';
import {mappingAuditSql,mappingCoverageArtifact} from '../diagnostics/retention-mapping-coverage-evidence.js';
import {entryAgeTraceCtes,entryAgeTraceSql} from '../diagnostics/retention-entry-age-trace.js';
import {retentionMappingReviewSql} from '../diagnostics/retention-mapping-review.js';
const literal=v=>v==null?'NULL':typeof v==='number'?String(v):"'"+v.replaceAll("'","''")+"'";
const input=(name,columns,rows)=>`${name} AS (${rows.map(row=>'SELECT '+row.map((v,i)=>literal(v)+' '+columns[i]).join(',')).join(' UNION ALL ')})`;
const body=(sql,name)=>cohortRelations(sql).relations.find(r=>r.name===name).body;
function run(sql){
 const r=spawnSync('python3',['test/helpers/retention-sqlite.py'],{input:JSON.stringify({sql,params:{},members:[],returns:[],classes:[]}),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('both complete diagnostic final SELECTs replace table-correlated lookups with keyed aggregates and joins (not BigQuery execution)',()=>{
 const artifact=mappingCoverageArtifact('fixture');
 for(const [sql,settings]of [[mappingAuditSql('fixture'),artifact.mapping_settings],[entryAgeTraceSql('fixture'),artifact.trace_settings]]){
  const relations=cohortRelations(sql).relations;
  for(const r of relations.filter(r=>/^(review|audit|trace)_/.test(r.name)))assert.doesNotMatch(r.body,/\b(?:ARRAY|EXISTS)\s*\(\s*SELECT\b/i,`${r.name}: scalar table correlation reintroduced`);
  assert.match(settings.query,/CREATE TEMP TABLE cohort_result AS WITH/);assert.equal(settings.jobTimeoutMs,50000);assert.equal(settings.scriptOptions.statementByteBudget,'500000000');
  assert.match(settings.query,/FROM _SESSION.cohort_cr_routes/);assert.match(settings.query,/FROM _SESSION.cohort_cr_resolved/);
 }
 const review=retentionMappingReviewSql('fixture');assert.match(body(review,'review_routes'),/GROUP BY source_ref/);assert.match(body(review,'review_routes'),/LIMIT 20/);assert.match(body(review,'review_candidates'),/GROUP BY p.source_ref/);assert.match(body(review,'review_candidates'),/LIMIT 11/);
 assert.match(body(review,'review'),/IFNULL\(c.candidates,\[\]\)/);assert.match(body(review,'review'),/LEFT JOIN review_candidates/);
 const trace=entryAgeTraceSql('fixture');assert.match(body(trace,'trace_named_lines'),/SELECT DISTINCT/);assert.match(body(trace,'trace_named_orders'),/SELECT DISTINCT/);assert.match(body(trace,'trace_route_arrays'),/GROUP BY source_ref/);assert.match(body(trace,'trace_product_rows'),/FROM trace_product_totals p LEFT JOIN trace_route_arrays/);
 assert.match(cohortRelations(trace).result,/LIMIT 201\) product_routes/);
 // Final packaging arrays are uncorrelated envelopes, not per-row table lookups.
 assert.doesNotMatch(cohortExecutionPlan(trace,[]).result,/WHERE r.source_ref=h.source_product_ref/);
 assert.doesNotMatch(cohortExecutionPlan(review,[]).result,/WHERE s.source_ref=i.source_product_ref/);
});
test('generated trace joins preserve EXISTS semantics, duplicate-line deduplication, candidate-only and missing named attribution (SQLite compatibility)',()=>{
 const refs=[['motor','woo:ww:1'],['iron','shopify:shopify:2'],['iron','woo:ww:3']];
 const base=[
  input('trace_targets',['collection_id','collaboration_name'],[['motor','mot_rhead'],['iron','iron_maiden'],['missing',null]]),
  input('trace_refs',['collection_id','source_ref'],refs),input('trace_candidates',['collection_id','source_ref'],[['iron','woo:ww:4']]),
  input('source_lines',['source_platform','source_store','order_ref','source_product_ref'],[['woo','ww','o1','woo:ww:1'],['woo','ww','o1','woo:ww:1'],['shopify','shopify','o2','shopify:shopify:2'],['woo','ww','o3','woo:ww:3'],['woo','ww','o4','woo:ww:4']]),
  input('orders',['source_platform','source_store','order_ref','order_timestamp','source_customer_id'],[['woo','ww','o1','2024-01-01','local1'],['shopify','shopify','o2','2026-01-01','local2'],['woo','ww','o3','2024-02-01','local3'],['woo','ww','o4','2023-02-01','local4']]),
  input('ranked_orders',['source_platform','source_store','order_ref','order_timestamp','governed_customer_ref','order_sequence'],[['woo','ww','o1','2024-01-01','linked',1],['shopify','shopify','o2','2026-01-01','linked',2],['woo','ww','o3','2024-02-01','other',1],['woo','ww','o4','2023-02-01','candidate',1]]),
  input('ci_mapping',['source_store','source_order_id','resolution'],[['ww','o1','matched'],['shopify','o2','matched'],['ww','o3','unmatched'],['ww','o4','ambiguous']]),
  input('line_classification_sets',['source_platform','source_store','order_ref','source_product_ref','collaboration_state','names'],[['woo','ww','o1','woo:ww:1','named','["mot_rhead","mot_rhead"]'],['woo','ww','o1','woo:ww:1','named','["mot_rhead"]'],['shopify','shopify','o2','shopify:shopify:2','named','["iron_maiden"]'],['woo','ww','o3','woo:ww:3','conflicting','["iron_maiden"]'],['woo','ww','o4','woo:ww:4','classification_absent','[]']])
 ];
 const trace='WITH '+entryAgeTraceCtes()+' SELECT * FROM trace_history';
 const joined=['trace_named_lines','trace_named_orders','trace_history'].map(name=>`${name} AS (${body(trace,name).replace('CROSS JOIN UNNEST(c.names) name','CROSS JOIN json_each(c.names) name').replace('t.collaboration_name=name','t.collaboration_name=name.value')})`);
 const select=' SELECT collection_id,source_product_ref,named_consumed,first_order_named_consumed,candidate_only,first_entry_timestamp FROM trace_history ORDER BY source_product_ref';
 const actual=run('WITH '+base.concat(joined).join(',')+select);
 // Original two correlated EXISTS expressions, executed only as a local equivalence oracle.
 const old=body(trace,'trace_history').replace('named.source_product_ref IS NOT NULL',"EXISTS(SELECT 1 FROM line_classification_sets c JOIN trace_targets t ON t.collection_id=r.collection_id WHERE c.source_platform=l.source_platform AND c.source_store=l.source_store AND c.order_ref=l.order_ref AND c.source_product_ref=l.source_product_ref AND c.collaboration_state='named' AND t.collaboration_name IN (SELECT value FROM json_each(c.names)))").replace('first_named.order_ref IS NOT NULL',"EXISTS(SELECT 1 FROM line_classification_sets f JOIN trace_targets t ON t.collection_id=r.collection_id WHERE f.source_platform=first_order.source_platform AND f.source_store=first_order.source_store AND f.order_ref=first_order.order_ref AND f.collaboration_state='named' AND t.collaboration_name IN (SELECT value FROM json_each(f.names)))").replace(/\n LEFT JOIN trace_named_lines named[^\n]+/,'').replace(/\n LEFT JOIN trace_named_orders first_named[^\n]+/,'');
 assert.deepEqual(actual,run('WITH '+base.concat(`trace_history AS (${old})`).join(',')+select));assert.equal(actual.length,4);
 assert.equal(actual.find(r=>r.source_product_ref==='woo:ww:1').first_order_named_consumed,1);
 const iron=actual.find(r=>r.source_product_ref==='shopify:shopify:2');assert.equal(iron.named_consumed,1);assert.equal(iron.first_order_named_consumed,0);assert.equal(iron.first_entry_timestamp,'2024-01-01');
 assert.equal(actual.find(r=>r.source_product_ref==='woo:ww:3').named_consumed,0);assert.equal(actual.find(r=>r.source_product_ref==='woo:ww:4').candidate_only,1);
});
test('generated mapping route audit counts products once across duplicate lines and multiple resolved names (SQLite compatibility)',()=>{
 const sql=mappingAuditSql('fixture'),base=[
 input('cr_resolved',['subject_ref','classification_type','classification_value'],[['p1','collaboration_name','mot_rhead'],['p1','collaboration_name','mot_rhead'],['p1','collaboration_name','iron_maiden'],['p2','collaboration_name','iron_maiden'],['p3','collaboration_name','collaborations']]),
 input('classified_lines',['source_platform','source_store','source_product_ref','classifications'],[['woo','ww','p1','["collaboration_name=mot_rhead"]'],['woo','ww','p1','["collaboration_name=mot_rhead"]'],['woo','ww','p2','["collaboration_name=iron_maiden"]'],['woo','ww','p3','[]'],['woo','ww',null,'[]']])];
 const counts="SELECT source_store,COUNT(DISTINCT source_product_ref) historical_products,COUNT(DISTINCT IF(resolved_named,source_product_ref,NULL)) resolved_named_products,COUNT(DISTINCT IF(resolved_not_consumed,source_product_ref,NULL)) resolved_classification_not_consumed FROM audit_route_products GROUP BY source_store";
 const ctes=['audit_named_values','audit_route_products'].map(name=>`${name} AS (${body(sql,name).replaceAll('LOGICAL_OR(','MAX(').replace("CONCAT('collaboration_name=',n.classification_value)","('collaboration_name='||n.classification_value)").replace('NOT IN UNNEST(l.classifications)','NOT IN (SELECT value FROM json_each(l.classifications))')})`);
 assert.deepEqual(run('WITH '+base.concat(ctes).join(',')+' '+counts),[{source_store:'ww',historical_products:3,resolved_named_products:2,resolved_classification_not_consumed:1}]);
});
test('generated mapping candidate pairs deduplicate persisted SKU matches before product/name/family joins (SQLite compatibility)',()=>{
 const sql=retentionMappingReviewSql('fixture'),pairs=body(sql,'review_candidate_pairs').replace('ARRAY_AGG(DISTINCT s.sku ORDER BY s.sku)','json_group_array(DISTINCT s.sku)');
 const base=[input('skus',['source_ref','sku'],[['woo:ww:1','A'],['woo:ww:1','A'],['woo:ww:2','A'],['woo:ww:3',null]]),input('targets',['product_ref','title','sku'],[['shop1','Z archived','A'],['shop1','A archived','A'],['shop2','Second','A']])];
 const rows=run('WITH '+base.concat(`review_candidate_pairs AS (${pairs})`).join(',')+' SELECT * FROM review_candidate_pairs ORDER BY source_ref,product_ref');
 assert.equal(rows.length,4);assert.equal(rows[0].title,'A archived');assert.deepEqual(JSON.parse(rows[0].exact_skus),['A']);assert.ok(rows.every(r=>r.source_ref!=='woo:ww:3'));
});

test('two diagnostic whole-script caps cover their existing reviewed statement allocations without changing SQL, deadlines or other callers',async()=>{
 const {auditExecutionOptions,cohortExecutionOptions}=await import('../oracle/cohort-execution.js');
 const {customerJourneySql}=await import('../oracle/customer-journey.js');
 const artifact=mappingCoverageArtifact('fixture');
 for(const [settings,expected,required]of [[artifact.mapping_settings,'5500000000',178257920],[artifact.trace_settings,'6000000000',136314880]]){
  const dataStatements=(settings.query.match(/CREATE TEMP TABLE /g)||[]).length+1;
  assert.equal(settings.maximumBytesBilled,expected);assert.equal(BigInt(expected),BigInt(dataStatements)*500000000n);
  assert.equal(settings.scriptOptions.statementByteBudget,'500000000');assert.ok(required<Number(settings.scriptOptions.statementByteBudget));
  assert.equal(settings.jobTimeoutMs,50000);assert.equal(settings.scriptOptions.statementTimeoutMs,'15000');
 }
 // The shared diagnostic default (including email-history callers) and the
 // production cohort allocator retain their original independent limits.
 const simple='WITH orders AS (SELECT 1 value) SELECT * FROM orders';
 assert.equal(auditExecutionOptions(simple,['orders']).maximumBytesBilled,'500000000');
 const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 const production=cohortExecutionOptions(customerJourneySql('fixture','retention_windows',null,null,identity,true),45000);
 assert.equal(production.maximumBytesBilled,production.scriptOptions.statementByteBudget);assert.equal(production.jobTimeoutMs,45000);
 assert.equal(BigInt(production.maximumBytesBilled),20000000000n/BigInt((production.query.match(/CREATE TEMP TABLE /g)||[]).length+1));
});
