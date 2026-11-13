import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {performanceFixture as fixture} from './helpers/loyalty-performance-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {createLoyaltyReportService} from '../oracle/loyaltylion.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {createBaselineOverviewService} from '../oracle/baseline-overview.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {performanceQueries,observationCovered,performanceWindows,assertPerformanceEvidence} from '../oracle/loyalty-performance.js';
const now=Date.parse('2026-11-13T12:00:00Z');
test('performance defaults to completed London year plus separate MTD; explicit dates and switches retain their scopes',()=>{
 const a=transitionAnalysisContext(null,'LoyaltyLion performance report',{now}).context;assert.equal(a.start_date,'2025-11-01');assert.equal(a.end_date,'2026-10-31');assert.equal(a.loyalty_scope.report_kind,'performance');assert.equal(performanceWindows(a,now)[1].end_date,'2026-11-12');
 const b=transitionAnalysisContext(a,'For 2026-05-01 through 2026-05-04',{now}).context;assert.equal(b.start_date,'2026-05-01');assert.equal(b.loyalty_scope.performance_mtd,false);
 const c=transitionAnalysisContext(a,'Show online sales for October 2026',{now}).context;assert.equal(c.loyalty_scope,null);
 const d=transitionAnalysisContext(a,'Show LoyaltyLion overview for October 2026',{now}).context;assert.equal(d.loyalty_scope.report_kind,undefined);
 const compare=transitionAnalysisContext(null,'LoyaltyLion performance report compare September 2026 with October 2026',{now}).context;assert.equal(performanceWindows(compare,now).length,2);assert.equal(compare.comparison_start_date,'2026-09-01');
 const bst=transitionAnalysisContext(null,'LoyaltyLion performance report',{now:Date.parse('2026-04-30T23:30:00Z')}).context;assert.equal(bst.end_date,'2026-04-30');assert.equal(bst.start_date,'2025-05-01');
 const overview=transitionAnalysisContext(null,'Show LoyaltyLion overview 2026-11-01 through 2026-11-05',{now}).context,upgrade=transitionAnalysisContext(overview,'LoyaltyLion performance report',{now}).context;assert.equal(upgrade.start_date,'2025-11-01');assert.equal(upgrade.end_date,'2026-10-31');


});
for(const durable of [false,true])test(`performance workbook through ${durable?'durable':'interactive'} chat preserves successful sheets and authenticated download`,async t=>{
 const f=fixture('cohorts'),h=await acceptanceServer(f,{durable,now});t.after(h.close);
 const r=await h.submit('LoyaltyLion performance report',{fresh:true});assert.ok(r.artifact,JSON.stringify(r));assert.equal(r.evidence.performance.tables.find(t=>t.section==='purchasing').rows[0].eligible_orders,3);assert.equal(r.evidence.performance.tables.find(t=>t.section==='cohorts').status,'unavailable');
 const response=await fetch(h.origin+r.artifact.download_url,{headers:{cookie:h.headers.cookie}});assert.equal(response.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));
 for(const name of ['Read me','Coverage','Programme usage','Customer purchasing','Enrolment cohorts','Rewards and purchasing','Tiers','Linkage and limitations'])assert(wb.getWorksheet(name),name);
 assert(wb.getWorksheet('Customer purchasing').getSheetValues().flat(2).includes(100));assert.doesNotMatch(JSON.stringify(wb.model),/private source details/);
 assert.notEqual((await fetch(h.origin+r.artifact.download_url)).status,200);
 const count=f.queries.length,exported=await h.submit('Export those results to Excel');assert(exported.artifact);assert.equal(f.queries.length,count);
 const refined=await h.submit('For October 2026');assert.equal(refined.evidence.performance.windows[0].start_date,'2026-10-01');assert.equal(refined.evidence.performance.windows.length,1);
});
test('unverified cohort exposure withholds rates and preserves zero-sales customers; tampered extra evidence is rejected',async()=>{
 const f=fixture(),c=transitionAnalysisContext(null,'LoyaltyLion performance report',{now}).context,e=await f.provider(c);
 const row=e.performance.tables.find(t=>t.section==='cohorts').rows[0];assert.equal(row.mature_customers,2);assert.equal(row.zero_after_customers,1);assert.equal(row.subsequent_purchase_rate,null);assert.equal(row.after_orders_per_customer,null);
 assertPerformanceEvidence(c,e);const bad=structuredClone(e);bad.performance.windows[0].end_date='2026-11-12';assert.throws(()=>assertPerformanceEvidence(c,bad));
 const pii=structuredClone(e);pii.performance.tables[0].rows[0].email='private@example.test';assert.throws(()=>assertPerformanceEvidence(c,pii));
 assert(observationCovered([{channel:'online',start_at:'2025-12-01T00:00:00Z',end_exclusive:'2026-02-01T00:00:00Z'}],row.required_start_at,row.required_end_exclusive,'online'));
 assert(!observationCovered([{channel:'instore',start_at:'2025-12-01T00:00:00Z',end_exclusive:'2026-02-01T00:00:00Z'}],row.required_start_at,row.required_end_exclusive,'online'));
});
test('read-only queries preserve immutable movement reversal semantics, mature zero-order cohorts, currency and exact IDs',()=>{
 const q=performanceQueries('fixture','loyaltylion');for(const sql of Object.values(q))assert.doesNotMatch(sql,/INSERT|MERGE|DELETE|CREATE|UPDATE|email|voucher_code/);
 assert.match(q.cohorts,/LEFT JOIN selected/);assert.match(q.cohorts,/TIMESTAMP_ADD\(m.enrolled_at,INTERVAL d DAY\)<=TIMESTAMP\(@as_of\)/);assert.match(q.purchasing,/COUNT\(DISTINCT source_order_id\)/);assert.match(q.purchasing,/current_non_member/);assert.match(q.linkage,/known_migrated_copy/);assert.match(q.linkage,/customer_mismatch/);assert.match(q.purchasing,/Full period/);
});

import {spawnSync} from 'node:child_process';
const sqlAvailable=spawnSync('python3',['-c','import duckdb,sqlglot']).status===0;
test('executed generated SQL: exact AOV/currency, repeated orders, zero-order cohort members, refunds and migration', {skip:!sqlAvailable},()=>{
 const cid=id=>'gid://shopify/Customer/'+id,oid=id=>'gid://shopify/Order/'+id,stamp='2026-11-12T00:00:00Z';
 const members=[['1','1',cid(1),true,false,false,100,0,'Gold','roster','2026-01-01T00:00:00Z'],['1','2',cid(2),true,false,false,0,0,'Silver','roster','2026-01-01T00:00:00Z'],['1','3',cid(3),false,true,false,0,0,null,'roster',null]];
 const tables={customer_snapshots:members,points_transactions:[['1','t1','1',cid(1),oid(1),'2026-01-02T00:00:00Z','activity',10,0,'points'],['1','t2','1',cid(1),oid(1),'2026-01-03T00:00:00Z','activity',-10,0,'points'],['1','t3','1',cid(1),oid(99),'2026-01-03T00:00:00Z','activity',5,0,'points']],order_financials:[],order_customers:[],order_locations:[],reward_claim_observations:[]};
 const add=(id,customer,date,currency,gross,app=null,status='PAID',refund=0)=>{tables.order_financials.push([oid(id),gross,refund,currency,null,stamp,date,gross,refund]);tables.order_customers.push([oid(id),cid(customer),status,null,stamp]);tables.order_locations.push([oid(id),app,date,null,'Online Store',stamp]);};
 add(1,1,'2026-01-02T12:00:00Z','GBP',100);add(2,1,'2026-01-03T12:00:00Z','GBP',200);add(3,1,'2025-12-20T12:00:00Z','GBP',50);add(4,3,'2026-01-04T12:00:00Z','USD',80);add(5,1,'2026-01-04T12:00:00Z','GBP',999,'gid://shopify/App/1758145');add(6,1,'2026-01-04T12:00:00Z','GBP',999,null,'REFUNDED',999);
 const params={program_id:'1',roster_run:'roster',transaction_runs:['points'],as_of:'2026-11-13T00:00:00Z',windows:JSON.stringify([{label:'Requested period',start_date:'2026-01-01',end_date:'2026-01-31'}]),channel:null,currencies:[],matrixify_app_id:'gid://shopify/App/1758145'};
 const r=spawnSync('python3',['test/loyalty-performance-sql.py'],{input:JSON.stringify({queries:performanceQueries('fixture','loyaltylion'),params,tables}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);
 const p=out.purchasing.find(x=>x.month==='Full period'&&x.currency==='GBP');assert.equal(p.eligible_orders,2);assert.equal(Number(p.observed_aov),150);assert.equal(p.repeat_purchasers,1);assert.equal(p.membership_basis,'current_member');
 assert.equal(out.purchasing.find(x=>x.month==='Full period'&&x.currency==='USD').membership_basis,'current_non_member');
 const zeros=out.cohorts.filter(x=>x.window_days===30&&x.currency==='GBP');assert.equal(zeros.reduce((n,r)=>n+r.mature_customers,0),2);assert.equal(zeros.reduce((n,r)=>n+r.zero_after_customers,0),1);assert.equal(out.linkage.find(x=>x.outcome==='matched').point_records,2);assert.equal(out.linkage.find(x=>x.outcome==='order_absent').point_records,1);
 assert.equal(out.usage[0].net_delta,5);
});

test('reviewed matched observation coverage enables cohort rates; unsupported tier filters remain explicit',async()=>{
 const f=fixture();f.config.performance_coverage={reviewed_by:'fixture',reviewed_at:'2026-11-13T00:00:00Z',intervals:[{source:'shopify',channel:'online',start_at:'2025-12-01T00:00:00Z',end_exclusive:'2026-02-01T00:00:00Z',evidence_reference:'synthetic complete population'}]};
 const c=transitionAnalysisContext(null,'LoyaltyLion performance report',{now}).context,e=await f.provider(c),r=e.performance.tables.find(t=>t.section==='cohorts').rows[0];
 assert.equal(r.subsequent_purchase_rate,0.5);assert.equal(r.before_orders_per_customer,1.5);assert.equal(r.after_orders_per_customer,0.5);
 const only=transitionAnalysisContext(c,'Only Gold',{now}).context,filtered=await f.provider(only);assert(filtered.performance.tables.every(t=>t.status==='unavailable'&&t.code==='LOYALTY_PERFORMANCE_FILTER_UNSUPPORTED'));
});
