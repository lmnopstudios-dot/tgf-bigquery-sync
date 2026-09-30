import test from 'node:test';
import assert from 'node:assert/strict';
import { annualLocationFinanceQuery, createAnnualLocationFinanceService, ANNUAL_LOCATION_MAX_BYTES } from '../oracle/annual-location-finance.js';
import { diagnose, incidentQueries } from '../diagnostics/annual-location-finance-production.js';
import { createOracleToolDefinitions } from '../oracle/tool-registry.js';

test('annual location SQL preserves recorded components, signs, null evidence and source sales location',()=>{
  const sql=annualLocationFinanceQuery('p');
  assert.match(sql,/SUM\(IF\(transaction_type='sale',net_ex_tax,NULL\)\) sales_excluding_recorded_tax/);
  assert.match(sql,/SUM\(IF\(transaction_type='refund',recorded_tax,NULL\)\) recorded_tax_reversed_on_refunds/);
  assert.match(sql,/IF\(missing_tax_records=0,observed_net_recorded_tax_after_refunds,NULL\)/);
  assert.match(sql,/Unknown \/ unallocated/);
  assert.match(sql,/GROUPING SETS/);
  assert.doesNotMatch(sql,/SHOPIFY_INVENTORY_LOCATION_ID|105063874887|\/\s*1\.2|\*\s*0\.2/);
});

test('annual service exposes exact stored rounding difference and reconciles complete location rows',async()=>{
  const rows=[
    {year:2026,sales_location:'Online',currency:'GBP',earliest_evidence:{value:'2026-01-01'},latest_evidence:{value:'2026-09-30'},transaction_count:3,sale_transactions:2,refund_transactions:1,tax_evidence_records:3,missing_tax_records:0,missing_ex_tax_records:0,sales_excluding_recorded_tax:1200,refunds_excluding_recorded_tax:-71.20351,observed_net_sales_excluding_recorded_tax:1128.79649,recorded_tax_on_sales:160,recorded_tax_reversed_on_refunds:-8.37284,observed_net_recorded_tax_after_refunds:151.62716,net_amount_including_recorded_tax:1280.42363,net_sales_excluding_recorded_tax:1128.79649,net_recorded_tax_after_refunds:151.62716,stored_component_difference:0.00002,tax_coverage:'complete_for_observed_ledger_rows'},
    {year:2026,sales_location:'__ALL_LOCATIONS__',currency:'GBP',earliest_evidence:{value:'2026-01-01'},latest_evidence:{value:'2026-09-30'},transaction_count:3,sale_transactions:2,refund_transactions:1,tax_evidence_records:3,missing_tax_records:0,missing_ex_tax_records:0,sales_excluding_recorded_tax:1200,refunds_excluding_recorded_tax:-71.20351,observed_net_sales_excluding_recorded_tax:1128.79649,recorded_tax_on_sales:160,recorded_tax_reversed_on_refunds:-8.37284,observed_net_recorded_tax_after_refunds:151.62716,net_amount_including_recorded_tax:1280.42363,net_sales_excluding_recorded_tax:1128.79649,net_recorded_tax_after_refunds:151.62716,stored_component_difference:0.00002,tax_coverage:'complete_for_observed_ledger_rows'}
  ];
  const calls=[];const service=createAnnualLocationFinanceService({project:'p',bigquery:{query:async options=>{calls.push(options);return[rows];}}});
  const result=await service({start_year:2023,end_year:2026,currency:'GBP'});
  assert.deepEqual(result.period,{start_date:'2023-01-01',end_date:'2026-09-30',observation_end:'2026-09-30',reporting_timezone:'ledger DATE (upstream reporting timezone must be verified in production metadata)'});
  assert.equal(result.locations[0].period_label,'2026 YTD through 2026-09-30');
  assert.equal(result.locations[0].stored_component_difference,0.00002);
  assert.equal(result.reconciliation[0].status,'reconciled');
  assert.equal(calls[0].maximumBytesBilled,ANNUAL_LOCATION_MAX_BYTES);
  assert.equal(calls[0].types.start_date,'DATE');
  assert.equal(result.contract.tax_is_vat_liability,false);
});

test('missing tax differs from an observed zero and makes headline recorded tax unknown',async()=>{
  const base={year:2025,currency:'GBP',earliest_evidence:'2025-01-01',latest_evidence:'2025-12-31',transaction_count:1,sale_transactions:1,refund_transactions:0,missing_ex_tax_records:0,sales_excluding_recorded_tax:175,refunds_excluding_recorded_tax:null,observed_net_sales_excluding_recorded_tax:175,recorded_tax_on_sales:null,recorded_tax_reversed_on_refunds:null,net_amount_including_recorded_tax:175,net_sales_excluding_recorded_tax:175,stored_component_difference:null};
  const rows=[{...base,sales_location:'Online Ready to Ship',tax_evidence_records:0,missing_tax_records:1,observed_net_recorded_tax_after_refunds:null,net_recorded_tax_after_refunds:null,tax_coverage:'recorded_tax_unavailable'},{...base,sales_location:'Draft',tax_evidence_records:1,missing_tax_records:0,recorded_tax_on_sales:0,observed_net_recorded_tax_after_refunds:0,net_recorded_tax_after_refunds:0,stored_component_difference:0,tax_coverage:'complete_for_observed_ledger_rows'}];
  const result=await createAnnualLocationFinanceService({project:'p',bigquery:{query:async()=>[rows]}})({start_year:2025,end_year:2025});
  assert.equal(result.locations[0].net_recorded_tax_after_refunds,null);
  assert.equal(result.locations[0].coverage.status,'recorded_tax_unavailable');
  assert.equal(result.locations[1].net_recorded_tax_after_refunds,0);
});

test('year boundaries reject future/unordered ranges and completed years end on calendar year',async()=>{
  let options;const service=createAnnualLocationFinanceService({project:'p',bigquery:{query:async value=>{options=value;return[[]];}}});
  await service({start_year:2023,end_year:2025,currency:null});
  assert.equal(options.params.start_date.value,'2023-01-01');assert.equal(options.params.end_date.value,'2025-12-31');
  await assert.rejects(()=>service({start_year:2021,end_year:2025}),/2022/);
  await assert.rejects(()=>service({start_year:2026,end_year:2027}),/observation year/);
});

test('Oracle registry routes annual questions and follow-up ranges to the precise finance tool',()=>{
  const tool=createOracleToolDefinitions().find(value=>value.name==='get_annual_sales_by_location');
  assert.ok(tool);assert.match(tool.description,/net sales excluding recorded tax/);assert.match(tool.description,/2026-09-30/);
  assert.deepEqual(tool.parameters.properties.start_year,{type:'integer',minimum:2022,maximum:2026});
});

test('production incident queries explain population, rounding and disputed location without customer data',()=>{
  const queries=incidentQueries('p');
  assert.deepEqual(Object.keys(queries),['read_path_comparison','location_reconciliation','online_difference','online_cross_classification','rounding','disputed_location','source_tax_coverage']);
  for(const sql of Object.values(queries)){assert.match(sql.trim(),/^(WITH|SELECT)/);assert.doesNotMatch(sql,/email|phone|customer|INSERT|UPDATE|DELETE/i);}
  assert.match(queries.online_difference,/location_minus_channel/);assert.match(queries.rounding,/stored_component_difference/);assert.match(queries.disputed_location,/LIMIT 20/);assert.match(queries.disputed_location,/mapping_provenance/);
});

test('diagnostic discovers source schemas and dry-runs every bounded finance query',async()=>{
  const calls=[];const bigquery={dataset:name=>({getMetadata:async()=>[{location:name==='shopify_data'?'US':'EU'}]}),query:async options=>{calls.push({kind:'query',...options});return[[]];},createQueryJob:async options=>{calls.push({kind:'dry',...options});return[{}];}};
  const result=await diagnose({bigquery,project:'p'});
  assert.equal(result.read_only,true);assert.equal(result.limitations.fulfilment_inventory_location.toLowerCase().includes('not present'),true);
  assert.equal(calls.filter(call=>call.kind==='dry').length,Object.keys(incidentQueries('p')).length+1);
  assert.ok(calls.every(call=>call.maximumBytesBilled===ANNUAL_LOCATION_MAX_BYTES));
  assert.ok(calls.filter(call=>call.kind==='dry').every(call=>call.dryRun===true));
  assert.equal(result.bindings.start_date.declared_parameter_type,'DATE');
});
