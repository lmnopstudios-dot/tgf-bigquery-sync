import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePurchaseProbeArgs,probePurchaseCompatibility} from '../diagnostics/ga4-purchase-compatibility.js';

test('purchase compatibility probe is bounded to representative incident dates',()=>{
  assert.deepEqual(parsePurchaseProbeArgs([]).dates,['2022-08-18']);
  assert.throws(()=>parsePurchaseProbeArgs(['--dates','2022-08-18,2022-08-19,2022-08-20']),/bounded/);
});

test('probe reports numerator availability independently by metric and grain',async()=>{
  const client={
    async checkCompatibility(request){const metric=request.metrics[0].name;assert.equal(request.compatibilityFilter,undefined);return[{dimensionCompatibilities:request.dimensions.map(({name})=>({compatibility:'COMPATIBLE',dimensionMetadata:{apiName:name}})),metricCompatibilities:[{compatibility:metric==='ecommercePurchases'?'COMPATIBLE':'INCOMPATIBLE',metricMetadata:{apiName:metric}}]}];},
    async runReport(request){assert.equal(request.metrics[0].name,'ecommercePurchases');assert.equal(request.limit,1000);assert.deepEqual(request.metricAggregations,['TOTAL']);return[{rows:[],rowCount:0,totals:[{metricValues:[{value:'0'}]}],metadata:{timeZone:'Europe/London'}}];}
  };
  const result=await probePurchaseCompatibility({client,propertyId:'123'});
  assert.equal(result.read_only,true);assert.equal(result.results.length,4);
  assert.ok(result.results.filter(row=>row.metric==='ecommercePurchases').every(row=>row.execution.succeeded));
  assert.ok(result.results.filter(row=>row.metric==='totalPurchasers').every(row=>!row.execution.executed));
  assert.deepEqual(result.results[0].compatibility.metric_compatibilities,[{name:'ecommercePurchases',compatibility:'COMPATIBLE'}]);
  assert.deepEqual(result.results[0].execution.totals,[{ecommercePurchases:'0'}]);
});

test('actual Google response keys are required and malformed responses fail clearly',async()=>{
  const client={async checkCompatibility(){return[{dimensions:[],metrics:[]}]},async runReport(){throw new Error('must not execute')}};
  await assert.rejects(()=>probePurchaseCompatibility({client,propertyId:'123'}),/shape was not understood.*dimensionCompatibilities/);
});
