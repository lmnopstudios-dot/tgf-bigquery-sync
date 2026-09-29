import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose,physicalShopifyDeviceQuery } from '../diagnostics/oracle-shopify-launch-device-conversion.js';
import { conversionQueries } from '../oracle/device-source-conversion.js';

const physical=[
  {persisted_device_label:'Desktop',normalized_device_type:'desktop',physical_rows:56,covered_days:56,first_date:'2025-11-20',last_date:'2026-01-14',sessions:60,numerator:3,completed_checkout_sessions:3},
  {persisted_device_label:'Mobile',normalized_device_type:'mobile',physical_rows:56,covered_days:56,first_date:'2025-11-20',last_date:'2026-01-14',sessions:120,numerator:4,completed_checkout_sessions:4}
];
function fake({emptyShopify=false}={}){const dryRuns=[],queries=[];return{dryRuns,queries,dataset:name=>({getMetadata:async()=>[{location:name==='shopify_data'?'US':'EU'}]}),createQueryJob:async options=>{dryRuns.push(options);return[{}];},query:async options=>{queries.push(options);if(options.query===physicalShopifyDeviceQuery('p'))return[physical];if(options.query.includes('duplicate_device_keys'))return[[{missing_device_days:0,duplicate_device_keys:0,impossible_device_funnels:0}]];if(options.query.includes('launch_date'))return[[{launch_date:'2025-11-20'}]];if(options.query.startsWith('SELECT COUNTIF'))return[[{covered_days:56,excluded_day_count:0,excluded_days:[]}]];if(options.query.includes('.ga4.conversion_device'))return[[{device_type:'desktop',sessions:55131,numerator:276,covered_days:56},{device_type:'mobile',sessions:140465,numerator:846,covered_days:56}]];if(options.query.includes('session_conversion_by_device`'))return[emptyShopify?[]:[{device_type:'desktop',sessions:60,numerator:3,covered_days:56,changed_days:0},{device_type:'mobile',sessions:120,numerator:4,covered_days:56,changed_days:0}]];throw new Error(`unexpected query ${options.query}`);}};}

test('bounded read-only diagnostic compares actual labels with exact helper and typed dates',async()=>{
  const bigquery=fake(),report=await diagnose({bigquery,project:'p'});
  assert.equal(report.read_only,true);assert.equal(report.expected_days_per_period,56);
  assert.deepEqual(report.physical_rows.map(row=>row.persisted_device_label),['Desktop','Mobile']);
  assert.deepEqual(report.storage,{project:'p',shopify_dataset:'shopify_data',shopify_location:'US',ga4_dataset:'ga4',ga4_location:'EU'});
  for(const parameter of Object.values(report.query_bindings.comparison_parameters)){assert.equal(parameter.declared_parameter_type,'DATE');assert.equal(parameter.runtime_constructor,'BigQueryDate');}
  assert.match(report.query_bindings.comparison_helper_shopify_sql,/LOWER\(TRIM\(device_type\)\).*LOWER\(TRIM\(device_type\)\) IN/s);
  assert.equal(report.comparison_helper.rows.filter(row=>row.period==='after').length,2);
  assert.ok(bigquery.dryRuns.every(job=>job.dryRun===true));
});

test('validated and physical coverage contradicting a zero-row helper fails nonzero',async()=>{
  await assert.rejects(diagnose({bigquery:fake({emptyShopify:true}),project:'p'}),error=>error.code==='SHOPIFY_DEVICE_ORACLE_CONTRADICTION'&&error.stage==='validate:physical_vs_oracle');
});

test('comparison SQL normalizes actual persisted Shopify device labels',()=>{
  assert.match(conversionQueries('p').shopify,/SELECT LOWER\(TRIM\(device_type\)\) device_type/);
});
