// Preparation only. This module has no warehouse client, write or activation API.
import {pathToFileURL} from 'node:url';
import {squareExtensionConfiguration,squareExtensionGuard,SQUARE_IDENTITY_VERSION} from '../oracle/square-reporting-extension.js';
export const SQUARE_REVIEW_PROPOSAL=Object.freeze({
 extension_id:'square_channels_v1_history_20261022_billing_v3_review_20261103',
 state:'reviewed',reporting_version:'square_channels_v1',
 identity_version:'square_native_email_v1',base_snapshot:'history-20261022-billing-v3'
});
export function squareActivationPlan(){
 const record={...SQUARE_REVIEW_PROPOSAL},render={ORACLE_SQUARE_REPORTING_VERSION:record.reporting_version,ORACLE_SQUARE_REPORTING_EXTENSION_ID:record.extension_id};
 if(record.identity_version!==SQUARE_IDENTITY_VERSION)throw Error('Identity version drift');
 const guard=squareExtensionGuard('gf-full-data',{dataset:'customer_identity',snapshot:record.base_snapshot},squareExtensionConfiguration(render));
 const table='`gf-full-data.customer_identity.identity_reporting_extensions`';
 const fields=Object.keys(record),values=Object.values(record).map(x=>{if(!/^[A-Za-z0-9_-]+$/.test(x))throw Error('Invalid review proposal');return `'${x}'`;});
 const same=fields.slice(1).map((k,i)=>`${k}=${values[i+1]}`).join(' AND ');
 const reviewSql=`-- PROPOSED ONLY: run only after explicit review/activation approval.\n-- No identity snapshot, mapping, ready marker or source table is changed.\nCREATE TABLE IF NOT EXISTS ${table} (\n ${fields.map(k=>`${k} STRING NOT NULL`).join(',\n ')}\n);\nBEGIN TRANSACTION;\nASSERT (SELECT COUNT(*)=0 OR (COUNT(*)=1 AND COUNTIF(${same})=1) FROM ${table} WHERE extension_id=${values[0]}) AS 'Existing extension differs or is duplicated; stop without overwriting it';\nINSERT INTO ${table} (${fields.join(',')})\nSELECT ${values.join(',')}\nFROM UNNEST([1]) AS review_seed\nWHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE extension_id=${values[0]});\nASSERT ${guard} AS 'Reviewed extension guard must pass';\nCOMMIT TRANSACTION;`;
 return {preparation_only:true,approval_required:true,activated:false,table:'gf-full-data.customer_identity.identity_reporting_extensions',proposed_record:record,render_settings:render,unchanged_identity_settings:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:record.base_snapshot},proposed_sql:reviewSql,post_approval_guard_read:`SELECT ${guard} AS reviewed_extension_matches`,rollback:'Remove the two ORACLE_SQUARE_REPORTING_* settings and redeploy. Preserve the reviewed row as evidence; do not replace or republish the base snapshot.'};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){if(process.argv.length!==2)throw Error('Preparation only; no arguments or execute mode supported');console.log(JSON.stringify(squareActivationPlan(),null,2));}
