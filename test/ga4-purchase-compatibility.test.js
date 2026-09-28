import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePurchaseProbeArgs,probePurchaseCompatibility} from '../diagnostics/ga4-purchase-compatibility.js';

test('purchase compatibility probe is bounded to representative incident dates',()=>{
  assert.deepEqual(parsePurchaseProbeArgs([]).dates,['2022-08-18','2022-09-17']);
  assert.throws(()=>parsePurchaseProbeArgs(['--dates','2022-08-18,2022-08-19,2022-08-20']),/bounded/);
});

test('probe reports numerator availability independently by metric and grain',async()=>{
  const client={
    async checkCompatibility(request){const metric=request.metrics[0].name;return[{dimensions:request.dimensions.map(({name})=>({compatibility:'COMPATIBLE',dimensionMetadata:{apiName:name}})),metrics:metric==='ecommercePurchases'?[{compatibility:'COMPATIBLE',metricMetadata:{apiName:metric}}]:[]}];},
    async runReport(request){assert.equal(request.metrics[0].name,'ecommercePurchases');assert.equal(request.limit,1000);return[{rows:[],rowCount:0}];}
  };
  const result=await probePurchaseCompatibility({client,propertyId:'123'});
  assert.equal(result.read_only,true);assert.equal(result.results.length,4);
  assert.ok(result.results.filter(row=>row.metric==='ecommercePurchases').every(row=>row.execution.available));
  assert.ok(result.results.filter(row=>row.metric==='totalPurchasers').every(row=>!row.execution.available));
});
