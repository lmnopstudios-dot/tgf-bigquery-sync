import {fq} from './collect.js';

// BigQuery permits concurrent append-only transactions. Mutating this existing,
// unpartitioned singleton makes concurrent publishers conflict across hosts.
// Provision once via the reviewed migration; never bootstrap it in a publisher.
export function publicationGuardSql(project,dataset){
  const table=fq(project,dataset,'identity_publication_guard');
  return `ASSERT (SELECT COUNT(*) FROM ${table})=1 AS 'Publication guard unavailable';
    UPDATE ${table} SET generation=generation+1 WHERE guard_id='publication' AND generation IS NOT NULL;
    ASSERT @@row_count=1 AS 'Publication guard unavailable';`;
}
