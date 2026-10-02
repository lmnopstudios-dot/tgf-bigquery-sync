import test from 'node:test';
import assert from 'node:assert/strict';
import {freshnessAssessment,ORACLE_SOURCE_CONTRACTS} from '../oracle/freshness.js';
import {plannedCommand} from '../ops/collector-runner.js';
import {dependencyAudit,retiredCoverageSql} from '../ops/freshness-inventory.js';
import {sourceInspections} from '../ops/collector-runner.js';

test('freshness distinguishes query time, source success, coverage, and provisional periods',()=>{
  const result=freshnessAssessment({source:'ga4',requestedStart:'2026-09-20',requestedEnd:'2026-09-30',coverageStart:'2025-01-01',coverageEnd:'2026-09-29',lastSuccess:'2026-09-30T05:00:00Z',now:new Date('2026-10-01T12:00:00Z')});
  assert.equal(result.coverage_complete,false);
  assert.equal(result.availability,'partial');
  assert.equal(result.provisional,true);
  assert.equal(result.last_successful_source_collection,'2026-09-30T05:00:00.000Z');
  assert.equal(result.query_executed_at,'2026-10-01T12:00:00.000Z');
});

test('missing collection is not reported as observed zero activity',()=>{
  const result=freshnessAssessment({source:'search_console',requestedStart:'2026-09-01',requestedEnd:'2026-09-02',status:'missing',now:new Date('2026-10-01T00:00:00Z')});
  assert.equal(result.availability,'stored_data_unavailable');
  assert.match(result.message,/No readable stored rows/);
});

test('Square remains retired without a recurring collector',()=>{
  const result=freshnessAssessment({source:'square_retired',now:new Date('2026-10-01T00:00:00Z')});
  assert.equal(result.availability,'retired_historical_only');
  assert.equal(ORACLE_SOURCE_CONTRACTS.square_retired.cadence_minutes,null);
  assert.throws(()=>plannedCommand('square_retired'),/not an active warehouse collector/);
});

test('Woo remains queryable historical coverage without collection or invented retirement date',()=>{
  const contract=ORACLE_SOURCE_CONTRACTS.woo_metorik_retired;
  const result=freshnessAssessment({source:'woo_metorik_retired',coverageStart:'2020-01-01',coverageEnd:'2025-11-03',now:new Date('2026-10-01T00:00:00Z')});
  assert.equal(contract.retired,true);
  assert.equal(contract.cadence_minutes,null);
  assert.equal(result.availability,'retired_historical_only');
  assert.equal(result.overdue,false);
  assert.equal(result.provisional,false);
  assert.match(result.message,/exact last-order date is not asserted/);
  assert.ok(contract.tools.includes('get_sales_summary'));
  assert.throws(()=>plannedCommand('woo_metorik_retired'),/not an active warehouse collector/);
  const sql=retiredCoverageSql('project-id','woo_metorik_retired');
  assert.match(sql,/MIN\(order_date\)/);
  assert.match(sql,/MAX\(order_date\)/);
  assert.doesNotMatch(sql,/2025-11-03/);
});

test('incremental plans overlap persisted coverage rather than starting at now',()=>{
  const now=new Date('2026-10-02T10:00:00Z');
  assert.deepEqual(plannedCommand('ga4',{now,coverageEnd:'2026-09-25'}),['npm',['run','sync:ga4','--','--start','2026-09-19','--end','2026-10-01']]);
  const conversion=plannedCommand('shopify_conversion',{now,coverageEnd:'2026-09-25'});
  assert.ok(conversion[1].includes('2026-09-19'));
  assert.throws(()=>plannedCommand('search_console',{now}),/explicit bounded catch-up/);
});

test('Klaviyo scheduler keeps its previous/current London month contract',()=>{
  assert.deepEqual(plannedCommand('klaviyo'),['npm',['run','schedule:klaviyo']]);
  assert.equal(ORACLE_SOURCE_CONTRACTS.klaviyo.late_change_overlap_days,62);
});

test('freshness contracts use physical Klaviyo tables and inspect classifications without an invented timestamp',()=>{
  assert.deepEqual(ORACLE_SOURCE_CONTRACTS.klaviyo.tables,['message_performance','window_coverage','sync_status']);
  const klaviyo=sourceInspections('project-id','klaviyo').map(x=>x.query).join('\n');
  assert.match(klaviyo,/message_performance/);assert.match(klaviyo,/window_coverage/);assert.match(klaviyo,/sync_status/);
  assert.doesNotMatch(klaviyo,/email_metric_daily|email_campaign_daily/);
  const classifications=sourceInspections('project-id','product_classifications');
  assert.ok(classifications.every(x=>x.kind==='snapshot'));
  assert.doesNotMatch(classifications.map(x=>x.query).join('\n'),/updated_at/);
});

test('all freshness tool dependencies exist in the Oracle implementation registry',()=>{
  for(const [source,result] of Object.entries(dependencyAudit()))assert.deepEqual(result.missing_implementations,[],source);
});

test('freshness states keep readable data distinct from an absent schedule and failed inspection',()=>{
  const stored=freshnessAssessment({source:'product_classifications',storedDataAvailable:true,scheduleVerified:false,now:new Date('2026-10-01T00:00:00Z')});
  assert.equal(stored.availability,'collection_freshness_unknown');
  const inspected=freshnessAssessment({source:'product_classifications',storedDataAvailable:true,inspectionFailed:true,now:new Date('2026-10-01T00:00:00Z')});
  assert.equal(inspected.availability,'inspection_failed');
  const manual=freshnessAssessment({source:'shopify_finance',storedDataAvailable:true,lastSuccess:'2026-10-01T00:00:00Z',scheduleVerified:false,now:new Date('2026-10-01T01:00:00Z')});
  assert.equal(manual.availability,'verified_schedule_missing');
});
