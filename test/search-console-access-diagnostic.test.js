import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEARCH_CONSOLE_READONLY_SCOPE,
  classifyError,
  completeDateRange,
  createSearchConsoleClient,
  errorOutput,
  loadConfig,
  normalizeResponse,
  runDiagnostic
} from '../diagnostics/search-console-access.js';

const credentials = {
  client_email: 'tgf-shopify-sync@gf-full-data.iam.gserviceaccount.com',
  private_key: 'secret-key'
};
const siteUrl = 'sc-domain:thegreatfroglondon.com';

test('configuration requires a valid site URL and safely parsed service-account JSON', () => {
  assert.throws(() => loadConfig({}), /SEARCH_CONSOLE_SITE_URL is required/);
  assert.throws(() => loadConfig({ SEARCH_CONSOLE_SITE_URL: 'thegreatfroglondon.com' }), /sc-domain/);
  assert.throws(() => loadConfig({ SEARCH_CONSOLE_SITE_URL: 'sc-domain:example.com/path' }), /sc-domain/);
  assert.throws(() => loadConfig({ SEARCH_CONSOLE_SITE_URL: siteUrl }), /GOOGLE_SERVICE_ACCOUNT_JSON is required/);
  assert.throws(() => loadConfig({ SEARCH_CONSOLE_SITE_URL: siteUrl, GOOGLE_SERVICE_ACCOUNT_JSON: '{' }), /not valid JSON/);
  assert.throws(() => loadConfig({ SEARCH_CONSOLE_SITE_URL: siteUrl, GOOGLE_SERVICE_ACCOUNT_JSON: '[]' }), /JSON object/);
  assert.throws(() => loadConfig({ SEARCH_CONSOLE_SITE_URL: siteUrl, GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), /client_email/);
  assert.throws(() => loadConfig({ SEARCH_CONSOLE_SITE_URL: siteUrl, GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}' }), /private_key/);
  assert.deepEqual(loadConfig({
    SEARCH_CONSOLE_SITE_URL: ` ${siteUrl} `,
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials)
  }), { siteUrl, credentials });
});

test('client construction uses GoogleAuth, the existing credentials, and only the read-only scope', () => {
  let authOptions;
  let webmastersOptions;
  const auth = { marker: 'auth' };
  const google = {
    auth: { GoogleAuth: class { constructor(options) { authOptions = options; return auth; } } },
    webmasters(options) { webmastersOptions = options; return { marker: 'client' }; }
  };
  assert.deepEqual(createSearchConsoleClient(google, credentials), { marker: 'client' });
  assert.deepEqual(authOptions, { credentials, scopes: [SEARCH_CONSOLE_READONLY_SCOPE] });
  assert.deepEqual(webmastersOptions, { version: 'v3', auth });
});

test('diagnostic performs exact read-only property and daily aggregate requests', async () => {
  const requests = [];
  const client = {
    sites: { get: async request => { requests.push(['site', request]); return { data: { permissionLevel: 'siteFullUser' } }; } },
    searchanalytics: { query: async request => {
      requests.push(['analytics', request]);
      return { data: { rows: [{ keys: ['2026-09-09'], clicks: 12, impressions: 300, ctr: 0.04, position: 8.5 }] } };
    } }
  };
  const result = await runDiagnostic({ client, siteUrl, serviceAccountEmail: credentials.client_email, now: new Date('2026-09-18T11:00:00Z') });
  assert.deepEqual(requests, [
    ['site', { siteUrl }],
    ['analytics', { siteUrl, requestBody: {
      startDate: '2026-09-09', endDate: '2026-09-15', dimensions: ['date'], dataState: 'final', rowLimit: 7
    } }]
  ]);
  assert.deepEqual(result, {
    site_url: siteUrl,
    service_account_email: credentials.client_email,
    access_ok: true,
    requested_date_range: { start_date: '2026-09-09', end_date: '2026-09-15' },
    returned_row_count: 1,
    daily_search_performance: [{ date: '2026-09-09', clicks: 12, impressions: 300, ctr: 0.04, position: 8.5 }],
    api_access_status: { code: 'ok', message: 'Search Console property access and Search Analytics query succeeded.' }
  });
});

test('date range and empty response normalization report unavailable data without failing access', () => {
  assert.deepEqual(completeDateRange(new Date('2026-01-02T23:59:00-08:00')), {
    start_date: '2025-12-25', end_date: '2025-12-31'
  });
  assert.deepEqual(normalizeResponse(siteUrl, credentials.client_email, { start_date: '2026-09-09', end_date: '2026-09-15' }, {}), {
    site_url: siteUrl, service_account_email: credentials.client_email, access_ok: true,
    requested_date_range: { start_date: '2026-09-09', end_date: '2026-09-15' }, returned_row_count: 0,
    daily_search_performance: [], api_access_status: {
      code: 'data_unavailable',
      message: 'Search Console property access succeeded, but no final daily data was returned for the requested range.'
    }
  });
});

test('unverified property response is treated as an access failure', async () => {
  const client = {
    sites: { get: async () => ({ data: { permissionLevel: 'siteUnverifiedUser' } }) },
    searchanalytics: { query: async () => assert.fail('query must not run') }
  };
  await assert.rejects(runDiagnostic({ client, siteUrl, serviceAccountEmail: credentials.client_email }), /not a verified user/);
});

test('errors are classified and credentials and tokens are redacted', () => {
  assert.equal(classifyError(new Error('Search Console API has not been used and is disabled')).category, 'api_disabled');
  assert.equal(classifyError({ code: 401, message: 'Unauthenticated' }).category, 'authentication_failure');
  assert.equal(classifyError(new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON')).category, 'authentication_failure');
  assert.equal(classifyError({ code: 403, message: 'Permission denied' }).category, 'property_access_failure');
  assert.equal(classifyError(new Error('SEARCH_CONSOLE_SITE_URL is required')).category, 'invalid_site_url');
  assert.equal(classifyError(new Error('Data unavailable for date range')).category, 'data_unavailable');
  assert.equal(classifyError({ code: 429, message: 'Quota exceeded' }).category, 'quota_or_api_failure');
  assert.equal(classifyError({ code: 500, message: 'Backend error' }).category, 'api_failure');

  const output = errorOutput(new Error(
    'private_key="top-secret" access_token=token-value Bearer abc.def -----BEGIN PRIVATE KEY-----\nkey-body\n-----END PRIVATE KEY-----'
  ), { siteUrl, serviceAccountEmail: credentials.client_email });
  const serialized = JSON.stringify(output);
  assert.equal(output.access_ok, false);
  assert.doesNotMatch(serialized, /top-secret|token-value|abc\.def|key-body/);
  assert.match(serialized, /REDACTED/);
});
