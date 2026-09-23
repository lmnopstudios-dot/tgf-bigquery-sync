#!/usr/bin/env node
/** Read-only, aggregate-only validation of the governed Product Mapping workflow. */
import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { governedDecisionCtes } from '../oracle/product-mapping.js';

export function productMappingValidationQueries(project) {
  return {
    schema: `SELECT column_name,data_type,is_nullable FROM \`${project}.commerce.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='product_mapping_decisions' ORDER BY ordinal_position`,
    resolver: `WITH ${governedDecisionCtes(project)} SELECT COUNT(*) history_decisions,COUNTIF(status='approved') active_approved,COUNTIF(status='rejected') active_rejected,(SELECT COUNT(*) FROM governed_superseded) supersession_links FROM governed_current`,
    history: `WITH ${governedDecisionCtes(project)} SELECT status,COUNT(*) decisions FROM governed_history GROUP BY status ORDER BY status`,
    graph_integrity: `WITH ${governedDecisionCtes(project)} SELECT COUNTIF(left_ref=right_ref) self_edges,COUNTIF(ARRAY_TO_STRING(ARRAY_SLICE(SPLIT(left_ref,':'),0,2),':')=ARRAY_TO_STRING(ARRAY_SLICE(SPLIT(right_ref,':'),0,2),':')) same_namespace_edges FROM governed_active`,
    suppression: `WITH ${governedDecisionCtes(project)} SELECT COUNTIF(status IN ('rejected','revoked')) suppressed_relationships FROM governed_current`,
    search: `SELECT COUNT(*) governed_products FROM (SELECT CAST(product_id AS STRING) id FROM \`${project}.metorik_uk.order_line_items\` UNION DISTINCT SELECT CAST(product_id AS STRING) FROM \`${project}.metorik_us.order_line_items\` UNION DISTINCT SELECT product_id FROM \`${project}.shopify_data.order_line_items\` UNION DISTINCT SELECT COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id) FROM \`${project}.square_data.retail_order_items\`)`
  };
}
export function assertReadOnly(queries){for(const [name,sql] of Object.entries(queries))if(!/^\s*(SELECT|WITH)\b/i.test(sql)||/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql))throw new Error(`${name} is not read-only`);return true;}
export async function validateProductMapping({bigquery,project,onProgress=()=>{}}){const queries=productMappingValidationQueries(project);assertReadOnly(queries);const checks={};for(const [name,query] of Object.entries(queries)){onProgress(name);const [rows]=await bigquery.query({query,useLegacySql:false,maximumBytesBilled:'10000000000'});checks[name]=rows;}return {contract:{read_only:true,aggregate_only:true,no_test_writes:true},checks};}
async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;const result=await validateProductMapping({bigquery:new BigQuery({projectId:project,credentials}),project,onProgress:name=>console.error(`Validating ${name}…`)});console.log(JSON.stringify(result,null,2));}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({validator:'product-mapping-production',read_only:true,error:error.message}));process.exitCode=1});
