import test from 'node:test';
import assert from 'node:assert/strict';
import {freshnessAssessment,ORACLE_SOURCE_CONTRACTS} from '../oracle/freshness.js';
import {plannedCommand} from '../ops/collector-runner.js';
import {retiredCoverageSql} from '../ops/freshness-inventory.js';

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
  assert.equal(result.availability,'unavailable');
  assert.match(result.message,/does not make the source current/);
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
  assert.ok(contract.tools.includes('get_order_summary'));
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
