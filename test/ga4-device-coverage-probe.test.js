import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCoverageProbeArgs,probeDeviceCoverage,REPRESENTATIVE_WOO_DATES} from '../diagnostics/ga4-device-coverage-probe.js';

const row=(dimensions,sessions)=>({dimensionValues:dimensions.map(value=>({value})),metricValues:[{value:String(sessions)}]});
test('coverage probe defaults are bounded and emphasize 2023 through 2025',()=>{
  const parsed=parseCoverageProbeArgs([]);
  assert.deepEqual(parsed.dates,REPRESENTATIVE_WOO_DATES);
  assert.ok(parsed.dates.filter(date=>date>='2023-01-01').length>=9);
  assert.throws(()=>parseCoverageProbeArgs(['--dates','2025-11-20']),/Woo era/);
});
test('ten-date production-shaped probe treats positive and negative HLL++ differences as diagnostics',async()=>{
  const differences=[-1,2,-3,1,-2,4,-1,3,-4,2];let current=-1;
  const client={async runReport(request){const dimensions=request.dimensions.map(item=>item.name);if(dimensions.length===1)current++;const total=364+(dimensions.length>1?differences[current]:0);const date=request.dateRanges[0].startDate.replaceAll('-','');return[{rows:[row([date,...dimensions.slice(1).map(()=>dimensions.length===2?'desktop':'Direct')],total)],rowCount:1,metadata:{subjectToThresholding:false,dataLossFromOtherRow:false}}];}};
  const result=await probeDeviceCoverage({client,propertyId:'p',dates:REPRESENTATIVE_WOO_DATES});
  assert.equal(result.api_reports,40);assert.equal(result.device_reportable_dates,10);assert.equal(result.exact_match_dates,0);assert.ok(result.dates.some(x=>x.difference>0));assert.ok(result.dates.some(x=>x.difference<0));assert.equal(result.read_only,true);
});
