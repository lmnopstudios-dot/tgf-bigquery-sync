#!/usr/bin/env node

/** Read-only check that the existing service account can access one Search Console property. */
import { pathToFileURL } from 'node:url';

export const SEARCH_CONSOLE_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const COMPLETE_DATA_LAG_DAYS = 3;

function isValidSiteUrl(siteUrl) {
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length);
    return /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(domain);
  }
  try {
    const parsed = new URL(siteUrl);
    return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function loadConfig(env = process.env) {
  const siteUrl = env.SEARCH_CONSOLE_SITE_URL?.trim();
  if (!siteUrl) throw new Error('Configuration error: SEARCH_CONSOLE_SITE_URL is required');
  if (!isValidSiteUrl(siteUrl)) {
    throw new Error('Configuration error: SEARCH_CONSOLE_SITE_URL must be an sc-domain: property or an HTTP(S) URL-prefix property');
  }
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('Configuration error: GOOGLE_SERVICE_ACCOUNT_JSON is required');
  }

  let credentials;
  try {
    credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('Configuration error: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('Configuration error: GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object');
  }
  if (typeof credentials.client_email !== 'string' || !credentials.client_email.trim()) {
    throw new Error('Configuration error: service-account JSON is missing client_email');
  }
  if (typeof credentials.private_key !== 'string' || !credentials.private_key.trim()) {
    throw new Error('Configuration error: service-account JSON is missing private_key');
  }
  return { siteUrl, credentials };
}

export function createSearchConsoleClient(googleApi, credentials) {
  const auth = new googleApi.auth.GoogleAuth({ credentials, scopes: [SEARCH_CONSOLE_READONLY_SCOPE] });
  return googleApi.webmasters({ version: 'v3', auth });
}

export function completeDateRange(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - COMPLETE_DATA_LAG_DAYS));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  const isoDate = date => date.toISOString().slice(0, 10);
  return { start_date: isoDate(start), end_date: isoDate(end) };
}

export function normalizeResponse(siteUrl, serviceAccountEmail, dateRange, response) {
  const rows = response?.data?.rows ?? response?.rows ?? [];
  const dailySearchPerformance = rows.map(row => ({
    date: row.keys?.[0] ?? null,
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    ctr: Number(row.ctr ?? 0),
    position: Number(row.position ?? 0)
  }));
  const hasData = dailySearchPerformance.length > 0;
  return {
    site_url: siteUrl,
    service_account_email: serviceAccountEmail,
    access_ok: true,
    requested_date_range: dateRange,
    returned_row_count: dailySearchPerformance.length,
    daily_search_performance: dailySearchPerformance,
    api_access_status: {
      code: hasData ? 'ok' : 'data_unavailable',
      message: hasData
        ? 'Search Console property access and Search Analytics query succeeded.'
        : 'Search Console property access succeeded, but no final daily data was returned for the requested range.'
    }
  };
}

export async function runDiagnostic({ client, siteUrl, serviceAccountEmail, now = new Date() }) {
  const site = await client.sites.get({ siteUrl });
  if (site?.data?.permissionLevel === 'siteUnverifiedUser') {
    const error = new Error('The service account is not a verified user of the configured Search Console property.');
    error.code = 403;
    throw error;
  }

  const dateRange = completeDateRange(now);
  const response = await client.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: dateRange.start_date,
      endDate: dateRange.end_date,
      dimensions: ['date'],
      dataState: 'final',
      rowLimit: 7
    }
  });
  return normalizeResponse(siteUrl, serviceAccountEmail, dateRange, response);
}

export function redactSecrets(value) {
  return String(value ?? 'Unknown Search Console error')
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/("?(?:private_key|access_token|refresh_token|client_secret)"?\s*[:=]\s*)"?[^"\s,}]+"?/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

export function classifyError(error) {
  const message = redactSecrets(error?.message || error);
  const code = Number(error?.code ?? error?.response?.status);
  let category = 'api_failure';
  let explanation = 'Search Console API request failed.';
  if (/SEARCH_CONSOLE_SITE_URL|site url/i.test(message)) {
    category = 'invalid_site_url'; explanation = 'The Search Console site URL is missing or invalid.';
  } else if (/SERVICE_DISABLED|accessNotConfigured|api.+(?:disabled|has not been used)/i.test(message)) {
    category = 'api_disabled'; explanation = 'The Search Console API is disabled or has not been enabled for the Google Cloud project.';
  } else if (code === 401 || /GOOGLE_SERVICE_ACCOUNT_JSON|service-account JSON|invalid_grant|unauthenticated|authentication|invalid credentials/i.test(message)) {
    category = 'authentication_failure'; explanation = 'The service-account credentials could not authenticate.';
  } else if (code === 403 || /permission|forbidden|verified user|access denied/i.test(message)) {
    category = 'property_access_failure'; explanation = 'The service account cannot read the configured Search Console property.';
  } else if (/date range|data.+(?:unavailable|not available)|no data/i.test(message)) {
    category = 'data_unavailable'; explanation = 'Search Analytics data is unavailable for the requested date range.';
  } else if (code === 429 || /quota|rate.?limit|resource exhausted/i.test(message)) {
    category = 'quota_or_api_failure'; explanation = 'The Search Console API quota or rate limit was exceeded.';
  }
  return { category, explanation, message };
}

export function errorOutput(error, config = {}) {
  const status = classifyError(error);
  return {
    site_url: config.siteUrl ?? null,
    service_account_email: config.serviceAccountEmail ?? null,
    access_ok: false,
    requested_date_range: null,
    returned_row_count: 0,
    daily_search_performance: [],
    api_access_status: status
  };
}

async function main() {
  let config;
  try {
    config = loadConfig();
    const { google } = await import('googleapis');
    const client = createSearchConsoleClient(google, config.credentials);
    const output = await runDiagnostic({
      client,
      siteUrl: config.siteUrl,
      serviceAccountEmail: config.credentials.client_email
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorOutput(error, {
      siteUrl: config?.siteUrl,
      serviceAccountEmail: config?.credentials?.client_email
    }), null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
