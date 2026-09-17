#!/usr/bin/env node

/** Read-only check that the configured service account can query one GA4 property. */
import { pathToFileURL } from 'node:url';

const DATE_RANGE = Object.freeze({ startDate: '7daysAgo', endDate: 'yesterday' });

export function loadConfig(env = process.env) {
  const propertyId = env.GA4_PROPERTY_ID?.trim();
  if (!propertyId) throw new Error('Configuration error: GA4_PROPERTY_ID is required');
  if (!/^\d+$/.test(propertyId)) throw new Error('Configuration error: GA4_PROPERTY_ID must contain only digits');

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

  return { propertyId, credentials };
}

export function createAnalyticsClient(Client, credentials) {
  return new Client({ credentials });
}

export function normalizeResponse(propertyId, serviceAccountEmail, response) {
  const rows = response?.rows ?? [];
  return {
    property_id: propertyId,
    service_account_email: serviceAccountEmail,
    access_ok: true,
    requested_date_range: { start_date: DATE_RANGE.startDate, end_date: DATE_RANGE.endDate },
    returned_row_count: Number(response?.rowCount ?? rows.length),
    daily_sessions: rows.map(row => ({
      date: row.dimensionValues?.[0]?.value ?? null,
      sessions: Number(row.metricValues?.[0]?.value ?? 0)
    }))
  };
}

export async function runDiagnostic({ client, propertyId, serviceAccountEmail }) {
  const [response] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });
  return normalizeResponse(propertyId, serviceAccountEmail, response);
}

export function diagnosticError(error) {
  const message = String(error?.message || error || 'Unknown GA4 error').replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  const code = Number(error?.code);
  if (code === 16 || /invalid_grant|unauthenticated|authentication/i.test(message)) return `Authentication failure: ${message}`;
  if (/api.+(disabled|has not been used)|SERVICE_DISABLED/i.test(message)) return `GA4 Data API disabled: ${message}`;
  if (code === 7 || /permission|access denied|forbidden/i.test(message)) return `GA4 property access failure: ${message}`;
  if (code === 3 || code === 5 || /property.+(invalid|not found)/i.test(message)) return `Invalid or unavailable GA4 property ID: ${message}`;
  return `GA4 access diagnostic failed: ${message}`;
}

async function main() {
  const { propertyId, credentials } = loadConfig();
  const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
  const client = createAnalyticsClient(BetaAnalyticsDataClient, credentials);
  const output = await runDiagnostic({ client, propertyId, serviceAccountEmail: credentials.client_email });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${diagnosticError(error)}\n`);
    process.exitCode = 1;
  });
}
