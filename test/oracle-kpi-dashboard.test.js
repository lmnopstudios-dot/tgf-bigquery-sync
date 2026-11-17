import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {kpiRequest,kpiPeriods,monthAdd} from '../public/oracle/kpi-intent.js';
import {oracleRequestRoute} from '../public/oracle/request-routing.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {assertEvidenceAgreement,executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {baselinePeriod,kpiChange,buildKpiEvidence} from '../oracle/kpi-dashboard.js';
import {kpiCovered,kpiCommerceSql,kpiRetentionSql} from '../oracle/kpi-reader.js';
import {kpiFixture,KPI_NOW,KPI_COVERAGE} from './helpers/kpi-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const context=message=>transitionAnalysisContext(null,message,{now:KPI_NOW}).context;
test('KPI short command, month and range resolve one registered scope; subject switches clear campaign filters',()=>{
 for(const message of ['KPI dashboard','KPI dashboard for October 2026','KPI dashboard from 2026-10-01 through 2026-10-31']){const c=context(message);assert.equal(c.tool_route,'get_kpi_dashboard');assert.equal(c.start_date,'2026-10-01');assert.equal(c.end_date,'2026-10-31');assert.equal(oracleRequestRoute(message),'job');}
 const c=transitionAnalysisContext(context('KPI dashboard online only USD'),'KPI dashboard for October 2026',{now:KPI_NOW}).context;assert.equal(c.kpi_scope.currency,null);assert.equal(c.kpi_scope.channel,'combined');
 assert.equal(context('KPI dashboard channel instore GBP').kpi_scope.channel,'instore');
 assert.equal(context('KPI dashboard channel unknown GBP').kpi_scope.channel,'unknown');
 assert.equal(context('KPI dashboard for February 2026').end_date,'2026-02-28');
 assert.equal(context('KPI dashboard from 2026-11-17 through 2026-11-18').period_issue,'invalid_period');
 assert.throws(()=>kpiRequest('KPI dashboard GBP USD',KPI_NOW));
});
test('London month boundaries, MTD clamps, leap comparisons and exact DST certification',()=>{
 const p=kpiPeriods('2024-02-01','2024-02-29',Date.parse('2024-03-31T23:30:00Z'));
 assert.equal(p.find(p=>p.id==='mtd'),undefined); // London is already 1 April
 assert.equal(p.find(p=>p.id==='previous').start_date,'2024-01-01');assert.equal(p.find(p=>p.id==='year').end_date,'2023-02-28');
 assert.equal(monthAdd('2024-03-31',-1),'2024-02-29');
 const edge=[{channel:'all',start_at:'2026-10-24T23:00:00Z',end_exclusive:'2026-10-26T00:00:00Z'}];assert(kpiCovered(edge,{start_date:'2026-10-25',end_date:'2026-10-25'},'combined'));
 assert(!kpiCovered(edge,{start_date:'2026-10-24',end_date:'2026-10-25'},'combined'));
});
test('baseline is proposed without a pin, fixed with a pin, unavailable across a gap; zero comparison is not infinity',()=>{
 const b=baselinePeriod(KPI_COVERAGE,'combined',null);assert.equal(b.start_date,'2025-01-01');assert.equal(b.fixed,false);
 assert.equal(baselinePeriod(KPI_COVERAGE,'combined','2025-01-01').fixed,true);
 assert.equal(baselinePeriod([],'combined',null),null);
 assert.deepEqual(kpiChange(2,0),{absolute:2,percentage:null,direction:'up'});assert.equal(kpiChange(null,4).direction,'unavailable');
});
test('weighted baseline AOV, preserved currencies, customer history and unsupported source semantics',async()=>{
 const f=kpiFixture(),c=context('KPI dashboard');const r=await f.service('KPI dashboard',{analysisContext:c,now:KPI_NOW,exportOwner:'owner',requestId:'kpi-weighted'});
 assertEvidenceAgreement(c,r.evidence);const gbp=r.evidence.summary.find(r=>r.metric==='aov'&&r.currency==='GBP'&&r.period==='selected');assert.equal(gbp.value,250);assert.equal(gbp.baseline_value,150);assert.equal(gbp.customerless_orders,1);
 assert(r.evidence.summary.some(r=>r.currency==='USD'));assert(r.evidence.summary.filter(r=>['turnover','conversion','new_customers','returning_rate'].includes(r.metric)).every(r=>r.value===null));
 const saved=await f.exportStore.get(r.artifact.id,'owner'),w=new ExcelJS.Workbook();await w.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));assert.deepEqual(w.worksheets.map(s=>s.name),['KPI summary','Monthly trends','Customer retention','Definitions and coverage']);
 const wrong={...c,kpi_scope:{...c.kpi_scope,currency:'USD'}};assert.throws(()=>assertEvidenceAgreement(wrong,r.evidence),/scope/i);
 const count=f.calls.length;await f.service('KPI dashboard',{analysisContext:c,now:KPI_NOW,exportOwner:'owner',requestId:'kpi-weighted'});assert.equal(f.calls.length,count);
});
test('coverage gaps withhold values and preserve missing denominators; failed retention preserves AOV',async()=>{
 const f=kpiFixture({failed:'retention'}),r=await f.service('KPI dashboard',{analysisContext:context('KPI dashboard'),now:KPI_NOW,exportOwner:'o',requestId:'partial'});
 assert(r.evidence.summary.some(r=>r.metric==='aov'&&r.value===250));assert(r.evidence.retention.every(r=>r.repeat_rate===null));
 const g=kpiFixture({coverage:[]}),v=await g.service('KPI dashboard',{analysisContext:context('KPI dashboard'),now:KPI_NOW,exportOwner:'o',requestId:'gap'});assert(v.evidence.summary.every(r=>r.value===null));assert(v.evidence.monthly.every(r=>r.value===null));
});
test('direct, interactive and durable chat deliver the dedicated workbook without model or proposal fallback; downloads owned',async()=>{
 for(const durable of [false,true]){const f=kpiFixture(),h=await acceptanceServer(f,{durable,now:KPI_NOW});try{
  for(const command of ['KPI dashboard','KPI dashboard for October 2026']){const r=await h.submit(command,{fresh:true});assert.equal(r.evidence.kind,'kpi_dashboard');assert.deepEqual(r.proposals??[],[]);assert.equal(r.analysis_context.tool_route,'get_kpi_dashboard');
   const response=await fetch(h.origin+r.artifact.download_url,{headers:h.headers});assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/oracle-kpi-dashboard.xlsx/);assert((await response.arrayBuffer()).byteLength>1000);assert.notEqual((await fetch(h.origin+r.artifact.download_url)).status,200);
  }
 }finally{await h.close();}}
});
test('generated aggregate SQL executes deduplication, migrations, customerless orders, currencies and intervals',()=>{
 const python=process.env.ORACLE_SQL_PYTHON||'python3';
 const ts=(day,hour='12:00:00')=>`2026-09-${day}T${hour}Z`;
 const tables={order_financials:[],order_customers:[],order_locations:[]};
 function order(id,day,customer,value=100,currency='GBP',app=null,status='paid',hour='12:00:00'){
 const gid='gid://shopify/Order/'+id,t=ts(day,hour),synced='2026-11-01T00:00:00Z';tables.order_financials.push([gid,value,0,currency,null,synced,t,value,0]);tables.order_customers.push([gid,customer?'gid://shopify/Customer/'+customer.replace('c',''):null,status,null,synced,app,t]);tables.order_locations.push([gid,app,t,null,'online store',synced]);}
 order(1,'01','c1',100);order(2,'11','c1',300);order(3,'11','c1',200);order(4,'12',null,100);order(5,'13','c2',100,'USD');order(6,'14','c3',900,'GBP','gid://shopify/App/1758145');order(7,'15','c4',900,'GBP',null,'pending');tables.order_financials.push(tables.order_financials[0]);
 const params={windows:JSON.stringify([{id:'selected',start_date:'2026-09-01',end_date:'2026-09-30'}]),channel:'combined',currency:null,as_of:'2026-11-17T00:00:00Z',matrixify_app_id:'gid://shopify/App/1758145'};
 const p=spawnSync(python,['test/loyalty-performance-sql.py'],{input:JSON.stringify({queries:{commerce:kpiCommerceSql('fixture'),retention:kpiRetentionSql('fixture')},tables,params}),encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout),gbp=result.commerce.find(r=>r.currency==='GBP');assert.equal(gbp.orders,4);assert.equal(gbp.gross,'700.00');assert.equal(gbp.customerless_orders,1);assert.equal(gbp.customers,1);assert.equal(gbp.intervals,2);assert.equal(Number(gbp.median_gap),5);assert.equal(result.retention.find(r=>r.currency==='GBP'&&r.horizon===30).returned_customers,1);
});
test('mature customers can be reported while younger customers remain immature; intervals need their full lookback',async()=>{
 const c=context('KPI dashboard'),periods=kpiPeriods(c.start_date,c.end_date,KPI_NOW),p=periods[0];
 const d={commerce:{rows:[{period:'selected',currency:'GBP',orders:2,gross:'0.00',missing_values:0,customers:2,customerless_orders:0,mean_gap:0,median_gap:0,required_gap_start:'2020-01-01'}]},retention:{rows:[{period:'selected',currency:'GBP',horizon:30,cohort_customers:5,mature_customers:2,returned_customers:1,mature_start_epoch:Date.parse('2026-10-01T00:00:00Z')/1000,mature_end_epoch:Date.parse('2026-11-10T00:00:00Z')/1000}]}};
 const e=buildKpiEvidence({context:c,periods:[p],data:d,coverage:KPI_COVERAGE,baseline:null,now:KPI_NOW});
 assert.equal(e.summary.find(r=>r.metric==='aov').value,0);assert.equal(e.summary.find(r=>r.metric==='median_gap').value,null);
 assert.equal(e.retention.find(r=>r.horizon_days===30).repeat_rate,.5);assert.equal(e.retention.find(r=>r.horizon_days===30).immature_customers,3);
});
test('source geography failure preserves a workbook with explicit unavailable values and no source substitution',async()=>{
 const f=kpiFixture(),c=context('KPI dashboard UK'),read=async()=>{throw Object.assign(Error('private details'),{code:'KPI_GEOGRAPHY_UNAVAILABLE'});};
 const {createKpiDashboard}=await import('../oracle/kpi-dashboard.js');const s=createKpiDashboard({read,artifactStore:f.exportStore});
 const r=await s('KPI dashboard UK',{analysisContext:c,exportOwner:'o',requestId:'uk',now:KPI_NOW});assert(r.evidence.summary.every(r=>r.value===null));assert.equal(r.evidence.scope.geography,'uk');assert.equal(r.evidence.source_status.commerce,'KPI_GEOGRAPHY_UNAVAILABLE');
});
