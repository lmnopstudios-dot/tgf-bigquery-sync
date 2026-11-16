import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {performanceQueries,cohortObservation,commerceCutoffs,performanceWorkbookTables} from '../oracle/loyalty-performance.js';
import {commerceAuditQueries,auditCommerce,commerceAuditReview} from '../diagnostics/loyaltylion-commerce-coverage.mjs';
import {performanceFixture} from './helpers/loyalty-performance-fixture.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
const now='2026-11-15T12:00:00Z';
const cert={source:'shopify',channel:'online',start_at:'2025-11-16T00:00:00Z',end_exclusive:'2026-11-13T17:29:00Z',evidence_reference:'synthetic completed source manifest'};
const row={channel:'online',cohort_customers:2,required_start_at:'2026-09-01T00:00:00Z',required_end_exclusive:'2026-11-14T00:00:00Z'};
test('maturity uses verified exclusive cutoff, including partial days, gaps and channel coverage',()=>{
 assert.match(cohortObservation([],row,now).reason,/No verified commerce cutoff/);
 assert.match(cohortObservation([cert],row,now).reason,/Immature/);
 assert.equal(cohortObservation([cert],{...row,required_end_exclusive:cert.end_exclusive},now).certified,true);
 assert.equal(cohortObservation([cert],{...row,channel:'instore'},now).certified,false);
 assert.match(cohortObservation([cert],{...row,required_start_at:'2025-11-01T00:00:00Z',required_end_exclusive:'2026-10-01T00:00:00Z'},now).reason,/coverage gap/);
 assert.equal(commerceCutoffs([{...cert,end_exclusive:'2027-01-01T00:00:00Z'}],now)[0].end_exclusive,'2026-11-15T12:00:00.000Z');
});
test('stale roster, partial month, certified versus unverified purchasing and genuine zero cohort rates survive workbook',async()=>{
 const f=performanceFixture(),c=transitionAnalysisContext(null,'LoyaltyLion performance report',{now:Date.parse(now)}).context;
 const read=f.bigquery.query;
 f.bigquery.query=async q=>{
  const [rows]=await read(q);
  if(q.labels?.operation==='performance_purchasing')return [[...rows,{...rows[0],month:'2026-10-01'}]];
  if(q.labels?.operation==='performance_cohorts')return [[{...rows[0],before_orders:0,after_orders:0,customers_purchasing_after:0,zero_after_customers:2}]];
  return [rows];
 };
 let e=await f.provider(c);let p=e.performance;
 assert(p.snapshot_age_days>1);assert(p.limitations.some(x=>/may be stale/.test(x)));
 assert(p.tables.find(t=>t.section==='purchasing').rows.every(r=>r.certified_commerce_coverage===false));
 assert.match(p.tables.find(t=>t.section==='cohorts').rows[0].withheld_reason,/uncertified/);
 f.config.performance_coverage={reviewed_by:'fixture',reviewed_at:now,intervals:[{...cert,start_at:'2025-12-01T00:00:00Z'}]};
 e=await f.provider(c);p=e.performance;
 const purchases=p.tables.find(t=>t.section==='purchasing').rows;
 assert.equal(purchases[0].certified_commerce_coverage,false);assert.equal(purchases[1].start_date,'2026-10-01');assert.equal(purchases[1].end_date,'2026-10-31');assert(p.verified_windows.some(w=>w.period==='Requested period'&&w.start_at==='2025-12-01T00:00:00.000Z'&&w.end_exclusive==='2026-11-01T00:00:00.000Z'));assert.equal(purchases[1].certified_commerce_coverage,true);
 const cohort=p.tables.find(t=>t.section==='cohorts').rows[0];assert.equal(cohort.subsequent_purchase_rate,0);assert.equal(cohort.withheld_reason,null);assert.equal(cohort.mature_customers,2);
 const wb=new ExcelJS.Workbook();for(const t of performanceWorkbookTables(e)){const sheet=wb.addWorksheet(t.name);sheet.addRow(t.headers);sheet.addRows(t.rows);}
 const text=JSON.stringify(wb.model);assert.match(text,/Latest certified commerce cutoff/);assert.match(text,/Latest certified points cutoff/);assert.match(text,/Membership snapshot collected/);assert.match(text,/Snapshot age/);
});
test('purchasing retains complete roster binding when independent base sections fail',async()=>{
 const f=performanceFixture(),read=f.bigquery.query;
 f.bigquery.query=async q=>{
  if(q.labels.operation!=='coverage'&&!q.labels.operation.startsWith('performance_'))throw Error('independent source unavailable');
  return read(q);
 };
 const c=transitionAnalysisContext(null,'LoyaltyLion performance report',{now:Date.parse(now)}).context,e=await f.provider(c);
 assert(e.sections.every(s=>s.status==='unavailable'));
 assert.equal(e.performance.tables.find(t=>t.section==='purchasing').rows[0].eligible_orders,3);
});
test('monthly audit uses shared eligible orders, all retained ID populations and completion manifests; failures remain independent',async()=>{
 const queries=commerceAuditQueries('fixture','loyaltylion');
 assert.match(queries.monthly,/UNION DISTINCT SELECT order_id FROM c/);assert.match(queries.monthly,/invalid_customer_namespace/);assert.match(queries.monthly,/ambiguous_roster_link/);assert.match(queries.monthly,/known_migration_exclusions/);
 assert.match(queries.finance_runs,/page_count/);assert.match(queries.customer_runs,/unresolved_ids/);
 for(const q of Object.values(queries))assert.doesNotMatch(q,/\b(?:CREATE|DELETE|INSERT|MERGE|UPDATE)\b/);
 const calls=[],bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{calls.push(q);if(q.labels.operation==='finance_runs')throw Error('private credential');return [[]];}};
 const e=await auditCommerce({bigquery,project:'fixture',config:{dataset:'loyaltylion',program_id:'1'},start_at:'2025-11-01T00:00:00Z',end_exclusive:'2026-11-15T00:00:00Z',now});
 assert.equal(e.certified,false);assert.equal(e.sections.finance_runs.status,'unavailable');assert.equal(e.sections.monthly.status,'observed');assert.equal(calls.length,4);assert.doesNotMatch(JSON.stringify(e),/private credential/);
 assert(calls.every(q=>q.maximumBytesBilled==='1000000000'&&q.jobTimeoutMs===15000));
});
const sqlAvailable=spawnSync('python3',['-c','import duckdb,sqlglot']).status===0;
test('executed SQL: October enrolments see November outcomes beyond requested dates; immature and ambiguous identities remain explicit',{skip:!sqlAvailable},()=>{
 const cid=n=>'gid://shopify/Customer/'+n,oid=n=>'gid://shopify/Order/'+n,stamp='2026-11-14T00:00:00Z';
 const member=(ref,id,date)=>['1',String(ref),cid(id),true,false,false,0,0,null,'roster',date];
 const tables={customer_snapshots:[member(1,1,'2026-10-05T00:00:00Z'),member(2,2,'2026-10-05T00:00:00Z'),member(3,3,'2026-10-25T00:00:00Z'),member(4,4,'2026-10-05T00:00:00Z'),member(5,4,'2026-10-05T00:00:00Z')],order_financials:[],order_customers:[],order_locations:[]};
 const add=(id,customer,date,app=null)=>{tables.order_financials.push([oid(id),100,0,'GBP',null,stamp,date,100,0]);tables.order_customers.push([oid(id),customer,'PAID',null,stamp,app]);tables.order_locations.push([oid(id),null,date,null,'Online Store',stamp]);};
 add(1,cid(1),'2026-11-01T12:00:00Z');add(2,cid(3),'2026-11-02T12:00:00Z');add(3,cid(4),'2026-10-10T12:00:00Z');add(4,null,'2026-10-10T12:00:00Z');add(5,cid(1),'2026-10-10T12:00:00Z','gid://shopify/App/1758145');
 tables.order_customers.push([oid(6),cid(1),'PAID',null,stamp,null,'2026-10-10T00:00:00Z']);
 tables.order_financials.push([oid(7),100,0,'GBP',null,stamp,'2026-10-10T00:00:00Z',100,0]);
 tables.coverage_windows=[['1','customers',null,null,'complete','roster',stamp]];
 const params={start_at:'2026-10-01T00:00:00Z',end_exclusive:'2026-11-15T00:00:00Z',program_id:'1',roster_run:'roster',transaction_runs:[],as_of:now,windows:JSON.stringify([{label:'Requested period',start_date:'2026-10-01',end_date:'2026-10-31'}]),commerce_cutoffs:JSON.stringify(commerceCutoffs([cert],now)),channel:null,currencies:[],matrixify_app_id:'gid://shopify/App/1758145'};
 const q=performanceQueries('fixture','loyaltylion');
 const r=spawnSync('python3',['test/loyalty-performance-sql.py'],{input:JSON.stringify({queries:{cohorts:q.cohorts,purchasing:q.purchasing,audit:commerceAuditQueries('fixture','loyaltylion').monthly},params,tables}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);
 const mature=out.cohorts.find(r=>r.window_days===30&&r.observation_mature);assert.equal(mature.cohort_customers,2);assert.equal(mature.after_orders,1);assert.equal(mature.zero_after_customers,1);assert.equal(mature.required_end_exclusive,'2026-11-04 00:00:00+00');
 const immature=out.cohorts.find(r=>r.window_days===30&&!r.observation_mature);assert.equal(immature.cohort_customers,1);assert.equal(immature.mature_customers,0);assert.equal(immature.after_orders,1);
 const audit=out.audit.filter(r=>r.month.startsWith('2026-10-01'));assert.equal(audit.reduce((n,r)=>n+r.ambiguous_roster_link,0),1);assert.equal(audit.reduce((n,r)=>n+r.missing_customer_id,0),2);assert.equal(audit.reduce((n,r)=>n+r.missing_finance,0),1);assert.equal(audit.reduce((n,r)=>n+r.missing_customer_evidence,0),1);assert.equal(audit.reduce((n,r)=>n+r.missing_channel_evidence,0),2);assert.equal(audit.reduce((n,r)=>n+r.known_migration_exclusions,0),1);
 assert.equal(out.purchasing.length,2);assert(out.purchasing.every(r=>r.membership_basis==='unknown'&&r.eligible_orders===1));
});


test('coverage audit distinguishes join repairs from missing source proof without auto-certifying',()=>{
 const row={missing_finance:0,missing_customer_evidence:0,missing_channel_evidence:0,invalid_order_namespace:0,missing_gross:0};
 const sections={monthly:{status:'observed',rows:[row]},schema:{status:'observed',rows:[]},finance_runs:{status:'observed',rows:[]},customer_runs:{status:'observed',rows:[]}};
 let review=commerceAuditReview(sections);assert.equal(review.status,'source_population_proof_required');assert.equal(review.certified,false);assert.match(review.source_population_proof,/repaired customer links/);
 review=commerceAuditReview({...sections,monthly:{status:'observed',rows:[{...row,missing_customer_evidence:4}]}});assert.equal(review.status,'retained_reconciliation_required');assert.equal(review.retained_gaps.missing_customer_evidence,4);
 review=commerceAuditReview({...sections,monthly:{status:'observed',rows:[]}});assert.equal(review.status,'no_retained_observations');assert.equal(review.retained_gaps,null);
 review=commerceAuditReview({...sections,monthly:{status:'unavailable'}});assert.equal(review.status,'audit_reads_incomplete');assert.deepEqual(review.failed_reads,['monthly']);assert.equal(review.retained_gaps,null);
 review=commerceAuditReview({...sections,monthly:{status:'observed',rows:[{}]}});assert.equal(review.status,'retained_reconciliation_required');assert.equal(review.retained_gaps.missing_finance,null);
});
