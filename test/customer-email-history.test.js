import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {emailState,emailEvidenceCtes,emailLinkedJourneySql,emailSchemaSql} from '../oracle/email-linked-history.js';
import {cohortRelations,cohortExecutionOptions} from '../oracle/cohort-execution.js';
import {diagnoseEmailHistory,SOURCE_COUNTS,OVERLAP_COUNTS,emailOverlapSql} from '../diagnostics/customer-email-history.js';
const schemas=Object.fromEntries(['metorik_uk','metorik_us','shopify_data','woocommerce_uk'].map(d=>[d,(d==='woocommerce_uk'?['orders_api']:d==='shopify_data'?['order_customers','customers']:['orders','customers']).flatMap(table_name=>['customer_id','order_id','email','raw_json'].map(column_name=>({table_name,column_name,data_type:'STRING'})))]));
test('conservative email policy preserves plus and dots, rejects missing malformed placeholders',()=>{
 assert.deepEqual(emailState(' A.B+News@Actual.org '),{state:'usable',normalized:'a.b+news@actual.org'});
 for(const value of [null,'','  '])assert.equal(emailState(value).state,'missing');
 for(const value of ['not-mail','a @real.org','a@@real.org'])assert.equal(emailState(value).state,'malformed');
 for(const value of ['unknown@real.org','test@real.org','a@example.com','a@real.invalid'])assert.equal(emailState(value).state,'placeholder');
});
// Execute the production normalization/conflict/degree/link SQL, adapting only
// BigQuery syntax. email_raw is the private relational input boundary; no raw
// warehouse identifiers or values are returned from this test or the diagnostic.
function runLinkSql(input){
 const parsed=cohortRelations(`WITH ${emailEvidenceCtes('fixture',schemas)} SELECT * FROM email_links`);
 const sql='WITH '+parsed.relations.filter(r=>r.name!=='email_raw').map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT source_store,COUNT(*) profiles FROM email_links GROUP BY 1';
 const python=`import sqlite3,json,sys,re
p=json.load(sys.stdin);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.execute('CREATE TABLE email_raw(source_store,profile,evidence_level,evidence_order,email)')
c.executemany('INSERT INTO email_raw VALUES(?,?,?,?,?)',p['input'])
c.create_function('REGEXP_CONTAINS',2,lambda s,r: bool(re.search(r,s)) if s else False)
q=p['sql'].replace('UNION DISTINCT','UNION').replace("SELECT AS STRUCT source_store,profile",'SELECT source_store,profile')
q=re.sub(r"(?<![A-Za-z0-9_])r'((?:[^']|'')*)'",lambda m:"'"+m.group(1)+"'",q)
# COUNTIF contains no nested calls in the factory relations under test.
q=re.sub(r'COUNTIF\\(([^()]+)\\)',r'SUM(CASE WHEN \\1 THEN 1 ELSE 0 END)',q)
print(json.dumps([dict(x) for x in c.execute(q)]))`;
 const result=spawnSync('python3',['-c',python],{input:JSON.stringify({sql,input}),encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('production email link SQL excludes duplicate profiles, shared addresses and customer/order disagreement globally',()=>{
 const row=(store,id,email,level='order')=>[store,id,level,'o',email];
 const input=[row('ww','1',' A+tag@real.org '),row('shopify','1','a+tag@real.org'),row('usd','1','other@real.org'),
 row('ww','2','shared@real.org'),row('ww','3','shared@real.org'),row('shopify','2','shared@real.org'),
 row('usd','2','changed@real.org','customer'),row('usd','2','second@real.org'),row('shopify','3','changed@real.org'),
 row('ww','4',null),row('ww','5','guest@real.org'),row('ww','6','bad'),
 row('shopify','1','a+tag@real.org'),row('ww','1','a+tag@real.org')];
 assert.deepEqual(runLinkSql(input).sort((a,b)=>a.source_store.localeCompare(b.source_store)),[{source_store:'shopify',profiles:1},{source_store:'usd',profiles:1},{source_store:'ww',profiles:1}]);
});
test('linked SQL recomputes entry before date/classification filters, preserves namespaces and excludes imported transaction copies',()=>{
 const sql=emailLinkedJourneySql('fixture',schemas),{relations}=cohortRelations(sql);
 const body=name=>relations.find(r=>r.name===name).body;
 assert.match(body('qualifying_orders'),/JOIN email_links/);assert.match(body('qualifying_orders'),/SELECT orders\.\*/);
 assert.match(body('qualifying_orders'),/NOT migrated AND NOT cancelled/);assert.match(body('qualifying_orders'),/channel='Online'/);
 assert.match(body('ranked_orders'),/PARTITION BY governed_customer_ref ORDER BY order_timestamp,source_platform,source_store,order_ref/);
 assert.match(body('entry_orders'),/order_sequence=1 AND DATE/);
 assert.match(body('retention_next_orders'),/r.order_timestamp>e.order_timestamp/);
 assert.match(body('retention_next_orders'),/r.order_timestamp,r.source_platform,r.source_store,r.order_ref/);
 assert.match(body('lines'),/metorik_uk.order_line_items/);assert.match(body('lines'),/metorik_us.order_line_items/);
 assert.match(body('entry_matches'),/'email_linked' source_platform,'all' source_store/);
 const baseline=cohortRelations(emailLinkedJourneySql('fixture',schemas,{baseline:true})).relations.find(r=>r.name==='entry_matches').body;
 assert.match(baseline,/FROM entry_orders e/);assert.doesNotMatch(baseline,/JOIN classified_lines|entry_matches/);
 const options=cohortExecutionOptions(sql,20000);assert.match(options.query,/BEGIN TRANSACTION/);assert.match(options.query,/CREATE TEMP TABLE cohort_orders/);assert.doesNotMatch(options.query,/CREATE TABLE (?!cohort)/);
 assert.match(emailEvidenceCtes('fixture',schemas),/JSON_VALUE\(t.raw_json,'\$\.billing.email'\)/);
 assert.doesNotMatch(emailLinkedJourneySql('fixture',schemas,{stores:['usd','shopify']}),/fixture\.(?:woocommerce_uk|metorik_uk)\./);
 assert.throws(()=>emailSchemaSql('bad`project','metorik_uk'));
 assert.doesNotMatch(emailEvidenceCtes('fixture',{metorik_uk:[{table_name:'orders',column_name:'customer_id'},{table_name:'orders',column_name:'normalized_email'}]}),/t\.normalized_email/);
});
const now=Date.parse('2026-10-20T12:00:00Z');
function fakeProvider({failed=null,overlap=2}={}){
 const calls=[];
 return {calls,bigquery:{query:async o=>{
  calls.push(o);
  if(o.query.includes('INFORMATION_SCHEMA')){const d=Object.keys(schemas).find(d=>o.query.includes('.'+d+'.'));if(d===failed)throw Object.assign(Error('private body with identifiers'),{response:{status:403}});return [schemas[d]];}
  if(o.query.includes('left_eligible_customers'))return [[...['ww,shopify','usd,shopify','ww,usd'].map(pair=>({...Object.fromEntries(OVERLAP_COUNTS.map(k=>[k,k==='unique_candidate_emails'?overlap:k==='ambiguous_candidate_emails'?1:k==='exact_email_overlap'?overlap+1:k.includes('unevaluable')?0:k.includes('unmatched')?9-overlap:10])),a:pair.split(',')[0],b:pair.split(',')[1]}))]];
  if(o.query.includes('eligible_online_customers'))return [[Object.fromEntries(SOURCE_COUNTS.map(k=>[k,/missing|malformed|placeholder|conflicting|disagreements|multiple_profiles|anonymous|imported_copies/.test(k)?0:10]))]];
  if(o.query.includes('cross_migration_repeat_customers'))return [[{eligible_email_linked_records:12,eligible_source_customer_profiles:14,multi_source_email_linked_records:2,woo_email_linked_customer_denominator:10,cross_migration_repeat_customers:2}]];
  if(o.query.includes('BEGIN TRANSACTION'))return [[{window_days:90,cohort_customers:10,mature_customers:0,repeat_customers:0,observed_repeat_customers:2,same_collaboration:0,different_collaboration:0,core_range:0,unknown:0,source_store:'all',collaboration_name:'Governed collaboration',email:'private-do-not-leak',profile:'private-do-not-leak'}]];
  throw Error('Unexpected SQL');
 }}};
}
test('Render audit exercises real provider arguments and returns aggregate-only linked counts and baseline',async()=>{
 const f=fakeProvider(),r=await diagnoseEmailHistory({project:'fixture',bigquery:f.bigquery,now});
 assert.equal(r.linked.state,'fulfilled');assert.equal(r.linked.cross_migration_repeat_customers,2);assert.equal(r.linked.cohorts[0].observed_repeat_customers,2);assert.equal(r.linked.baseline[0].repeat_rate,null);
 assert.equal(r.queries,11);assert.equal(r.activated_customer_mappings,0);
 assert.doesNotMatch(JSON.stringify(r),/private-do-not-leak|private body|@actual|raw_json|column_name|SELECT /);
 assert.ok(f.calls.every(o=>o.maximumBytesBilled==='1000000000'&&o.jobTimeoutMs<=20000));
 assert.ok(f.calls.every(o=>o.params.matrixify_app_id==='gid://shopify/App/1758145'&&o.params.coverage_status==='unverified'));
 const linked=f.calls.filter(o=>o.query.includes('BEGIN TRANSACTION'));assert.equal(linked.length,2);assert.ok(linked.every(o=>o.scriptOptions));
});
test('a failed source stays unknown while a supported independent pair is evaluated',async()=>{
 const f=fakeProvider({failed:'metorik_uk'}),r=await diagnoseEmailHistory({project:'fixture',bigquery:f.bigquery,now});
 assert.equal(r.sources.ww.counts,null);assert.equal(r.overlap.find(x=>x.sources[0]==='ww').unique_candidate_emails,null);
 assert.equal(r.linked.state,'fulfilled');assert.doesNotMatch(JSON.stringify(r),/private body/);
});
test('zero overlaps do not invent activated links or observed cross-migration zeros',async()=>{
 const f=fakeProvider({overlap:0}),r=await diagnoseEmailHistory({project:'fixture',bigquery:f.bigquery,now});
 assert.equal(r.linked.state,'unavailable');assert.equal(r.linked.cross_migration_repeat_customers,null);assert.equal(r.queries,8);
});

test('production linked sequencing executes earlier entries, namespace collisions, imported copies and strictly-later ties',()=>{
 const q=cohortRelations(emailLinkedJourneySql('fixture',schemas));
 const names=['email_normalized','email_states','email_profiles','email_degrees','email_bad','email_links','qualifying_orders','ranked_orders','entry_orders','retention_next_orders'];
 const relations=q.relations.filter(r=>names.includes(r.name)).map(r=>{
  return `${r.name} AS (${r.body})`;
 });
 // QUALIFY is adapted separately, preserving the exact window expression.
 const next=q.relations.find(r=>r.name==='retention_next_orders').body;
 const match=next.match(/QUALIFY (ROW_NUMBER\(\) OVER\([^]*\))=1/);
 const nextBody=next.replace(/SELECT r\.\*/,`SELECT r.*,${match[1]} next_rank`).replace(/QUALIFY [^]*$/,'');
 relations[relations.length-1]=`retention_next_orders AS (SELECT * FROM (${nextBody}) WHERE next_rank=1)`;
 const sql='WITH '+relations.join(',')+` SELECT COUNT(*) entry_customers,COUNTIF(e.source_platform='woo') woo_entries,COUNTIF(n.source_platform='shopify') shopify_seconds,COUNTIF(n.source_platform='woo') woo_seconds FROM entry_orders e LEFT JOIN retention_next_orders n USING(governed_customer_ref)`;
 const input=[['ww','7','order','1','a@real.org'],['shopify','7','order','s','a@real.org'],['usd','7','order','1','b@real.org'],['shopify','8','order','s2','c@real.org'],['ww','8','order','2','c@real.org']];
 const order=(platform,store,id,profile,date,migrated=false)=>[platform,store,'Online',id,profile,date,'paid',100,0,migrated,false];
 const orders=[order('woo','ww','1','7','2025-01-01'),order('shopify','shopify','s','7','2025-02-01'),order('shopify','shopify','imported','7','2025-01-02',true),order('woo','usd','1','7','2025-03-01'),order('woo','usd','2','7','2025-03-02'),order('woo','ww','2','8','2024-01-01'),order('shopify','shopify','s2','8','2025-04-01'),order('woo','ww','tie','7','2025-01-01')];
 for(const row of orders)if(row[0]==='woo')row[6]='completed';
 const python=`import json,sys,sqlite3,re,hashlib,datetime
p=json.load(sys.stdin);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.execute('CREATE TABLE email_raw(source_store,profile,evidence_level,evidence_order,email)');c.executemany('INSERT INTO email_raw VALUES(?,?,?,?,?)',p['input'])
c.execute('CREATE TABLE orders(source_platform,source_store,channel,order_ref,source_customer_id,order_timestamp,status,order_total,refunds,migrated,cancelled)');c.executemany('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?)',p['orders'])
c.create_function('REGEXP_CONTAINS',2,lambda s,r: bool(re.search(r,s)) if s else False)
c.create_function('DATE',2,lambda s,t:s[:10] if s else None)
c.create_function('IF',3,lambda a,b,d:b if a else d)
c.create_function('SHA256',1,lambda x:hashlib.sha256(x.encode()).hexdigest())
c.create_function('TO_HEX',1,lambda x:x)
c.create_function('CONCAT',-1,lambda *x:''.join(x))
c.create_function('TIMESTAMP_DIFF',3,lambda a,b,u:(datetime.datetime.fromisoformat(a)-datetime.datetime.fromisoformat(b)).days)
q=p['sql'].replace('UNION DISTINCT','UNION').replace('SELECT AS STRUCT source_store,profile','SELECT source_store,profile').replace(',DAY)',",'DAY')")
q=re.sub(r"(?<![A-Za-z0-9_])r'((?:[^']|'')*)'",lambda m:"'"+m.group(1)+"'",q)
q=re.sub(r'COUNTIF\\(([^()]+)\\)',r'SUM(CASE WHEN \\1 THEN 1 ELSE 0 END)',q)
print(json.dumps(dict(c.execute(q,{'time_zone':'UTC','observation_end':'2026-10-19','first_order_semantic':'first_observed_ever','cohort_entry_start':'2025-01-01','cohort_entry_end':'2025-12-31','entry_source':None,'entry_channel':'Online','minimum_sequence':2,'maximum_sequence':None,'within_days':None,'subsequent_source':None,'subsequent_channel':'Online'}).fetchone())))`;
 const r=spawnSync('python3',['-c',python],{input:JSON.stringify({sql,input,orders}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout),{entry_customers:2,woo_entries:2,shopify_seconds:1,woo_seconds:1});
});

test('production pair aggregates distinguish conflicting overlaps, ambiguous candidates, missing and unmatched denominators',()=>{
 const parsed=cohortRelations(emailOverlapSql('fixture',schemas));
 const sql='WITH '+parsed.relations.filter(r=>r.name!=='email_raw').map(r=>`${r.name} AS (${r.name==='eligible'?'SELECT * FROM eligible_input':r.body})`).join(',')+parsed.result;
 const input=[['ww','1','order','1','x@real.org'],['shopify','1','order','1','x@real.org'],['ww','2','order','2','shared@real.org'],['ww','3','order','3','shared@real.org'],['shopify','2','order','2','shared@real.org'],['ww','4','order','4',null],['usd','1','customer',null,'a@real.org'],['usd','1','order','1','b@real.org'],['shopify','3','order','3','a@real.org'],['usd','2','order','2','unmatched@real.org']];
 const python=`import sqlite3,json,sys,re
p=json.load(sys.stdin);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.execute('CREATE TABLE email_raw(source_store,profile,evidence_level,evidence_order,email)');c.executemany('INSERT INTO email_raw VALUES(?,?,?,?,?)',p['input'])
c.execute('CREATE TABLE eligible_input AS SELECT DISTINCT source_store,profile FROM email_raw')
c.create_function('REGEXP_CONTAINS',2,lambda s,r: bool(re.search(r,s)) if s else False)
c.create_function('IF',3,lambda a,b,d:b if a else d)
q=p['sql'].replace('UNION DISTINCT','UNION').replace('SELECT AS STRUCT source_store,profile','SELECT source_store,profile')
q=re.sub(r"(?<![A-Za-z0-9_])r'((?:[^']|'')*)'",lambda m:"'"+m.group(1)+"'",q)
while 'COUNTIF(' in q:
 start=q.index('COUNTIF(');i=start+8;begin=i;depth=1
 while depth:
  if q[i]=='(':depth+=1
  if q[i]==')':depth-=1
  i+=1
 expression=q[begin:i-1];q=q[:start]+'SUM(CASE WHEN '+expression+' THEN 1 ELSE 0 END)'+q[i:]
print(json.dumps([dict(x) for x in c.execute(q)]))`;
 const r=spawnSync('python3',['-c',python],{input:JSON.stringify({sql,input}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);const rows=JSON.parse(r.stdout),ww=rows.find(r=>r.a==='ww'&&r.b==='shopify'),usd=rows.find(r=>r.a==='usd');
 assert.deepEqual(ww,{a:'ww',b:'shopify',exact_email_overlap:2,unique_candidate_emails:1,ambiguous_candidate_emails:1,left_eligible_customers:4,right_eligible_customers:3,left_unevaluable_customers:1,right_unevaluable_customers:0,left_unmatched_customers:0,right_unmatched_customers:1});
 assert.equal(usd.exact_email_overlap,1);assert.equal(usd.unique_candidate_emails,0);assert.equal(usd.ambiguous_candidate_emails,1);assert.equal(usd.left_unevaluable_customers,1);assert.equal(usd.left_unmatched_customers,1);
});
