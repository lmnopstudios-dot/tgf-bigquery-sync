import assert from 'node:assert/strict';
import test from 'node:test';
import {fulfilledMonthSection} from '../diagnostics/oracle-multi-month-sales.js';

test('multi-month diagnostic emits shared diagnostics once and normalized currency evidence',()=>{
  const population_diagnostics={missing_financial:1,missing_location:2,missing_customer:3,channel_counts:[{source_channel:'Online Store',orders:8}],status_counts:[{financial_status:'paid',inclusion:'included',orders:7},{financial_status:'refunded',inclusion:'excluded',orders:1}],included_fully_refunded_orders:2,included_fully_refunded_amount:20,excluded_refunded_status_orders:1,excluded_refunded_status_amount:10};
  const common={source_platform:'shopify',source_store:'shopify',eligible_orders:7,original_order_total:100,recorded_refunds:20,total_less_refunds:80,accepted_statuses:['paid'],actual_first_order_date:'2026-04-01',actual_last_order_date:'2026-04-30',source_collected_at:'2026-10-01T12:00:00.000Z',population_diagnostics};
  const section=fulfilledMonthSection({platform:'shopify',period:{start_date:'2026-04-01',end_date:'2026-04-30'}},{applied_period:{start_date:'2026-04-01',end_date:'2026-04-30'},rows:[{...common,currency:'GBP'},{...common,currency:'USD'}]});
  assert.equal(section.population_acceptance.status,'not_established');
  assert.equal(section.population_diagnostics.scope,'platform-wide');
  assert.equal(section.population_diagnostics.reported_once,true);
  assert.equal(section.population_diagnostics.returned_on_currency_rows,2);
  assert.deepEqual(section.population_diagnostics.channel_counts,population_diagnostics.channel_counts);
  assert.deepEqual(section.population_diagnostics.status_counts,population_diagnostics.status_counts);
  assert.equal(section.population_diagnostics.included_fully_refunded_amount,20);
  assert.equal(section.currency_evidence.length,2);
  assert.ok(section.currency_evidence.every(row=>row.evidence_scope==='currency-specific'&&row.actual_first_order_date==='2026-04-01'&&row.source_collected_at==='2026-10-01T12:00:00.000Z'&&!('population_diagnostics' in row)));
});
