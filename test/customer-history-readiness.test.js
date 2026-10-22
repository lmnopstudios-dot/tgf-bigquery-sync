import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {identityAwareService,identityConfiguration,identityCoverageSql,IDENTITY_READINESS_BYTES} from '../oracle/customer-identity.js';
import {READINESS_AUDIT_FIELDS,auditSchema,readinessAuditSql,auditMatchesRepair,readinessFailure} from '../diagnostics/customer-history-readiness-audit.js';
import {main as probe} from '../diagnostics/customer-history-readiness.mjs';
import {SCOPE} from '../customer-identity/collect.js';

const env=mode=>({ORACLE_CUSTOMER_IDENTITY_MODE:mode,ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'history-20261022-billing-v3'});
const counts=[['ww',39176],['usd',4322],['shopify',14967]];
const coverage=()=>counts.map(([source_store,qualifying_orders])=>({source_store,qualifying_orders,identified_profiles:10,mapped_profiles:5,unmatched_profiles:5,matched_orders:qualifying_orders,unmatched_orders:0,ambiguous_orders:0,unavailable_orders:0,email_linked_guest_or_unknown_records:0,conflicting_orders:0,shared_address_orders:0}));
const marker=mode=>({state:'ready',start_date:mode==='email_candidate_v2'?'1900-01-01':SCOPE.start,end_date:SCOPE.end,mapping_count:58465});
const audit=()=>({marker_count:1,markers_matching_reader_dates_state_count:1,retained_original_marker:1,markers_matching_link_count:1,total_links:58465,distinct_keys:58465,duplicate_keys:0,conflicting_keys:0,invalid_mapping_rows:0,sources:counts.map(([source,row_count])=>({source,row_count}))});

for(const mode of ['email_candidate_v1','email_candidate_v2'])test(`${mode} readiness covers uncached table billing floors without extending five-second waits`,async()=>{
  const calls=[],paths=[];
  const bq={query:async q=>{
    calls.push(q);
    const snapshot=q.query.startsWith('SELECT state,');
    // Model BigQuery's billing minimum, including the formerly failing ceiling.
    const floor=(snapshot?1:mode==='email_candidate_v2'?2:1)*10*1024*1024;
    if(Number(q.maximumBytesBilled)<floor)throw Object.assign(Error('private body'),{code:400,errors:[{reason:'bytesBilledLimitExceeded'}]});
    assert.equal(q.jobTimeoutMs,5000);
    return [snapshot?[marker(mode)]:coverage()];
  }};
  const service=identityAwareService({bigquery:bq,project:'fixture',env:env(mode)},({identity})=>({analyzeCustomerJourney:async(_args,options)=>{paths.push(identity);assert.ok(options.timeoutMs<=20000);return {};}}),()=> 'WITH qualifying_orders AS (SELECT 1 source_customer_id, 1 source_store) SELECT * FROM qualifying_orders');
  const r=await service.analyzeCustomerJourney({}, {timeoutMs:20000});
  assert.equal(r.identity_evidence.activation,'active');assert.equal(r.identity_evidence.mode,mode);
  assert.equal(paths.length,1);assert.equal(!!paths[0].orderLinks,mode==='email_candidate_v2');
  assert.equal(calls[0].maximumBytesBilled,String(10*1024*1024));
  assert.equal(calls[1].maximumBytesBilled,SCOPE.bytes);
  if(mode==='email_candidate_v2')assert.match(calls[1].query,/Identity snapshot integrity failed/);
});

test('decimal marker ceiling is below the verified floor; coverage cap covers both integrity tables and stays unchanged',()=>{
  assert.ok(10000000<10*1024*1024);
  assert.equal(IDENTITY_READINESS_BYTES.snapshot,'10485760');
  assert.equal(IDENTITY_READINESS_BYTES.coverage,'1000000000');
  assert.ok(Number(IDENTITY_READINESS_BYTES.coverage)>=20*1024*1024);
  const q=identityCoverageSql('', 'fixture',identityConfiguration(env('email_candidate_v2')));
  assert.deepEqual([...new Set([...q.matchAll(/`fixture.customer_identity.([^`]+)`/g)].map(m=>m[1]))].sort(),['identity_order_links','identity_snapshots']);
});

test('v2 label follows requested mode while orderLinks, not that label, selects guarded order-level SQL',()=>{
  const v1=identityConfiguration(env('email_candidate_v1')),v2=identityConfiguration(env('email_candidate_v2'));
  assert.equal(v1.mode,'email_candidate_v1');assert.equal(v1.orderLinks,undefined);
  assert.equal(v2.mode,'email_candidate_v2');assert.equal(v2.orderLinks,true);
  // Changing a metadata label alone cannot select the profile-link reader.
  assert.equal(identityCoverageSql('', 'fixture',v2),identityCoverageSql('', 'fixture',{...v2,mode:'email_candidate_v1'}));
});

test('coverage integrity failures still fall back; correction cannot bypass a warehouse integrity rejection',async()=>{
  let fallback=0;
  const service=identityAwareService({project:'fixture',env:env('email_candidate_v2'),bigquery:{query:async q=>{
    if(q.query.startsWith('SELECT state,'))return [[marker('email_candidate_v2')]];
    throw Object.assign(Error('Identity snapshot integrity failed'),{errors:[{reason:'invalidQuery'}]});
  }}},({identity})=>({analyzeCustomerJourney:async()=>{assert.equal(identity,null);fallback++;return {};}}),()=> 'unused');
  const r=await service.analyzeCustomerJourney({}, {timeoutMs:20000});
  assert.equal(fallback,1);assert.equal(r.identity_evidence.activation,'fallback');
});

test('aggregate audit uses actual marker/link fields, unreserved aliases and a typed timestamp',()=>{
  const sql=readinessAuditSql('fixture','customer_identity');
  assert.doesNotMatch(sql,/COUNT\(\*\)\s+(?:AS\s+)?rows\b/i);
  assert.match(sql,/COUNT\(\*\) row_count/);
  assert.match(sql,/created_at=@keep_created_at/);
  assert.doesNotMatch(sql,/\bstatus\b|\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/);
  for(const [name,expected] of Object.entries(READINESS_AUDIT_FIELDS)) {
    const valid={type:'TABLE',schema:{fields:expected.map(f=>({...f,type:({INT64:'INTEGER',BOOL:'BOOLEAN'}[f.type]||f.type)}))}};
    assert.equal(auditSchema(valid,expected).valid,true,name);
    assert.equal(auditSchema({...valid,schema:{fields:valid.schema.fields.slice(1)}},expected).valid,false,name);
    assert.equal(auditSchema({...valid,schema:{fields:[...valid.schema.fields,{name:'future_mapping_field',type:'STRING'}]}},expected).valid,false,name);
  }
  assert.equal(auditMatchesRepair(audit()),true);
  for(const wrong of [{marker_count:2},{duplicate_keys:1},{conflicting_keys:1},{retained_original_marker:0},{sources:[{source:'ww',row_count:58465}]}])assert.equal(auditMatchesRepair({...audit(),...wrong}),false);
});

test('sanitized errors retain billing reason, SQL category/position and only known identifiers; never messages or customer values',()=>{
  const billing=readinessFailure({code:400,errors:[{reason:'bytesBilledLimitExceeded',message:'private@example.org'}]});
  assert.equal(billing.bigquery_reason,'bytesBilledLimitExceeded');
  const syntax=readinessFailure({code:400,errors:[{reason:'invalidQuery',location:'query',message:'Syntax error: Unexpected keyword ROWS at [29:14]; customer private@example.org c_private'}]});
  assert.equal(syntax.bigquery_reason,'invalidQuery');assert.equal(syntax.error_category,'sql_syntax');assert.deepEqual(syntax.statement_location,{line:29,column:14});assert.equal(syntax.unexpected_keyword,'ROWS');
  const field=readinessFailure({errors:[{reason:'invalidQuery',message:'Unrecognized name: source_order_id at [4:2]'}]});
  assert.equal(field.known_field,'source_order_id');
  const hidden=readinessFailure({errors:[{reason:'invalidQuery',message:'Unrecognized name: private_customer_123 at [7:1]'}]});
  assert.equal(hidden.known_field,null);
  assert.doesNotMatch(JSON.stringify([billing,syntax,hidden]),/private|@|customer_123/);
});

function transport({failure,missingField=false}={}) {
  const queries=[],metadata=[];
  const bq={dataset:()=>({table:name=>({getMetadata:async()=>{
    metadata.push(name);
    const fields=READINESS_AUDIT_FIELDS[name].map(f=>({...f,type:({INT64:'INTEGER',BOOL:'BOOLEAN'}[f.type]||f.type)}));
    return [{type:'TABLE',schema:{fields:missingField?fields.slice(1):fields}}];
  }})}),createQueryJob:async q=>{
    queries.push(q);
    const isMarker=q.query.startsWith('SELECT state,'),isCoverage=q.query.startsWith('WITH ci_counts');
    if(failure==='billing'&&isMarker)throw Object.assign(Error('private@example.org'),{code:400,errors:[{reason:'bytesBilledLimitExceeded'}]});
    if(failure==='audit'&&!isMarker&&!isCoverage)throw Object.assign(Error('private query'),{code:400,errors:[{reason:'invalidQuery',message:'Syntax error: Unexpected keyword ROWS at [3:8]'}]});
    const rows=isMarker?[marker('email_candidate_v2')]:isCoverage?coverage():[audit()];
    return [{id:q.jobId,getQueryResults:async()=>[rows,null,{jobComplete:true}],getMetadata:async()=>[{status:{state:'DONE'},statistics:{query:{cacheHit:false,totalBytesProcessed:'10',totalBytesBilled:isMarker?'10485760':'20971520'}}}],cancel:async()=>assert.fail('successful query must not cancel')}];
  }};
  return {bq,queries,metadata};
}
for(const failure of [undefined,'billing','audit','schema'])test(`post-deployment probe ${failure||'success'} uses actual wrapper and suppresses all analytics`,async()=>{
  const f=transport({failure,missingField:failure==='schema'}),records=[];
  const status=await probe({clientFactory:()=>({bigquery:f.bq,project:'gf-full-data'}),emit:x=>records.push(JSON.parse(x))});
  assert.equal(status,failure?2:0);
  assert.ok(records.some(x=>x.check==='reader_decision'&&x.analytical_query_executed===false));
  assert.ok(f.queries.every(q=>q.useQueryCache===false));
  assert.ok(f.queries.length<=3);
  assert.ok(f.queries.every(q=>!/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/.test(q.query)));
  assert.equal(records.find(x=>x.check==='deployed_contract').reader_mode_label,'email_candidate_v2');
  if(failure==='billing')assert.equal(records.find(x=>x.check==='original_readiness_rejection').bigquery_reason,'bytesBilledLimitExceeded');
  if(failure==='audit')assert.deepEqual(records.find(x=>x.check==='aggregate_contract_audit').statement_location,{line:3,column:8});
  if(failure==='schema')assert.equal(f.queries.length,2);
  if(!failure) {
    assert.equal(f.queries[0].maximumBytesBilled,'10485760');assert.equal(f.queries[1].maximumBytesBilled,'1000000000');
    assert.equal(f.queries[2].params.keep_created_at.value,'2026-10-22T07:31:49.447Z');
    assert.ok(records.some(x=>x.check==='summary'&&x.readiness_verified&&x.audit_verified));
  }
  assert.doesNotMatch(JSON.stringify(records),/private|@/);
});

test('generated aggregate audit evaluates marker, full-field duplicate/conflict, key validity and source counts on relational fixtures',()=>{
  const script=String.raw`import sys,json,sqlite3,re
p=json.loads(sys.argv[1]);q=p['sql'];c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.create_function('REGEXP_CONTAINS',2,lambda s,p:bool(re.search(p,s)) if s is not None else None)
c.execute('CREATE TABLE markers(snapshot_id,state,start_date,end_date,mapping_count,created_at)')
c.execute('CREATE TABLE links(snapshot_id,source_store,source_order_id,source_customer_id,canonical_customer_ref,resolution,financial_status,cancelled,conflicting_email,shared_email)')
q=q.replace('\x60fixture.customer_identity.identity_snapshots\x60','markers').replace('\x60fixture.customer_identity.identity_order_links\x60','links')
q=q.replace("r'^c_[A-Fa-f0-9]{64}$'","'^c_[A-Fa-f0-9]{64}$'").replace('AS STRING','AS TEXT')
q=q.replace('TO_JSON_STRING(STRUCT(source_customer_id,canonical_customer_ref,resolution,\n      financial_status,cancelled,conflicting_email,shared_email))','json_array(source_customer_id,canonical_customer_ref,resolution,financial_status,cancelled,conflicting_email,shared_email)')
# SQLite uses COUNT(CASE...) for COUNTIF, preserving zero on empty relations.
while 'COUNTIF(' in q:
 a=q.index('COUNTIF(');i=a+8;depth=1;quoted=False
 while depth:
  ch=q[i]
  if ch=="'":quoted=not quoted
  if not quoted:
   if ch=='(':depth+=1
   elif ch==')':depth-=1
  i+=1
 q=q[:a]+'COUNT(CASE WHEN '+q[a+8:i-1]+' THEN 1 END)'+q[i:]
a=q.index('ARRAY(SELECT AS STRUCT');b=q.index(') sources',a)+len(') sources')
q=q[:a]+"(SELECT json_group_array(json_object('source',source,'row_count',row_count)) FROM (SELECT CASE WHEN source_store IN ('ww','usd','shopify') THEN source_store ELSE 'unexpected_source' END source,COUNT(*) row_count FROM snapshot_links GROUP BY source_store ORDER BY source_store)) sources"+q[b:]
results={}
for mode in ['valid','identical','conflict','invalid','markers','empty']:
 c.execute('DELETE FROM markers');c.execute('DELETE FROM links')
 if mode!='empty':
  for i in range(2 if mode=='markers' else 1):c.execute("INSERT INTO markers VALUES('snapshot','ready','1900-01-01','2026-10-19',3,?)",['2026-10-22T07:31:49.447Z'])
  for source in ['ww','usd','shopify']:c.execute("INSERT INTO links VALUES('snapshot',?,'order','profile',?,'matched','paid',NULL,0,0)",[source,'bad' if mode=='invalid' and source=='ww' else 'c_'+'a'*64])
  if mode in ['identical','conflict']:c.execute("INSERT INTO links VALUES('snapshot','ww','order','profile',?,'matched','paid',NULL,0,0)",['c_'+('b' if mode=='conflict' else 'a')*64])
 row=dict(c.execute(q,{'snapshot':'snapshot','reader_start':'1900-01-01','reader_end':'2026-10-19','keep_created_at':'2026-10-22T07:31:49.447Z'}).fetchone());row['sources']=json.loads(row['sources']);results[mode]=row
print(json.dumps(results))`;
  const r=spawnSync('python3',['-c',script,JSON.stringify({sql:readinessAuditSql('fixture','customer_identity')})],{encoding:'utf8',timeout:5000});
  assert.equal(r.status,0,r.stderr||r.error?.message);const rows=JSON.parse(r.stdout);
  assert.equal(rows.valid.marker_count,1);assert.equal(rows.valid.total_links,3);assert.equal(rows.valid.distinct_keys,3);
  assert.equal(rows.valid.markers_matching_link_count,1);assert.equal(rows.valid.retained_original_marker,1);
  assert.deepEqual(rows.valid.sources.map(r=>r.row_count),[1,1,1]);
  assert.equal(rows.identical.duplicate_keys,1);assert.equal(rows.identical.conflicting_keys,0);assert.equal(rows.identical.markers_matching_link_count,0);
  assert.equal(rows.conflict.conflicting_keys,1);assert.equal(rows.invalid.invalid_mapping_rows,1);
  assert.equal(rows.markers.marker_count,2);assert.equal(rows.empty.marker_count,0);assert.equal(rows.empty.total_links,0);
});
