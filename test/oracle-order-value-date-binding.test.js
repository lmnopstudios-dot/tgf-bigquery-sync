import test from 'node:test';
import assert from 'node:assert/strict';
import { BigQuery } from '@google-cloud/bigquery';
import { orderValueQueryOptions } from '../oracle/order-value-provider.js';
import { diagnoseOrderValues } from '../diagnostics/oracle-order-values.js';
import { diagnoseOrderValueDateScope, orderValueDateScopeSql } from '../diagnostics/oracle-order-value-date-scope.js';
import { fixtureBigQuery, sqlFixtureAvailable } from './helpers/order-value-sqlite.js';
import { onlineCountrySalesSql } from '../oracle/online-country-sales.js';

const input={start:'2026-09-01',end:'2026-09-30'};
const sdk=new BigQuery({projectId:'fixture'});
const options=()=>orderValueQueryOptions({start_date:input.start,end_date:input.end,country:'GB',currency:'GBP',basis:'observed_subtotal'},'US');

test('SDK drops plain-string DATE values; shared query binds both ISO dates as real STRING values',()=>{
  const o=options();
  const old=sdk.buildQueryParams_(o.params,{...o.types,start_date:'DATE',end_date:'DATE'}).params;
  for(const p of old.filter(p=>['start_date','end_date'].includes(p.name)))assert.equal(p.parameterValue.value,undefined);
  const wire=JSON.parse(JSON.stringify(sdk.buildQueryParams_(o.params,o.types))).params;
  for(const [name,value] of [['start_date',input.start],['end_date',input.end]]){
    const p=wire.find(p=>p.name===name);assert.equal(p.parameterType.type,'STRING');assert.equal(p.parameterValue.value,value);
  }
  const salesWire=sdk.buildQueryParams_({start_date:input.start,end_date:input.end}).params;
  assert.deepEqual(wire.filter(p=>['start_date','end_date'].includes(p.name)),salesWire);
  // Working Shopify sales provider uses the same DATE(STRING) comparison, UTC calendar.
  assert.match(onlineCountrySalesSql('fixture'),/DATE\(f.created_at\) order_date/);
  assert.match(onlineCountrySalesSql('fixture'),/order_date BETWEEN DATE\(@start_date\) AND DATE\(@end_date\)/);
});

function components(){
  const c={order_locations:[],order_financials:[],order_customers:[],order_shipping_geography:[]};
  // Equal UTC/London totals initially hide different boundary membership; null remains excluded.
  const dates=['2026-08-31T23:30:00Z','2026-09-15T12:00:00Z','2026-09-30T22:59:59Z','2026-09-30T23:00:00Z',null];
  for(const [table,rows] of Object.entries(c))dates.forEach((date,i)=>rows.push({order_id:String(i),[table==='order_locations'||table==='order_financials'?'created_at':'order_created_at']:date,updated_at:'2026-10-10T00:00:00Z',synced_at:'2026-10-10T00:00:00Z',presentment_currency:'GBP',original_subtotal_presentment:200,original_shipping_presentment:8,display_financial_status:'paid',geography_status:'valid',shipping_country_code:'GB'}));
  return c;
}
test('wire-serialized date probes reconcile literals, STRING and DATE bounds with shared production scope',{skip:!sqlFixtureAvailable},async()=>{
  const bigquery=fixtureBigQuery(components());
  const result=await diagnoseOrderValueDateScope(input,{bigquery,project:'fixture'});
  assert.equal(result.date_counts_reconciled,true);assert.equal(result.production_date_scope_reconciled,true);
  assert.equal(result.components.length,8);assert.equal(bigquery.calls.length,2);
  for(const row of result.components){
    assert.equal(row.london_literal_orders,3);assert.equal(row.london_bound_orders,3);assert.equal(row.london_typed_date_orders,3);
    assert.equal(row.utc_literal_orders,3);assert.equal(row.utc_bound_orders,3);assert.equal(row.utc_typed_date_orders,3);
    assert.equal(row.shared_production_date_scope_orders,3);
    assert.equal(row.start_parameter_type,'STRING');assert.equal(row.end_parameter_type,'STRING');assert.equal(row.date_control_type,'DATE');
  }
  // Equal totals can hide different boundary membership; existing production fixtures
  // assert the exact London dates. Here remove the UTC-only end order to expose counts.
  const c=components();for(const rows of Object.values(c))rows.splice(3,1);
  const difference=await diagnoseOrderValueDateScope(input,{bigquery:fixtureBigQuery(c),project:'fixture'});
  assert.ok(difference.components.every(r=>r.utc_bound_orders===2&&r.london_bound_orders===3));
  for(const call of bigquery.calls){assert.equal(call.maximumBytesBilled,'1000000000');assert.equal(call.jobTimeoutMs,30000);assert.equal(call.useLegacySql,false);}
  const oldOptions=options();oldOptions.types={...oldOptions.types,start_date:'DATE',end_date:'DATE',date_start_control:'DATE',date_end_control:'DATE'};
  oldOptions.params={...oldOptions.params,date_start_control:BigQuery.date(input.start),date_end_control:BigQuery.date(input.end)};
  const [oldRows]=await bigquery.query({...oldOptions,query:orderValueDateScopeSql('fixture',input)});
  assert.ok(oldRows.every(r=>r.london_bound_orders===0&&r.london_literal_orders===3&&r.london_typed_date_orders===3&&r.shared_production_date_scope_orders===0));
  const report=await diagnoseOrderValues(input,{bigquery:fixtureBigQuery(components()),project:'fixture',env:{}});
  assert.equal(report.population,3);assert.equal(report.population_trace.filter_stages[0].surviving_orders,3);
  assert.deepEqual(report.bound_dates,{start_date:input.start,end_date:input.end});
});
test('date probes reject swapped, missing, invalid, injected and unbounded dates before reads',async()=>{
  for(const value of [{start:input.end,end:input.start},{start:input.start},{start:'2026-09-31',end:input.end},{start:"2026-09-01' OR TRUE",end:input.end},{start:'2025-01-01',end:'2026-09-30'},{...input,execute:true}]){
    assert.throws(()=>orderValueDateScopeSql('fixture',value));
    await assert.rejects(diagnoseOrderValueDateScope(value,{bigquery:{},project:'fixture'}));
  }
});
