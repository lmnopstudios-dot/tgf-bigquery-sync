import { BigQuery } from '@google-cloud/bigquery';

export function loadBigQueryConfig(env = process.env) {
  let credentials;
  try {
    credentials = env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  } catch {
    throw new Error('Invalid configuration: GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  const project = env.GOOGLE_PROJECT_ID || credentials?.project_id || 'gf-full-data';
  return { project, credentials };
}

export function createBigQueryClient(env = process.env, BigQueryClass = BigQuery) {
  const { project, credentials } = loadBigQueryConfig(env);
  return { project, bigquery: new BigQueryClass({ projectId: project, credentials }) };
}
