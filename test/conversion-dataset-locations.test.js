import assert from 'node:assert/strict';
import test from 'node:test';
import {runDiagnostic,evidenceQueries} from '../diagnostics/conversion-evidence.js';
import {runValidation} from '../diagnostics/conversion-history-validation.js';
import {ensureSchema,replaceRange} from '../shopify/conversion-analytics.js';
import {createDeviceSourceConversionService,conversionQueries} from '../oracle/device-source-conversion.js';

function productionBigQuery({responses=[]}={}) {
  const calls=[];
  const locations={shopify_data:'US',ga4:'EU'};
  return {calls,dataset(name,options){calls.push({metadata:{name,options}});return {getMetadata:async()=>[{location:locations[name]}]};},async query(options){calls.push({query:options});const response=responses.find(([pattern])=>pattern.test(options.query));return [response?response[1]:[]];}};
}

test('conversion evidence is read-only and reconciles US Shopify with EU GA4 in application code',async()=>{
  const bigquery=productionBigQuery({responses:[[/order_customers/,[{launch_date:'2025-11-16'}]],[/conversion_breakdown/,[{sessions:20,purchases:2}]],[/ecommerce_funnel/,[{purchase_days:3}]]]});
  const result=await runDiagnostic({bigquery,project:'p'});
  assert.deepEqual(result.dataset_locations,{shopify_data:'US',ga4:'EU'});assert.equal(result.observed.sessions,20);assert.equal(result.observed.purchase_days,3);assert.equal(result.read_only,true);
  const jobs=bigquery.calls.filter(x=>x.query).map(x=>x.query);assert.deepEqual(jobs.map(x=>x.location),['US','EU','EU']);
  for(const job of jobs)assert.doesNotMatch(job.query,/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|EXPORT)\b/i);
  assert.equal(Object.values(evidenceQueries('p')).some(sql=>sql.includes('shopify_data')&&sql.includes('.ga4.')),false);
});

test('validation and Shopify historical writes execute in existing US dataset location',async()=>{
  const bigquery=productionBigQuery({responses:[[/^WITH d AS/,[{}]]]});
  await runValidation({bigquery,project:'p',start:'2025-11-16',end:'2025-11-16'});
  await ensureSchema({bigquery,project:'p'});
  await replaceRange({bigquery,project:'p',table:'session_conversion_by_device',rows:[],startDate:'2025-11-16',endDate:'2025-11-16'});
  assert.ok(bigquery.calls.filter(x=>x.query).every(x=>x.query.location==='US'));
});

test('Oracle runs independent regional aggregates and combines only returned rows',async()=>{
  const bigquery=productionBigQuery({responses:[[/DATE '2025-11-20'/,[{launch_date:{value:'2025-11-20'}}]],[/SELECT COUNTIF/,[{covered_days:7,excluded_day_count:0,excluded_days:[]}]],[/ga4\.conversion_device/,[{device_type:'mobile',sessions:100,numerator:4,covered_days:7}]],[/session_conversion_by_device`/,[{device_type:'mobile',sessions:120,numerator:3,covered_days:7,changed_days:0}]]]});
  const service=createDeviceSourceConversionService({bigquery,project:'p'}),result=await service('compare_device_conversion_before_after_shopify',{before_start:'2025-11-13',before_end:'2025-11-19',after_start:'2025-11-20',after_end:'2025-11-26'});
  assert.deepEqual(result.rows.map(x=>x.rate),[.04,.025]);
  assert.deepEqual(bigquery.calls.filter(x=>x.query).map(x=>x.query.location),['US','EU','EU','US']);
  for(const sql of Object.values(conversionQueries('p')))assert.equal(sql.includes('.ga4.')&&sql.includes('.shopify_data.'),false);
});
