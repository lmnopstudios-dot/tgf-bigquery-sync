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
test('coverage probe reports reconciliation frequency and excluded dates without writes',async()=>{
  const client={async runReport(request){const date=request.dateRanges[0].startDate.replaceAll('-','');const dimensions=request.dimensions.map(item=>item.name);const total=date==='20220818'&&dimensions.length>1?363:364;return[{rows:[row([date,...dimensions.slice(1).map(()=>'(not set)')],total)]}];}};
  const result=await probeDeviceCoverage({client,propertyId:'p',dates:['2022-08-18','2023-02-15']});
  assert.equal(result.api_reports,8);assert.equal(result.device_reportable_dates,1);assert.deepEqual(result.excluded_dates,['2022-08-18']);assert.equal(result.dates[0].highest_reconciling_grain,'date');assert.equal(result.read_only,true);
});
