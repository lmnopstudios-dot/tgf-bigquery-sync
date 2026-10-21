import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {historyCoverageSql,historyLinkStages,historyLinkMaterializationSql} from '../customer-identity/history-sql.js';
import {observations,batchMergeSql,collectHistory,commitBatch,correspondence,publishHistory} from '../customer-identity/history.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {identityConfiguration} from '../oracle/customer-identity.js';

export function execute(sql,tables,params={}){
  const script=`import sqlite3,json,sys,re,hashlib
p=json.loads(sys.argv[1]);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.create_function('IF',3,lambda a,b,d:b if a else d)
c.create_function('CONCAT',-1,lambda *x:None if any(v is None for v in x) else ''.join(str(v) for v in x))
c.create_function('SHA256',1,lambda x:None if x is None else hashlib.sha256(x.encode()).digest())
c.create_function('TO_HEX',1,lambda x:None if x is None else x.hex().upper())
c.create_function('DATE',-1,lambda *x:x[0][:10] if x[0] else None)
class CountIf:
 def __init__(self): self.n=0
 def step(self,x): self.n+=1 if x else 0
 def finalize(self): return self.n
c.create_aggregate('COUNTIF',1,CountIf)
for name,t in p['tables'].items():
 c.execute('CREATE TABLE '+name+'('+','.join(t['columns'])+')')
 c.executemany('INSERT INTO '+name+' VALUES('+','.join('?' for _ in t['columns'])+')',t['rows'])
c.commit()
q=p['sql'].replace('UNION DISTINCT','UNION')
q=re.sub(r'COUNTIF\\(([^()]+)\\)',r'SUM(CASE WHEN \\1 THEN 1 ELSE 0 END)',q)
for statement in q.split(';')[:-1]:
 if statement.strip(): c.execute(statement,p['params'])
print(json.dumps([dict(r) for r in c.execute(q.split(';')[-1],p['params'])]))`;
  const r=spawnSync('python3',['-c',script,JSON.stringify({sql,tables,params})],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
const orders=[['ww','1',null],['ww','2',null],['usd','1',null],['shopify','s1','C1'],['shopify','import','C1'],['ww','3','A'],['ww','4','B'],['shopify','s2','C2'],['ww','5',null],['ww','6',null],['ww','7',null],['shopify','s3','C3'],['ww','8',null],['ww','9',null]];
const oc=['source','order_id','customer_id','created_at','currency','financial_status','cancelled'];
const makeObs=(source,order_id,mail,customer=null,provider='retained')=>observations({source,orderId:order_id,recordId:order_id,record:{email:mail},provider,profileKey:customer?`${source==='shopify'?'shopify':'woo'}:${source}:${customer}`:null});
const evidence=[...makeObs('ww','1','one@real.org'),...makeObs('ww','2','one@real.org'),...makeObs('usd','1','one@real.org'),...makeObs('shopify','s1','one@real.org','C1'),...makeObs('shopify','import','one@real.org','C1'),
 ...makeObs('ww','3','shared@real.org','A'),...makeObs('ww','4','shared@real.org','B'),...makeObs('shopify','s2','shared@real.org','C2'),
 ...makeObs('ww','5','before@real.org'),...makeObs('ww','5','after@real.org'),...makeObs('shopify','s3','before@real.org','C3'),
 ...makeObs('ww','6','unique@real.org'),...makeObs('ww','1','guest@example.com',null,'native'),
 ...observations({source:'ww',orderId:'8',recordId:'8',provider:'native',failure:'unavailable'})];
const ec=['source','order_id','profile_key','normalized','email_state','provider','native_customer_id'];
const tables={history_orders:{columns:oc,rows:orders.map((r,i)=>[...r,`2024-01-${String(i+1).padStart(2,'0')}T00:00:00Z`,'GBP',null,false])},email_observations:{columns:ec,rows:evidence.map(r=>ec.map(c=>r[c]))}};
const originalLinks=readFileSync(new URL('./fixtures/customer-history/original-link-ctes.sql',import.meta.url),'utf8');
const localSql=sql=>sql.replaceAll('`fixture.customer_identity.history_orders`','history_orders').replaceAll('`fixture.customer_identity.email_observations`','email_observations');
const materialized=localSql(historyLinkMaterializationSql('fixture','customer_identity'));
const sorted=rows=>rows.toSorted((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
function materializedResolutions(input){
  const actual=execute(`${materialized} SELECT * FROM h_resolved`,input);
  const original=execute(`WITH ${originalLinks} SELECT * FROM h_resolved`,input);
  assert.deepEqual(sorted(actual),sorted(original));
  return actual;
}
const resolutions=()=>materializedResolutions(tables);

test('actual additive SQL preserves historical guest evidence, links stores, and globally excludes conflicts/shared addresses',()=>{
  const rows=resolutions();assert.equal(rows.length,orders.length);
  const get=(source,oid)=>rows.find(r=>r.source===source&&r.order_id===oid);
  for(const [s,o] of [['ww','1'],['ww','2'],['usd','1'],['shopify','s1']])assert.equal(get(s,o).resolution,'matched');
  assert.equal(new Set(rows.filter(r=>r.resolution==='matched').map(r=>r.canonical_customer_ref)).size,1);
  for(const [s,o] of [['ww','3'],['ww','4'],['shopify','s2'],['ww','5'],['shopify','s3']])assert.equal(get(s,o).resolution,'ambiguous');
  assert.equal(get('ww','6').resolution,'unmatched');assert.equal(get('ww','7').resolution,'unavailable');assert.equal(get('ww','8').resolution,'unavailable');
  assert.notEqual(get('ww','7').canonical_customer_ref,get('ww','9').canonical_customer_ref);
  assert.equal(get('ww','1').customer_id,null);
  const coverage=execute(localSql(historyCoverageSql('fixture','customer_identity')),tables);
  for(const r of coverage)assert.equal(r.matched+r.unmatched+r.ambiguous+r.unavailable,r.orders);
  assert.equal(coverage.find(r=>r.source==='ww').shared_address_orders,2);
  assert.equal(coverage.find(r=>r.source==='ww').conflicting_orders,1);
});

test('registered historical IDs propagate usable order evidence even when current native Woo is a guest; Metorik guest relationships stay distinct',()=>{
  const mids=observations({source:'usd',record:{metorik_customer_id:77,customer_id:0,email:'meta@real.org'},provider:'metorik_customers',recordId:'77',profileKey:'metorik:usd:77'});
  const associated=observations({source:'usd',record:{metorik_customer_id:77,customer_id:0,email:null},provider:'metorik_orders',recordId:'m1',orderId:'m1',profileKey:'metorik:usd:77'});
  const more={history_orders:{columns:oc,rows:[['ww','r1','OLD','2024-01-01T00:00:00Z','GBP',null,false],['ww','r2','OLD','2024-01-02T00:00:00Z','GBP',null,false],['shopify','s','C','2025-01-01T00:00:00Z','GBP',null,false],['usd','m1',null,'2024-01-01T00:00:00Z','USD',null,false],['shopify','m2','M','2025-01-01T00:00:00Z','USD',null,false]]},email_observations:{columns:ec,rows:[...makeObs('ww','r1','old@real.org'),...makeObs('shopify','s','old@real.org','C'),...mids,...associated,...makeObs('shopify','m2','meta@real.org','M')].map(r=>ec.map(c=>r[c]))}};
  const rows=materializedResolutions(more);
  assert.ok(rows.every(r=>r.resolution==='matched'));assert.equal(rows.find(r=>r.order_id==='r1').canonical_customer_ref,rows.find(r=>r.order_id==='r2').canonical_customer_ref);
  assert.equal(rows.find(r=>r.order_id==='m1').customer_id,null);
  const aliasCustomer=observations({source:'ww',record:{metorik_customer_id:123,customer_id:0,email:'old@real.org'},provider:'metorik_customers',recordId:'123',profileKey:'metorik:ww:123'});
  const aliasOrder=observations({source:'ww',record:{metorik_customer_id:123,customer_id:0,email:null},provider:'metorik_orders',recordId:'r1',orderId:'r1',profileKey:'metorik:ww:123'});
  more.email_observations.rows.push(...[...aliasCustomer,...aliasOrder].map(r=>ec.map(c=>r[c])));
  const aliasRows=materializedResolutions(more);
  assert.ok(aliasRows.every(r=>r.resolution==='matched'));assert.equal(aliasRows.find(r=>r.order_id==='r1').shared_email,0);
  more.history_orders.rows.push(['ww','later-guest',null,'2024-03-01T00:00:00Z','GBP',null,false]);
  more.email_observations.rows.push(...observations({source:'ww',record:{metorik_customer_id:123,customer_id:0,email:null},provider:'metorik_orders',recordId:'later-guest',orderId:'later-guest',profileKey:'metorik:ww:123'}).map(r=>ec.map(c=>r[c])));
  const continued=materializedResolutions(more);
  assert.ok(continued.every(r=>r.resolution==='matched'));assert.equal(continued.find(r=>r.order_id==='later-guest').customer_id,null);
});

function expandReplace(body,alias,columns){
  const marker=`SELECT ${alias}.* REPLACE(`,start=body.indexOf(marker);if(start<0)return body;
  let depth=1,end=start+marker.length;for(;end<body.length&&depth;end++){if(body[end]==='(')depth++;if(body[end]===')')depth--;}
  const inside=body.slice(start+marker.length,end-1);let d=0,s=0;const parts=[];
  for(let i=0;i<=inside.length;i++){if(inside[i]==='(')d++;if(inside[i]===')')d--;if(i===inside.length||inside[i]===','&&d===0){parts.push(inside.slice(s,i));s=i+1;}}
  const replacements=new Map(parts.map(p=>{const m=/^(.*) AS (\w+)$/s.exec(p.trim());assert.ok(m,p);return [m[2],m[1]];}));
  return body.slice(0,start)+'SELECT '+columns.map(c=>`${replacements.get(c)||alias+'.'+c} AS ${c}`).join(',')+body.slice(end);
}
test('actual Oracle SQL deduplicates guest Woo originals, excludes import copies, and recalculates sequence/first observation',()=>{
  const identity={dataset:'customer_identity',snapshot:'test',mode:'email_candidate_v1',orderLinks:true};
  const parsed=cohortRelations(customerJourneySql('fixture','summary',null,null,identity));
  const cols=['source_platform','source_store','channel','order_ref','source_customer_id','order_timestamp','status','currency','order_total','refunds','migrated','cancelled','customer_record_present','persisted_guest'];
  const raw=(s,o,c,date,migrated=false)=>[s==='shopify'?'shopify':'woo',s,'Online',o,c,date,s==='shopify'?'paid':'completed','GBP',100,0,migrated,false,true,c===null];
  const first=raw('ww','1',null,'2024-01-01T00:00:00Z');
  const rawRows=[first,first,raw('ww','2',null,'2024-01-10T00:00:00Z'),raw('usd','1',null,'2024-02-01T00:00:00Z'),raw('shopify','s1','C1','2025-12-01T00:00:00Z'),raw('shopify','import','C1','2024-01-01T00:00:00Z',true),raw('ww','7',null,'2024-01-03T00:00:00Z'),raw('ww','9',null,'2024-01-04T00:00:00Z')];
  const refunded=raw('ww','refunded',null,'2024-02-01T00:00:00Z');refunded[9]=100;
  const cancelled=raw('shopify','cancelled','C1','2024-02-01T00:00:00Z');cancelled[11]=true;
  const failed=raw('ww','failed',null,'2024-02-01T00:00:00Z');failed[6]='failed';rawRows.push(refunded,cancelled,failed);
  const keep=['raw_orders','orders','qualifying_orders','ranked_orders','entry_orders'];
  const rs=parsed.relations.filter(r=>keep.includes(r.name));
  const rawCte=rs.find(r=>r.name==='raw_orders');const innerStart=rawCte.body.indexOf('FROM (')+6,innerEnd=rawCte.body.lastIndexOf(') r LEFT JOIN');
  rawCte.body=rawCte.body.slice(0,innerStart)+'SELECT * FROM fixture_raw'+rawCte.body.slice(innerEnd);
  rawCte.body=expandReplace(rawCte.body,'r',cols);
  const orderCte=rs.find(r=>r.name==='orders');orderCte.body=`SELECT ${cols.join(',')} FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY source_platform,source_store,order_ref ORDER BY order_timestamp,refunds DESC,migrated DESC,cancelled DESC,status) n FROM raw_orders) WHERE n=1`;
  const q=rs.find(r=>r.name==='qualifying_orders');q.body=expandReplace(q.body,'q',[...cols,'governed_customer_ref']);
  const resolved=resolutions();const mappingCols=['source_store','source_order_id','source_customer_id','canonical_customer_ref','resolution','financial_status','cancelled'];
  const actual={...tables,fixture_raw:{columns:cols,rows:rawRows},fixture_mapping:{columns:mappingCols,rows:resolved.map(r=>[r.source,r.order_id,r.customer_id,r.canonical_customer_ref,r.resolution,r.financial_status,r.cancelled])}};
  const ctes='ci_mapping AS (SELECT * FROM fixture_mapping),'+parsed.relations.find(r=>r.name==='ci_aliases').body.replace(/^/, 'ci_aliases AS (')+'),'+rs.map(r=>`${r.name} AS (${r.body})`).join(',');
  const params={time_zone:'UTC',observation_end:'2026-10-19',first_order_semantic:'first_observed_ever',cohort_entry_start:'2024-01-01',cohort_entry_end:'2026-10-19',entry_source:null,entry_channel:null};
  const rows=execute(`WITH ${ctes} SELECT source_store,order_ref,source_customer_id,governed_customer_ref,order_sequence FROM ranked_orders`,actual,params);
  assert.equal(rows.length,6);assert.ok(!rows.some(r=>r.order_ref==='import'));
  assert.equal(rows.find(r=>r.order_ref==='s1').order_sequence,4);
  assert.ok(rows.filter(r=>r.source_store==='ww').every(r=>r.source_customer_id===null));
  const entry=execute(`WITH ${ctes} SELECT source_store,order_ref FROM entry_orders`,actual,params);
  assert.equal(entry.length,3);assert.ok(entry.some(r=>r.source_store==='ww'&&r.order_ref==='1'));assert.ok(!entry.some(r=>r.source_store==='shopify'));
  // A source-local registered ID can bring in an older order arriving after
  // the frozen roster, without inventing an ID for either guest record.
  const sharedRef=resolved.find(r=>r.source==='ww'&&r.order_id==='1').canonical_customer_ref;
  const extended={...actual,fixture_raw:{columns:cols,rows:[...rawRows,raw('ww','older','REGISTERED','2019-01-01T00:00:00Z'),raw('ww','known','REGISTERED','2024-01-05T00:00:00Z')]},fixture_mapping:{columns:mappingCols,rows:[...actual.fixture_mapping.rows,['ww','known','REGISTERED',sharedRef,'matched',null,false]]}};
  const extendedRows=execute(`WITH ${ctes} SELECT source_store,order_ref,order_sequence FROM ranked_orders`,extended,params);
  assert.equal(extendedRows.find(r=>r.order_ref==='older').order_sequence,1);assert.equal(extendedRows.find(r=>r.order_ref==='s1').order_sequence,6);
  const extendedEntry=execute(`WITH ${ctes} SELECT source_store,order_ref FROM entry_orders`,extended,params);
  assert.equal(extendedEntry.length,2);assert.ok(!extendedEntry.some(r=>r.order_ref==='1'||r.source_store==='shopify'));
});

test('evidence IDs are idempotent; placeholder/null and changed usable revisions remain additive',()=>{
  const one=makeObs('ww','1','kept@real.org'),two=makeObs('ww','1','kept@real.org');
  assert.deepEqual(one.map(r=>r.evidence_id),two.map(r=>r.evidence_id));
  assert.notEqual(one[0].evidence_id,makeObs('ww','1','guest@example.com')[0].evidence_id);
  const sql=batchMergeSql('fixture','identity',{email_observations:'stage'});
  assert.doesNotMatch(sql,/THEN UPDATE SET.*email=/);assert.match(sql,/BEGIN TRANSACTION/);assert.match(sql,/history_progress/);
  assert.ok(correspondence({id:1,date_created_gmt:'2024-01-01T00:00:00',currency:'GBP'},{order_id:'1',created_at:'2024-01-01T00:00:00Z',currency:'GBP'}));
  assert.ok(correspondence({order_id:1,date_created:'2024-01-01T00:00:00',currency:'GBP'},{order_id:'1',created_at:'2024-01-01T00:00:00Z',currency:'GBP'}));
  assert.equal(correspondence({id:2},{order_id:'1'}),false);
});
test('collector resumes a committed Shopify batch, preserves explicit null customers, and never logs records',async()=>{
  const commits=[];let complete=false;
  const o={source:'shopify',dataset:'identity',start:'2022-09-24',end:'2026-10-19'};
  const bq={query:async q=>q.query.includes('history_progress')?[complete?[{cursor:'gid://shopify/Order/1',complete:true}]:[]]:[[{source:'shopify',order_id:'gid://shopify/Order/1',customer_id:null,created_at:'2024-01-01T00:00:00Z',currency:null,financial_status:null,cancelled:null}]]};
  const args={bigquery:bq,project:'fixture',o,adapter:'shopify',client:async()=>({graphql:async()=>({nodes:[{id:'gid://shopify/Order/1',email:'private@real.org',customer:null,createdAt:'2024-01-01T00:00:00Z',displayFinancialStatus:'PAID',cancelledAt:null}]})}),commit:async b=>{commits.push(b);complete=b.complete;}};
  const result=await collectHistory(args);assert.equal(result.status,'complete');assert.equal(commits[0].orders[0].customer_id,null);
  assert.doesNotMatch(JSON.stringify(result),/private@|gid:\/\//);
  const resume=await collectHistory(args);assert.equal(resume.records,0);assert.equal(commits.length,1);
  assert.equal(identityConfiguration({ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'test'}).orderLinks,true);
});

test('atomic staging deduplicates retries and never advances a checkpoint on failed load',async()=>{
  const stages=[],loaded=[],queries=[],deleted=[];let fail=false;
  const ds={createTable:async name=>{stages.push(name);},table:name=>({createLoadJob:async file=>{loaded.push((await readFile(file,'utf8')).split('\n').map(JSON.parse));if(fail)throw Error('load unavailable');return [{getMetadata:async()=>[{status:{state:'DONE'}}]}];},delete:async()=>deleted.push(name)})};
  const bq={dataset:()=>ds,query:async q=>{queries.push(q);return [[]];}};
  const e=makeObs('ww','1','kept@real.org');const args={bigquery:bq,project:'fixture',dataset:'identity',jobKey:'job',source:'ww',adapter:'native',revision:'v2',cursor:'1',expectedCursor:'',complete:true,evidence:[...e,...e]};
  await commitBatch(args);assert.equal(loaded[0].length,e.length);assert.equal(queries.length,1);assert.match(queries[0].query,/Concurrent progress changed/);assert.equal(deleted.length,1);
  fail=true;await assert.rejects(commitBatch(args));assert.equal(queries.length,1);assert.equal(deleted.length,1);
});
test('publication verifies original rosters, adapter completion and matches before atomically marking readiness',async()=>{
  const queries=[];await publishHistory({bigquery:{query:async q=>{queries.push(q);return [[]];}},project:'fixture',dataset:'identity',snapshot:'v2'});
  assert.equal(queries.length,1);const q=queries[0];assert.ok(q.query.includes(historyLinkMaterializationSql('fixture','identity')));assert.ok(q.query.indexOf('Duplicate original orders')<q.query.indexOf('CREATE TEMP TABLE h_orders'));assert.ok(q.query.indexOf('CREATE TEMP TABLE h_resolved')<q.query.indexOf('INSERT INTO `fixture.identity.identity_order_links`'));assert.equal(q.params.start.value,'1900-01-01');assert.match(q.query,/Canonical roster missing/);assert.match(q.query,/Shopify collection incomplete/);assert.match(q.query,/No supported cross-source matches/);assert.match(q.query,/COMMIT TRANSACTION/);assert.equal(q.maximumBytesBilled,'1000000000');
});

test('Metorik collector uses the production page/auth contract and retains positive guest customer IDs',async()=>{
  const commits=[],requests=[];
  const result=await collectHistory({bigquery:{query:async()=>[[]]},project:'fixture',o:{source:'usd',dataset:'identity',start:'2022-09-24',end:'2026-10-19'},adapter:'metorik_customers',env:{METORIK_US_API_KEY:'fixture-token'},fetchImpl:async(url,opts)=>{
    requests.push({url:new URL(url),opts});return new Response(JSON.stringify({customers:[{metorik_customer_id:900,customer_id:0,email:'usable@real.org'}],meta:{current_page:1,per_page:50,has_more_pages:false}}));
  },commit:async b=>commits.push(b)});
  assert.equal(result.status,'complete');assert.equal(requests.length,1);assert.equal(requests[0].opts.headers.Authorization,'Bearer fixture-token');assert.equal(requests[0].url.searchParams.get('per_page'),'50');assert.equal(requests[0].url.searchParams.has('start_date'),false);
  const row=commits[0].evidence.find(r=>r.normalized);assert.equal(row.profile_key,'metorik:usd:900');assert.equal(row.native_customer_id,null);assert.equal(row.metorik_customer_id,'900');assert.doesNotMatch(JSON.stringify(result),/usable@|900|fixture-token/);
});
test('transport failures and mismatched original orders cannot advance collection progress',async()=>{
  const original={source:'ww',order_id:'1',customer_id:'OLD',created_at:'2024-01-01T00:00:00Z',currency:'GBP'};
  const bq={query:async q=>q.query.includes('history_progress')?[[]]:[[original]]};
  const args={bigquery:bq,project:'fixture',o:{source:'ww',dataset:'identity',start:'2022-09-24',end:'2026-10-19'},adapter:'native',commit:async()=>assert.fail('No checkpoint may advance')};
  await assert.rejects(collectHistory({...args,nativeClient:async()=>async()=>{throw Error('request unavailable');}}));
  await assert.rejects(collectHistory({...args,nativeClient:async()=>async()=>({id:2,date_created_gmt:'2024-01-01T00:00:00Z',currency:'GBP',billing:{email:'wrong@real.org'}})}),/correspondence/);
});

test('materialization bounds planner expansion to ordered physical stages without persistent writes or truncation',()=>{
  const stages=historyLinkStages('fixture','customer_identity');
  assert.equal(stages.length,14);
  const seen=new Set();
  for(const {name,sql} of stages){
    for(const dependency of sql.match(/\bh_[a-z_]+\b/g)||[])assert.ok(seen.has(dependency),`${name} depends on ${dependency}`);
    seen.add(name);
  }
  const coverage=historyCoverageSql('fixture','customer_identity');
  assert.equal((coverage.match(/CREATE TEMP TABLE/g)||[]).length,14);
  assert.doesNotMatch(coverage,/INSERT INTO|MERGE|DELETE|TRUNCATE|LIMIT|WITH h_orders/);
  assert.match(coverage,/^BEGIN TRANSACTION;/);
  assert.ok(coverage.indexOf('COMMIT TRANSACTION;')>coverage.indexOf('CREATE TEMP TABLE h_resolved'));
  const duplicated={...tables,email_observations:{...tables.email_observations,rows:[...tables.email_observations.rows,...tables.email_observations.rows]}};
  assert.deepEqual(sorted(materializedResolutions(duplicated)),sorted(resolutions()));
  const empty={history_orders:{columns:oc,rows:[]},email_observations:{columns:ec,rows:[]}};
  assert.deepEqual(materializedResolutions(empty),[]);
});
