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
  assert.deepEqual(parseDiagnosticArgs(['--date','2022-08-18']), { date: '2022-08-18' });
});
