import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {migrationAuditSql,diagnoseMigrationHistory} from '../diagnostics/customer-migration-history.js';
import {customerHistoryContract} from '../oracle/customer-history.js';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
const now=Date.parse('2026-10-20T12:00:00Z');
const question='Which named collaborations have the highest 90-day repeat-purchase rates among customers whose first purchase included that collaboration? Include purchases before and after the Woo-to-Shopify migration wherever verified customer links support them. Use the last three years through yesterday. Show cohort sizes, mature denominators, observed repeats and coverage limitations.';

test('order-reference audit executes over duplicates, namespaces, conflicting profiles and incomplete imports without certifying identity',()=>{
 const query=migrationAuditSql('fixture').candidates;
 const python=`import json,sqlite3,sys,re
q=json.load(sys.stdin)
c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.create_function('TIMESTAMP',1,lambda x:x);c.create_function('CONCAT',-1,lambda *x:None if None in x else ''.join(map(str,x)))
for t in ['metorik_uk','metorik_us','shopify_data']: c.execute("ATTACH DATABASE ':memory:' AS "+t)
for t in ['metorik_uk','metorik_us']: c.execute('CREATE TABLE '+t+'.orders(order_id,customer_id,order_created_at,order_name,order_number)')
c.execute('CREATE TABLE shopify_data.order_customers(order_id,customer_id,order_created_at,order_name,source_app_id)')
c.executemany('INSERT INTO metorik_uk.orders VALUES(?,?,?,?,?)',[(1,7,'2025-01-01','same','1'),(1,7,'2025-01-01','same','1'),(2,8,'2025-02-01','uk-only','2'),(3,8,'2025-03-01','uk-again','3')])
c.executemany('INSERT INTO metorik_us.orders VALUES(?,?,?,?,?)',[(1,7,'2025-01-01','same','1')])
app='gid://shopify/App/1758145'
c.executemany('INSERT INTO shopify_data.order_customers VALUES(?,?,?,?,?)', [('a','S1','2025-01-01','same',app),('a','S1','2025-01-01','same',app),('b','S1','2025-02-02','uk-only',app),('c','S2',None,'uk-again',app),('d',None,'2025-04-01','missing',app),('native','S1','2025-04-02','later','native-app')])
q=re.sub(chr(96)+r'fixture\\.([^'+chr(96)+r']+)'+chr(96),r'\\1',q)
q=re.sub(r'COUNTIF\\(([^()]+)\\)',r'SUM(CASE WHEN \\1 THEN 1 ELSE 0 END)',q)
print(json.dumps(dict(c.execute(q).fetchone())))`;
 const r=spawnSync('python3',['-c',python],{input:JSON.stringify(query),encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const n=JSON.parse(r.stdout);
 assert.equal(n.imported_rows,5);assert.equal(n.imported_orders,4);assert.equal(n.woo_rows,5);assert.equal(n.woo_orders,4);
 assert.equal(n.single_order_reference_candidates,2);assert.equal(n.unmatched_order_references,1);assert.equal(n.ambiguous_order_references,1);assert.equal(n.namespace_collisions,1);
 assert.equal(n.woo_customers_with_multiple_shopify_profiles,1);assert.equal(n.shopify_profiles_with_multiple_woo_customers,1);
 assert.equal(n.candidate_original_date_agreements,2);assert.equal(n.candidate_original_date_conflicts,1);assert.equal(n.candidate_missing_dates,1);
});

test('aggregate Render report retains independent failures, unknown bridge counts and ordinary source results',async()=>{
 const calls=[];const bigquery={query:async o=>{calls.push(o);if(o.query.includes('INFORMATION_SCHEMA'))throw Object.assign(Error('private body'),{response:{status:403,config:{url:'https://oauth2.googleapis.com/token'}}});if(o.query.includes('WITH woo AS'))return [[{imported_rows:4,imported_orders:3,ambiguous_order_references:1}]];if(o.query.includes('imported_product_lines'))return [[{imported_product_lines:3,lines_without_product_id:1,lines_with_candidate_provenance_keys:2}]];throw Object.assign(Error('no source fixture'),{code:'FIXTURE_READ_FAILED'});}};
 const r=await diagnoseMigrationHistory({bigquery,project:'fixture',now});
 assert.equal(r.audit.candidates.counts.imported_orders,3);assert.equal(r.audit.schema_shopify_data.failure.host,'oauth2.googleapis.com');assert.equal(r.audit.schema_shopify_data.failure.stage,'authentication_token');
 assert.equal(r.mapping_coverage.verified_customers,null);assert.equal(r.cross_migration_repeat_customers,null);assert.equal(r.customer_history.company_wide_ranking,false);
 assert.ok(r.retention.source_outcomes.every(x=>x.state==='rejected'));assert.equal(calls.length,10);
 assert.doesNotMatch(JSON.stringify(r),/private body|no source fixture/);
 assert.ok(calls.every(o=>o.maximumBytesBilled&&o.jobTimeoutMs));
});

for(const mode of ['direct','interactive','durable'])test(`migration request, ordinary follow-up and recovery preserve unverified linkage in ${mode}`,async t=>{
 const f=acceptanceFixture({retention:true,observationCertificates:[],now}),h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
 const send=async(message,context)=>mode==='direct'?await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,analysis_context:context})})).json():h.submit(message);
 const r=await send(question);assert.equal(r.evidence.kind,'governed_cohort_retention');assert.deepEqual(r.evidence.coverage.customer_history,customerHistoryContract());
 assert.equal(r.analysis_context.end_date,'2026-10-19');assert.equal(r.analysis_context.start_date,'2023-10-20');
 assert.match(r.answer,/cross-platform customer linkage has not been verified/);assert.match(r.answer,/Matrixify copies remain excluded/);
 assert.equal(deliverOracleResult(structuredClone(r),r.analysis_context).delivery.status,'partial');
 const tampered=structuredClone(r);tampered.evidence.coverage.customer_history.company_wide_ranking=true;assert.equal(deliverOracleResult(tampered,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
 const next=await send('Show 180 days instead.',r.analysis_context);assert.deepEqual(next.evidence.coverage.customer_history,customerHistoryContract());assert.equal(next.evidence.ranking_window,180);
 assert.ok(f.queries.every(o=>!o.params||o.params.matrixify_app_id==='gid://shopify/App/1758145'));
 if(mode==='durable'){const count=f.calls.length,recovered=await h.get('/jobs/'+next.job_id);assert.deepEqual(recovered.evidence.coverage.customer_history,customerHistoryContract());assert.equal(f.calls.length,count);}
});

test('production transaction/classification SQL and strictly later timestamps remain protected',()=>{
 for(const group of ['retention_windows','retention_product_windows','retention_piece_windows']){
  const q=customerJourneySql('fixture',group);assert.match(q,/AND NOT migrated AND NOT cancelled/);assert.match(q,/r.order_timestamp>e.order_timestamp/);assert.match(q,/custom|classified_lines/);
 }
 assert.throws(()=>migrationAuditSql('bad`project'),/Invalid/);
 const q=migrationAuditSql('fixture');assert.match(q.attributes,/custom_attributes_json/);assert.doesNotMatch(JSON.stringify(q),/email|displayName|customer_name|INSERT|MERGE|DELETE/);
});
