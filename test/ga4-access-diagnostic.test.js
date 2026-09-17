import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalyticsClient, diagnosticError, loadConfig, normalizeResponse, runDiagnostic } from '../diagnostics/ga4-access.js';

const validCredentials = { client_email: 'reader@example.iam.gserviceaccount.com', private_key: 'secret-key' };

test('configuration requires a numeric property ID and valid service-account JSON', () => {
  assert.throws(() => loadConfig({}), /GA4_PROPERTY_ID is required/);
  assert.throws(() => loadConfig({ GA4_PROPERTY_ID: 'properties/123' }), /only digits/);
  assert.throws(() => loadConfig({ GA4_PROPERTY_ID: '123' }), /GOOGLE_SERVICE_ACCOUNT_JSON is required/);
  assert.throws(() => loadConfig({ GA4_PROPERTY_ID: '123', GOOGLE_SERVICE_ACCOUNT_JSON: '{' }), /not valid JSON/);
  assert.throws(() => loadConfig({ GA4_PROPERTY_ID: '123', GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), /client_email/);
  assert.throws(() => loadConfig({ GA4_PROPERTY_ID: '123', GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}' }), /private_key/);
  assert.deepEqual(loadConfig({ GA4_PROPERTY_ID: ' 291532339 ', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(validCredentials) }), {
    propertyId: '291532339', credentials: validCredentials
  });
});

test('client construction passes the existing credentials without copying or logging them', () => {
  class FakeClient { constructor(options) { this.options = options; } }
  const client = createAnalyticsClient(FakeClient, validCredentials);
  assert.strictEqual(client.options.credentials, validCredentials);
});

test('diagnostic submits one minimal read-only report and normalizes its response', async () => {
  let request;
  const client = { runReport: async value => {
    request = value;
    return [{ rowCount: 2, rows: [
      { dimensionValues: [{ value: '20260909' }], metricValues: [{ value: '17' }] },
      { dimensionValues: [{ value: '20260910' }], metricValues: [{ value: '23' }] }
    ] }];
  } };
  const result = await runDiagnostic({ client, propertyId: '291532339', serviceAccountEmail: validCredentials.client_email });
  assert.deepEqual(request, {
    property: 'properties/291532339', dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });
  assert.deepEqual(result, {
    property_id: '291532339', service_account_email: validCredentials.client_email, access_ok: true,
    requested_date_range: { start_date: '7daysAgo', end_date: 'yesterday' }, returned_row_count: 2,
    daily_sessions: [{ date: '20260909', sessions: 17 }, { date: '20260910', sessions: 23 }]
  });
});

test('response normalization handles an empty report and errors are clear and redact keys', () => {
  assert.deepEqual(normalizeResponse('123', 'reader@example.com', {}), {
    property_id: '123', service_account_email: 'reader@example.com', access_ok: true,
    requested_date_range: { start_date: '7daysAgo', end_date: 'yesterday' }, returned_row_count: 0, daily_sessions: []
  });
  assert.match(diagnosticError({ code: 16, message: 'Unauthenticated' }), /^Authentication failure:/);
  assert.match(diagnosticError({ code: 7, message: 'Analytics Data API has not been used and is disabled' }), /^GA4 Data API disabled:/);
  assert.match(diagnosticError({ code: 7, message: 'Permission denied' }), /^GA4 property access failure:/);
  assert.match(diagnosticError({ code: 3, message: 'Bad property' }), /^Invalid or unavailable GA4 property ID:/);
  const redacted = diagnosticError(new Error('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'));
  assert.doesNotMatch(redacted, /secret/);
});
