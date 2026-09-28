import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseSessionReconciliation, parseDiagnosticArgs } from '../diagnostics/ga4-session-reconciliation.js';

const row = (dimensions, sessions) => ({ dimensionValues: dimensions.map(value => ({ value })), metricValues: [{ value: String(sessions) }] });

test('one-day diagnostic identifies both fresh API totals and API loss indicators', async () => {
  const client = { async runReport(request) {
    if (request.dimensions.length === 1) return [{ rows: [row(['20220818'], 10)], rowCount: 1 }];
    return [{ rows: [row(['20220818','desktop','Direct','(direct)','(none)'], 7), row(['20220818','mobile','(not set)','','organic'], 4)], rowCount: 2, metadata: { timeZone: 'Europe/London', subjectToThresholding: false, dataLossFromOtherRow: true }, propertyQuota: { tokensPerDay: { remaining: 123 } } }];
  } };
  const result = await diagnoseSessionReconciliation({ client, propertyId: 'p', date: '2022-08-18' });
  assert.equal(result.totals.date_total.sessions, 10); assert.equal(result.totals.device_channel_source_medium_breakdown.sessions, 11);
  assert.equal(result.breakdown.row_count, 2); assert.equal(result.breakdown.unknown_or_omitted_dimension_rows.sessionSource, 1);
  assert.equal(result.reporting_timezone, 'Europe/London'); assert.equal(result.api_indicators.data_loss_from_other_row, true);
  assert.equal(result.comparator.bigquery_daily_row_read, false); assert.equal(result.read_only, true);
  assert.equal(result.disappearance.first_non_reconciling_grain, 'device');
  assert.deepEqual(parseDiagnosticArgs(['--date','2022-08-18']), { date: '2022-08-18' });
});

test('production-shaped 2022-08-18 probe locates loss at source and medium grain', async () => {
  const client = { async runReport(request) {
    const dimensions=request.dimensions.map(d=>d.name);
    if(dimensions.length===1)return [{rows:[row(['20220818'],364)],rowCount:1}];
    if(dimensions.length===2)return [{rows:[row(['20220818','desktop'],250),row(['20220818','mobile'],114)],rowCount:2}];
    if(dimensions.length===3)return [{rows:[row(['20220818','desktop','Direct'],250),row(['20220818','mobile','Organic Search'],114)],rowCount:2}];
    const detailed=Array.from({length:25},(_,index)=>row(['20220818',index<17?'desktop':'mobile',index===0?'(not set)':'Direct',index===0?'':'(direct)',index===0?'':'(none)'],index===24?123:10));
    return [{rows:detailed,rowCount:25,metadata:{dataLossFromOtherRow:false}}];
  }};
  const result=await diagnoseSessionReconciliation({client,propertyId:'production',date:'2022-08-18'});
  assert.deepEqual(Object.fromEntries(Object.entries(result.grains).map(([name,value])=>[name,value.sessions])),{date:364,device:364,device_channel:364,device_channel_source_medium:363});
  assert.equal(result.disappearance.first_non_reconciling_grain,'device_channel_source_medium');
  assert.equal(result.disappearance.highest_reconciling_grain,'device_channel');
  assert.equal(result.grains.device_channel_source_medium.row_count,25);
});
