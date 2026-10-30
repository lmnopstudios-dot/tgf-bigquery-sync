import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {squarePreviewPlan,SQUARE_PREVIEW_LIMITS} from '../customer-identity/square-preview.js';
import {runSquarePreview,assertAggregatePreview} from '../diagnostics/square-identity-preview.js';
import {orderSnapshotGuardSql,identityConfiguration} from '../oracle/customer-identity.js';
const identity={mode:'email_candidate_v2',orderLinks:true,dataset:'identity',snapshot:'accepted'};
const plan=()=>squarePreviewPlan('fixture',identity);

// Execute every generated data stage, including source readers, identity links,
// eligibility and journeys, with only dialect/fixture-table substitutions.
function executeFixture({extraSquare=[],extraProfiles=[],extraSnapshot=[],extraWoo=[],extraShopify=[],extraPayments=[]}={}){
 const p=plan();
 const py=String.raw`import sqlite3,json,sys,re,hashlib
p=json.loads(sys.argv[1]);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.create_function('IF',3,lambda a,b,d:b if a else d)
c.create_function('CONCAT',-1,lambda *x:None if any(v is None for v in x) else ''.join(str(v) for v in x))
c.create_function('SHA256',1,lambda x:hashlib.sha256(x.encode()).digest() if x else None)
c.create_function('TO_HEX',1,lambda x:x.hex().upper() if x else None)
c.create_function('REGEXP_CONTAINS',2,lambda s,r:bool(re.search(r,s)) if s else False)
c.create_function('REGEXP_EXTRACT',2,lambda s,r:re.search(r,s).group(1) if s and re.search(r,s) else None)
c.create_function('SAFE_DIVIDE',2,lambda a,b:a/b if b else None)
class CountIf:
 def __init__(self):self.n=0
 def step(self,x):self.n+=bool(x)
 def finalize(self):return self.n
c.create_aggregate('COUNTIF',1,CountIf)
def table(name,columns,rows):
 c.execute('CREATE TABLE '+name+'('+','.join(columns)+')')
 c.executemany('INSERT INTO '+name+' VALUES('+','.join('?' for _ in columns)+')',rows)
def sql(q):
 q=re.sub(chr(96)+r'fixture\.([^.]+)\.([^'+chr(96)+r']+)'+chr(96),lambda m:m[1]+'_'+m[2],q).replace('_SESSION.','')
 q=re.sub(r'TO_JSON\(([a-z]+),stringify_wide_numbers=>TRUE\)',r'\1.j',q)
 q=q.replace('TO_JSON_STRING(j)','j').replace('JSON_VALUE(','json_extract(')
 q=re.sub(r'SAFE_CAST\((.*?) AS TIMESTAMP\)',r'\1',q)
 q=re.sub(r'TIMESTAMP\(([^()]+)\)',r'\1',q)
 q=re.sub(r"DATE '([^']+)'",r"'\1'",q)
 q=q.replace(' AS STRING',' AS TEXT').replace(' AS BOOL',' AS INTEGER')
 q=re.sub(r"\br'", "'",q).replace('UNION DISTINCT','UNION')
 q=re.sub(r'EXTRACT\(YEAR FROM ([^)]+)\)',r'CAST(SUBSTR(\1,1,4) AS INTEGER)',q)
 if 'QUALIFY ' in q:
  main,window=q.rsplit('QUALIFY ',1);window=window.strip();assert window.endswith('=1');window=window[:-2]
  at=main.rfind('FROM ');main=main[:at]+','+window+' AS __rank '+main[at:]
  q='SELECT * FROM ('+main+') WHERE __rank=1'
 return q
for n,rows in p['json_tables'].items():table(n,['j TEXT'],[[json.dumps(x)] for x in rows])
for n,t in p['tables'].items():table(n,t['columns'],t['rows'])
for s in p['stages']:
 if s['name'] in ['sp_guard','sp_snapshot']:continue
 try:c.execute('CREATE TEMP TABLE '+s['name']+' AS '+sql(s['select']))
 except Exception as e:raise Exception(s['name']+': '+str(e)+' SQL:'+sql(s['select']))
for s in p['report_relations']:
 c.execute('CREATE TEMP TABLE '+s['name']+' AS '+sql(s['body']))
out={}
for name in ['source_year','journey_totals','journeys','exclusions','summary','sp_square','sp_links','sp_snapshot_bad','sp_eligible','sp_linked_refs','sp_journeys']:
 out[name]=[dict(r) for r in c.execute('SELECT * FROM '+name)]
print(json.dumps(out))`;
 const sq=(oid,cid,ts='2024-01-01T00:00:00Z',state='COMPLETED')=>({id:oid,customer_id:cid,created_at:ts,updated_at:ts,state,location_id:'L'});
 const ref=email=>'c_'+(spawnSync('python3',['-c','import hashlib,sys;print(hashlib.sha256(("email-record|"+sys.argv[1]).encode()).hexdigest().upper())',email],{encoding:'utf8'}).stdout.trim());
 const mail='one@real.org',canonical=ref(mail);
 const snap=(source,oid,cid,canon=canonical,resolution='matched',conflict=false,shared=false)=>[source,oid,cid,canon,resolution,conflict,shared,'paid',false];
 const ww=(oid,cid,date='2024-01-02T00:00:00Z',status='completed',total=100,refund=0)=>[oid,cid,date,status,'GBP',total,refund];
 const shop=(oid,date='2024-01-03T00:00:00Z',app=null,status='PAID',cancelled=null,total=100,refund=0)=>({oid,date,app,status,cancelled,total,refund});
 const shopRows=[shop('s1'),shop('import','2023-01-01T00:00:00Z','gid://shopify/App/1758145'),shop('tied','2024-01-01T00:00:00Z'),shop('cancelled',undefined,null,'PAID','2024-01-03'),shop('refunded',undefined,null,'REFUNDED',null,100,100),...extraShopify];
 const json_tables={square_data_orders:[sq('q1','A'),sq('q1','A'),sq('q2',null,'2024-01-05T00:00:00Z'),sq('unmatched','U'),sq('guest',null),sq('conflict','C'),sq('paidlink',null),sq('changed','CH'),sq('shared1','SH1'),sq('shared2','SH2'),sq('future','A','2027-01-01T00:00:00Z'),sq('failed','A',undefined,'CANCELED'),...extraSquare],square_data_payments:[{order_id:'q2',customer_id:'A'},{order_id:'paidlink',customer_id:'P'},{order_id:'conflict',customer_id:'D'},...extraPayments],customers_square_data:[{id:'A',email_address:mail},{id:'A',email_address:mail},{id:'C',email_address:mail},{id:'P',email_address:'payment@real.org'},{id:'CH',email_address:'before@real.org'},{id:'CH',email_address:'after@real.org'},{id:'SH1',email_address:'shared@real.org'},{id:'SH2',email_address:'shared@real.org'},...extraProfiles]};
 // C's conflicting order ID must not cause an A email to be shared; remove its
 // directory row from this base fixture (separate fixtures exercise poisoning).
 json_tables.customers_square_data=json_tables.customers_square_data.filter(x=>x.id!=='C');
 const snapshot=[snap('ww','w1','W'),snap('usd','u1',null),...shopRows.map(s=>snap('shopify',s.oid,'S')),snap('ww','p1','PW',ref('payment@real.org')),...extraSnapshot.map(r=>typeof r==='function'?r(ref):r)];
 const tables={sp_snapshot:{columns:['source','oid','cid','canonical','resolution','conflicting_email','shared_email','financial_status','cancelled'],rows:snapshot},metorik_uk_orders:{columns:['order_id','customer_id','order_created_at','status','currency','total','total_refunds'],rows:[ww('w1','W'),ww('w1','W'),ww('p1','PW'),...extraWoo]},metorik_us_orders:{columns:['order_id','customer_id','order_created_at','status','currency','total','total_refunds'],rows:[ww('u1',0,'2023-12-01T00:00:00Z')]},shopify_data_order_locations:{columns:['order_id','created_at','retail_location_id','source_app_id'],rows:shopRows.map(s=>[s.oid,s.date,null,s.app])},shopify_data_order_customers:{columns:['order_id','customer_id','display_financial_status','cancelled_at','is_guest'],rows:shopRows.map(s=>[s.oid,'S',s.status,s.cancelled,false])},shopify_data_order_financials:{columns:['order_id','presentment_currency','original_total_presentment','total_refunded_presentment'],rows:shopRows.map(s=>[s.oid,'GBP',s.total,s.refund])}};
 const r=spawnSync('python3',['-c',py,JSON.stringify({stages:p.stages,report_relations:cohortRelations(p.result).relations,json_tables,tables})],{encoding:'utf8',timeout:10000,maxBuffer:3000000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}

test('generated staged preview preserves accepted snapshot, readers and safeguards without a publication/activation path',()=>{
 const p=plan();assert.ok(BigInt(p.maximumExecutionBytes)<=5000000000n);
 assert.equal(BigInt(p.stageBytes)*BigInt(p.stages.length+1),BigInt(p.maximumExecutionBytes));
 assert.ok(p.stages[0].select.includes(orderSnapshotGuardSql('fixture',identity)));
 assert.ok(p.result.includes(orderSnapshotGuardSql('fixture',identity)));
 assert.equal(identityConfiguration({ORACLE_CUSTOMER_IDENTITY_MODE:'square_preview'}),null);
 const seen=new Set();for(const s of p.stages){for(const dep of s.select.matchAll(/_SESSION\.(sp_\w+)/g))assert.ok(seen.has(dep[1]),s.name+' '+dep[1]);seen.add(s.name);}
 const sql=p.stages.map(x=>x.select).join('\n')+p.result;
 assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|MERGE|DELETE|TRUNCATE|CREATE|PUBLISH)\b/i);
 assert.ok(sql.includes('e.ts>f.first_ts'));assert.ok(sql.includes("'gid://shopify/App/1758145'"));
 assert.ok(!p.result.includes('SELECT AS STRUCT * FROM _SESSION.sp_links'));
});

test('end to end: exact native/payment IDs, preserved unmatched identities, original orders once and bidirectional strict journeys',()=>{
 const x=executeFixture();
 assert.equal(x.sp_square.filter(r=>r.oid==='q1').length,1);
 assert.equal(x.sp_square.find(r=>r.oid==='q2').cid,'A');
 assert.equal(x.sp_square.find(r=>r.oid==='conflict').cid,null);
 assert.equal(x.sp_links.find(r=>r.cid==='A').linkage,'email_candidate');
 assert.equal(x.sp_links.find(r=>r.cid==='P').linkage,'email_candidate');
 assert.equal(x.sp_links.find(r=>r.cid==='CH').linkage,'conflicting_directory_email');
 for(const cid of ['SH1','SH2'])assert.equal(x.sp_links.find(r=>r.cid===cid).linkage,'shared_or_conflicting_directory_email');
 const eligible=x.sp_eligible;
 for(const oid of ['import','cancelled','refunded','failed','future'])assert.ok(!eligible.some(r=>r.oid===oid),oid);
 assert.equal(eligible.filter(r=>r.oid==='w1').length,1);
 assert.equal(eligible.find(r=>r.oid==='q1').identity_ref,eligible.find(r=>r.oid==='q2').identity_ref);
 assert.notEqual(eligible.find(r=>r.oid==='unmatched').identity_ref,eligible.find(r=>r.oid==='guest').identity_ref);
 assert.ok(eligible.some(r=>r.source==='usd'&&r.cid===null));
 assert.ok(x.sp_journeys.some(r=>r.origin==='square'&&r.destination==='shopify'&&r.oid==='s1'));
 assert.ok(x.sp_journeys.some(r=>r.origin==='shopify'&&r.destination==='square'&&r.oid==='q2'));
 assert.ok(x.sp_journeys.some(r=>r.origin==='usd'&&r.destination==='square'&&r.oid==='q1'));
 assert.ok(!x.sp_journeys.some(r=>r.origin==='square'&&r.oid==='tied'));
 assert.equal(x.summary[0].eligible_linked_square_ids,2);
 assert.equal(x.summary[0].eligible_linked_square_orders,3);
 assert.equal(x.source_year.find(r=>r.source==='square').linked_orders,3);
 assert.equal(x.journeys.find(r=>r.origin==='square'&&r.destination==='shopify').destination_orders,1);
 assert.equal(x.journeys.find(r=>r.origin==='shopify'&&r.destination==='square').destination_orders,1);
 assert.equal(x.journey_totals.find(r=>r.origin==='square'&&r.destination==='shopify').email_candidate_records,1);
 assert.equal(x.exclusions.find(r=>r.source==='shopify'&&r.reason==='matrixify_import').orders,1);
});

test('end to end: unsafe snapshot identities globally poison candidates; conflicting profiles and shared addresses do not leak',()=>{
 const x=executeFixture({extraSnapshot:[ref=>['ww','bad','OTHER',ref('one@real.org'),'ambiguous',true,false,'completed',false]]});
 assert.equal(x.sp_links.find(r=>r.cid==='A').linkage,'unsafe_snapshot_identity');
 assert.ok(!x.sp_journeys.some(r=>['q1','q2','s1','w1','u1'].includes(r.oid)));
 const shared=executeFixture({extraProfiles:[{id:'NOORDERS',email_address:'one@real.org'}]});
 assert.equal(shared.sp_links.find(r=>r.cid==='A').linkage,'shared_or_conflicting_directory_email');
 const changed=executeFixture({extraSnapshot:[ref=>['ww','second-ref','W',ref('different@real.org'),'unmatched',false,false,'completed',false]]});
 assert.equal(changed.sp_links.find(r=>r.cid==='A').linkage,'unsafe_snapshot_identity');
});

test('end to end: IDs stay exact, multi-payment conflicts are isolated, and frozen order membership is required',()=>{
 const x=executeFixture({extraSquare:[{id:'case','customer_id':'a',created_at:'2024-01-01T00:00:00Z',state:'COMPLETED'},{id:'spaces',customer_id:' A ',created_at:'2024-01-01T00:00:00Z',state:'COMPLETED'},{id:'multi',created_at:'2024-01-01T00:00:00Z',state:'COMPLETED'}],extraPayments:[{order_id:'multi',customer_id:'A'},{order_id:'multi',customer_id:'P'}],extraWoo:[['not-in-snapshot','W','2024-01-06T00:00:00Z','completed','GBP',100,0]]});
 assert.equal(x.sp_square.find(r=>r.oid==='multi').cid,null);
 for(const cid of ['a',' A '])assert.equal(x.sp_links.find(r=>r.cid===cid).linkage,'no_exact_directory_id');
 assert.ok(!x.sp_eligible.some(r=>r.oid==='not-in-snapshot'));
 assert.notEqual(x.sp_eligible.find(r=>r.oid==='case').identity_ref,x.sp_eligible.find(r=>r.oid==='q1').identity_ref);
 assert.equal(x.exclusions.find(r=>r.source==='ww'&&r.reason==='missing_snapshot_order').orders,1);
});

function fakeWarehouse({failAt=0,badRows=false}={}){
 const calls=[];let executions=0;
 const rows=[{existing_snapshot_guard_passed:true,summary:{eligible_linked_square_ids:1},eligible_by_source_year:[],journeys:[],exclusions:[]}];
 if(badRows)rows[0].customer_id='private';
 const client={createQueryJob:async options=>{
  calls.push(options);if(options.dryRun)return [{metadata:{statistics:{totalBytesProcessed:'100'}}}];
  if(options.query.startsWith('CALL'))return [{getQueryResults:async()=>[[],null,{jobComplete:true}]}];
  executions++;const result=options.query.startsWith('CREATE TEMP')?[]:rows;
  const metadata={statistics:{sessionInfo:{sessionId:'fixture_session'},query:{totalBytesBilled:'0'}},status:{state:'DONE'}};
  return [{id:options.jobId,metadata,getQueryResults:async()=>{if(executions===failAt)throw {errors:[{reason:'resourcesExceeded',message:'Not enough resources for query planning - too many subqueries.'}]};return [result,null,{jobComplete:true,totalRows:String(result.length)}];},getMetadata:async()=>[metadata]}];
 }};return {client,calls};
}
test('runner end to end: every stage dry runs and executes once, aggregate output only, fixed cumulative cap and session cleanup',async()=>{
 const {client,calls}=fakeWarehouse(),events=[];
 const result=await runSquarePreview({bigquery:client,project:'fixture',identity,location:'EU',emit:e=>events.push(e)});
 assert.equal(result.ok,true);
 assert.equal(calls.filter(x=>x.dryRun).length,plan().stages.length+1);
 const dataCalls=calls.filter(x=>!x.dryRun&&!x.query.startsWith('CALL'));
 assert.ok(dataCalls.reduce((n,x)=>n+BigInt(x.maximumBytesBilled),0n)<=BigInt(SQUARE_PREVIEW_LIMITS.totalBytes));
 assert.ok(dataCalls.slice(1).every(x=>x.connectionProperties[0].key==='session_id'));
 assert.equal(events.filter(x=>x.rows).length,1);
 assert.equal(events.at(-1).stage,'session_cleanup');
 assert.doesNotMatch(JSON.stringify(events),/fixture_session|private@|email-record\|/);
});
test('runner stops on failure, inspects allocated metadata and cleans up; output schema rejects personal data',async()=>{
 const {client,calls}=fakeWarehouse({failAt:3}),events=[];
 const result=await runSquarePreview({bigquery:client,project:'fixture',identity,location:'EU',emit:e=>events.push(e)});
 assert.equal(result.ok,false);assert.equal(calls.filter(x=>x.query.startsWith('CREATE TEMP')).length,3);
 assert.ok(events.some(e=>e.phase==='existing_job_metadata'));assert.ok(!events.some(e=>e.rows));
 const failed=events.find(e=>e.state==='failed');assert.equal(failed.bigquery_reason,'resourcesExceeded');assert.equal(failed.error_category,'query_planning_complexity');assert.match(failed.provider_message_sanitized,/resources for query planning/);
 assert.throws(()=>assertAggregatePreview([{existing_snapshot_guard_passed:true,summary:{},eligible_by_source_year:[],journeys:[],exclusions:[],email:'private@real.org'}]));
 const bad=fakeWarehouse({badRows:true}),redacted=[];
 assert.equal((await runSquarePreview({bigquery:bad.client,project:'fixture',identity,location:'EU',emit:e=>redacted.push(e)})).ok,false);
 assert.doesNotMatch(JSON.stringify(redacted),/private/);
});

test('copyable Render command embeds the tested implementation and uses deployed helpers only',async()=>{
 const {readFile}=await import('node:fs/promises');
 const command=await readFile(new URL('../docs/render/square-identity-preview.sh',import.meta.url),'utf8');
 const module=await readFile(new URL('../customer-identity/square-preview.js',import.meta.url),'utf8');
 assert.ok(command.includes(module.replace("from './collect.js'", "from './customer-identity/collect.js'").replace("from './history-sql.js'", "from './customer-identity/history-sql.js'").replaceAll("from '../oracle/", "from './oracle/")));
 assert.ok(command.includes(await readFile(new URL('../diagnostics/square-safe-sql-error.js',import.meta.url),'utf8')));
 const runner=(await readFile(new URL('../diagnostics/square-identity-preview.js',import.meta.url),'utf8')).split('\n').filter(l=>!l.startsWith('import {squarePreviewPlan,')&&!l.startsWith('import {safeSqlFailure}')&&!l.startsWith('if(import.meta.url===')).join('\n').trimEnd().replace("from '../bigquery/", "from './bigquery/").replace("from '../oracle/", "from './oracle/").replace('process.argv.length!==2','process.argv.length!==1');
 assert.ok(command.includes(runner));assert.ok(command.endsWith('await main();\nSQUARE_IDENTITY_PREVIEW\n'));
 const checked=spawnSync('bash',['-n',new URL('../docs/render/square-identity-preview.sh',import.meta.url).pathname],{encoding:'utf8',timeout:5000});assert.equal(checked.status,0,checked.stderr);
});
