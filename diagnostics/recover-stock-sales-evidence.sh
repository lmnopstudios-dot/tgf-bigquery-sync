# Paste this entire command into the Render shell from the app repository.
# Only reads the existing owner-scoped artifact; never initializes export storage.
node --input-type=module <<'NODE'
import { BigQuery } from '@google-cloud/bigquery';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, chmod, writeFile } from 'node:fs/promises';

try {
  const id = 'abf857468192764b4ea46dfe4c47a6e8798c4bb3bc422eebd71de22e420cb62e';
  const project = process.env.GOOGLE_PROJECT_ID;
  const secret = process.env.ORACLE_UI_SESSION_SECRET;
  const identity = process.env.ORACLE_UI_ADMIN_NAME || 'oracle-admin';
  if (!/^[A-Za-z0-9_-]+$/.test(project || '') ||
      !secret || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('Missing configuration');
  }
  const owner = createHmac('sha256', secret)
    .update(`oracle-export:${identity}`).digest('hex');
  const bigquery = new BigQuery({
    projectId: project,
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  });
  const [metadata] = await bigquery.dataset('commerce').getMetadata();
  const [rows] = await bigquery.query({
    query: `SELECT artifact_json
            FROM \`${project}.commerce.oracle_exports_v1\`
            WHERE artifact_id=@id AND owner_key=@owner
            LIMIT 1`,
    params: { id, owner },
    location: metadata.location,
    useLegacySql: false,
    maximumBytesBilled: '100000000',
    jobTimeoutMs: 10000,
    labels: { component: 'oracle_incident', operation: 'retained_read' }
  });
  if (rows.length !== 1) throw new Error('Artifact not found for chat owner');
  const artifact = typeof rows[0].artifact_json === 'string'
    ? JSON.parse(rows[0].artifact_json) : rows[0].artifact_json;
  if (typeof artifact?.request !== 'string' ||
      artifact?.envelope?.kind !== 'inventory_report') {
    throw new Error('Unexpected artifact shape');
  }
  process.umask(0o077);
  const dir = await mkdtemp('/tmp/oracle-retained-');
  await chmod(dir, 0o700);
  const path = `${dir}/${id}.json`;
  const bytes = Buffer.from(JSON.stringify({
    artifact_id: id,
    recovered_at: new Date().toISOString(),
    artifact
  }, null, 2) + '\n');
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({
    status: 'saved', path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }));
} catch {
  console.error('Recovery failed; no evidence or credentials printed. Check configuration, owner, access and artifact existence.');
  process.exitCode = 1;
}
NODE
