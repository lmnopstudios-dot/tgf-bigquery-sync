import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {performanceQueries,applyPurchaseChangeCoverage,performanceWorkbookTables} from '../oracle/loyalty-performance.js';
import {performanceFixture} from './helpers/loyalty-performance-fixture.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const now=Date.parse('2026-11-13T12:00:00Z');
const available=spawnSync('python3',['-c','import duckdb,sqlglot']).status===0;
function population(enrolled='2026-01-01T00:00:00Z'){
 const cid=id=>'gid://shopify/Customer/'+id,oid=id=>'gid://shopify/Order/'+id,stamp='2026-11-12T00:00:00Z';
 const tables={customer_snapshots:[1,2,3,4].map(id=>['1',String(id),cid(id),true,false,false,0,0,'Silver','roster',enrolled]),order_financials:[],order_customers:[],order_locations:[]};
 function add(id,customer,date,gross=100,currency='GBP',channel='Online Store',app=null){
  tables.order_financials.push([oid(id),gross??100,0,currency,null,stamp,date,gross,0]);
  tables.order_customers.push([oid(id),cid(customer),'PAID',null,stamp]);
  tables.order_locations.push([oid(id),app,date,null,channel,stamp]);
 }
 const params={commerce_cutoffs:JSON.stringify([{channel:'online',end_exclusive:'2026-11-13T00:00:00Z'},{channel:'instore',end_exclusive:'2026-11-13T00:00:00Z'}]),program_id:'1',roster_run:'roster',transaction_runs:[],as_of:'2026-11-13T00:00:00Z',windows:JSON.stringify([{label:'Requested period',start_date:enrolled.slice(0,7)+'-01',end_date:enrolled.slice(0,7)+'-31'}]),channel:null,currencies:[],matrixify_app_id:'gid://shopify/App/1758145'};
 function run(){const r=spawnSync('python3',['test/loyalty-performance-sql.py'],{input:JSON.stringify({queries:{cohorts:performanceQueries('fixture','loyaltylion').cohorts},params,tables}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).cohorts;}
 return {tables,add,run,params};
}
test('executed paired AOV and customer-weighted order gaps exclude one-sided buyers and cross-enrolment gaps',{skip:!available},()=>{
 const f=population();
 f.add(1,1,'2025-12-10T00:00:00Z',50);f.add(2,1,'2025-12-20T00:00:00Z',150);
 f.add(3,1,'2026-01-02T00:00:00Z',100);f.add(4,1,'2026-01-04T00:00:00Z',200);f.add(5,1,'2026-01-06T00:00:00Z',300);
 f.add(6,2,'2025-12-11T00:00:00Z',100);f.add(7,2,'2025-12-15T00:00:00Z',100);
 f.add(8,2,'2026-01-03T00:00:00Z',100);f.add(9,2,'2026-01-09T00:00:00Z',100);
 f.add(10,3,'2026-01-10T00:00:00Z',9999); // one-sided buyer, not paired
 f.add(11,1,'2026-01-11T00:00:00Z',9999,'GBP','Online Store','gid://shopify/App/1758145');
 // Duplicate retained order rows must not multiply either sales or gaps.
 f.tables.order_financials.push([...f.tables.order_financials[0]]);
 const r=f.run().find(r=>r.window_days===30&&r.channel==='online'&&r.currency==='GBP'&&r.customer_history==='existing_observed_customer');
 assert.equal(r.paired_aov_customers,2);assert.equal(r.paired_before_orders,4);assert.equal(r.paired_after_orders,5);
 assert.equal(Number(r.before_aov),100);assert.equal(Number(r.after_aov),160);assert.equal(Number(r.aov_change_amount),60);assert.equal(Number(r.aov_change_fraction),0.6);
 assert.equal(r.paired_repeat_customers,2);assert.equal(r.paired_before_gap_count,2);assert.equal(r.paired_after_gap_count,3);
 assert.equal(r.before_mean_gap_days,7);assert.equal(r.after_mean_gap_days,4);assert.equal(r.before_median_gap_days,7);assert.equal(r.after_median_gap_days,4);assert.equal(r.mean_gap_change_days,-3);
 assert.equal(r.before_orders,4);assert.equal(r.after_orders,5);
 const oneSided=f.run().find(r=>r.window_days===30&&r.customer_history==='prior_history_unverified');assert.equal(oneSided.paired_aov_customers,0);assert.equal(oneSided.zero_after_customers,1);
});
test('executed gaps preserve fractional elapsed days across DST and split currencies and channels',{skip:!available},()=>{
 const f=population('2026-03-15T00:00:00Z');
 f.add(1,1,'2026-03-01T00:00:00Z');f.add(2,1,'2026-03-02T12:00:00Z');
 f.add(3,1,'2026-03-28T12:00:00Z');f.add(4,1,'2026-03-29T11:00:00Z');
 f.add(5,1,'2026-03-30T12:00:00Z',900,'USD');f.add(6,1,'2026-03-30T12:00:00Z',900,'GBP','Point of Sale');
 const rows=f.run(),r=rows.find(r=>r.window_days===30&&r.channel==='online'&&r.currency==='GBP'&&r.customer_history==='existing_observed_customer');
 assert.equal(r.before_mean_gap_days,1.5);assert.ok(Math.abs(r.after_mean_gap_days-23/24)<1e-10);assert.equal(r.paired_after_orders,2);
 for(const other of rows.filter(r=>r.window_days===30&&(r.currency==='USD'||r.channel==='instore')))assert.equal(other.paired_repeat_customers,0);
});
test('missing order money suppresses paired AOV only; identical-time orders have genuine zero gaps',{skip:!available},()=>{
 const f=population();for(const [id,date]of [[1,'2025-12-10'],[2,'2025-12-10'],[3,'2026-01-02'],[4,'2026-01-02']])f.add(id,1,date+'T00:00:00Z',id===2?null:100);
 const r=f.run().find(r=>r.window_days===30&&r.customer_history==='existing_observed_customer');applyPurchaseChangeCoverage(r,true,null);
 assert.equal(r.before_aov,null);assert.match(r.aov_withheld_reason,/Missing order values/);assert.equal(r.before_mean_gap_days,0);assert.equal(r.after_mean_gap_days,0);assert.equal(r.mean_gap_change_fraction,null);assert.match(r.gap_fraction_withheld_reason,/zero/);
});
test('unverified or immature windows retain sample counts but withhold all changes; no paired buyers is explicit',()=>{
 const r={paired_aov_customers:2,paired_repeat_customers:1,paired_before_gross:'400',paired_after_gross:'800',before_aov:'100',after_aov:'160',aov_change_amount:'60',aov_change_fraction:'0.6',before_mean_gap_days:7,after_mean_gap_days:4,before_median_gap_days:7,after_median_gap_days:4,mean_gap_change_days:-3,mean_gap_change_fraction:-3/7};
 for(const reason of ['Commerce coverage has a gap','Window is not mature']){const x=applyPurchaseChangeCoverage({...r},false,reason);assert.equal(x.paired_aov_customers,2);assert.equal(x.paired_before_gross,'400');assert.equal(x.after_aov,null);assert.equal(x.after_mean_gap_days,null);assert.equal(x.aov_withheld_reason,reason);assert.equal(x.gap_withheld_reason,reason);}
 const none=applyPurchaseChangeCoverage({paired_aov_customers:0,paired_repeat_customers:0},true,null);assert.match(none.aov_withheld_reason,/both sides/);assert.match(none.gap_withheld_reason,/at least two/);
});
test('new workbook adds purchase changes while previously retained workbooks keep their original sheets',async()=>{
 const f=performanceFixture(),context=transitionAnalysisContext(null,'LoyaltyLion performance report',{now}).context,e=await f.provider(context);
 assert.equal(e.performance.purchase_change_version,1);const sheets=performanceWorkbookTables(e),tab=sheets.find(t=>t.name==='Purchase changes');assert(tab.headers.includes('aov_withheld_reason'));assert(tab.headers.includes('before_mean_gap_days'));assert(tab.rows.flat().some(v=>typeof v==='string'&&/coverage|observation/i.test(v)));
 delete e.performance.purchase_change_version;assert(!performanceWorkbookTables(e).some(t=>t.name==='Purchase changes'));
});
test('durable authenticated workbook retains paired changes through download and export without replay',async t=>{
 const f=performanceFixture();f.config.performance_coverage={reviewed_by:'fixture',reviewed_at:'2026-11-13T00:00:00Z',intervals:[{source:'shopify',channel:'online',start_at:'2025-12-01T00:00:00Z',end_exclusive:'2026-02-01T00:00:00Z',evidence_reference:'synthetic complete population'}]};
 const query=f.bigquery.query;f.bigquery.query=async q=>{const result=await query(q);if(q.labels?.operation==='performance_cohorts')Object.assign(result[0][0],{paired_aov_customers:1,paired_before_orders:2,paired_after_orders:3,paired_before_gross:'200.00',paired_after_gross:'480.00',before_aov:'100',after_aov:'160',aov_change_amount:'60',aov_change_fraction:'0.6',paired_repeat_customers:1,paired_before_gap_count:1,paired_after_gap_count:2,before_mean_gap_days:7,after_mean_gap_days:4,before_median_gap_days:7,after_median_gap_days:4,mean_gap_change_days:-3,mean_gap_change_fraction:-3/7});return result;};
 const h=await acceptanceServer(f,{durable:true,now});t.after(h.close);const r=await h.submit('LoyaltyLion performance report',{fresh:true});assert(r.artifact,JSON.stringify(r));const response=await fetch(h.origin+r.artifact.download_url,{headers:{cookie:h.headers.cookie}});assert.equal(response.status,200);
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));const tab=wb.getWorksheet('Purchase changes'),values=tab.getSheetValues();assert(tab);const headers=values[1],row=values[2];assert.equal(row[headers.indexOf('after_aov')],160);assert.equal(row[headers.indexOf('mean_gap_change_days')],-3);assert.equal(row[headers.indexOf('aov_withheld_reason')],undefined);
 assert.notEqual((await fetch(h.origin+r.artifact.download_url)).status,200);const calls=f.queries.length;assert((await h.submit('Export those results to Excel')).artifact);assert.equal(f.queries.length,calls);
});
