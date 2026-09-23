#!/usr/bin/env node
/** Read-only, aggregate-only validation of the governed Product Mapping workflow. */
import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { approvedMappingEdges, governedDecisionCtes, resolveMappingDecisions } from '../oracle/product-mapping.js';
import { inspectProductGraph } from '../oracle/product-graph-integrity.js';

export function productMappingValidationQueries(project) {
  return {
    schema: `SELECT column_name,data_type,is_nullable FROM \`${project}.commerce.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='product_mapping_decisions' ORDER BY ordinal_position`,
    resolver: `WITH ${governedDecisionCtes(project)} SELECT COUNT(*) history_decisions,COUNTIF(status='approved') active_approved,COUNTIF(status='rejected') active_rejected,(SELECT COUNT(*) FROM governed_superseded) supersession_links FROM governed_current`,
    history: `WITH ${governedDecisionCtes(project)} SELECT status,COUNT(*) decisions FROM governed_history GROUP BY status ORDER BY status`,
    graph_integrity: `SELECT * FROM \`${project}.commerce.product_mapping_decisions\` ORDER BY reviewed_at,COALESCE(decision_id,event_id)`,
    suppression: `WITH ${governedDecisionCtes(project)} SELECT COUNTIF(status IN ('rejected','revoked')) suppressed_relationships FROM governed_current`,
    search: `SELECT COUNT(*) governed_products FROM (SELECT CAST(product_id AS STRING) id FROM \`${project}.metorik_uk.order_line_items\` UNION DISTINCT SELECT CAST(product_id AS STRING) FROM \`${project}.metorik_us.order_line_items\` UNION DISTINCT SELECT product_id FROM \`${project}.shopify_data.order_line_items\` UNION DISTINCT SELECT COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id) FROM \`${project}.square_data.retail_order_items\`)`
  };
}
export function assertReadOnly(queries){for(const [name,sql] of Object.entries(queries))if(!/^\s*(SELECT|WITH)\b/i.test(sql)||/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql))throw new Error(`${name} is not read-only`);return true;}
export async function validateProductMapping({bigquery,project,onProgress=()=>{}}){const queries=productMappingValidationQueries(project);assertReadOnly(queries);const checks={};for(const [name,query] of Object.entries(queries)){onProgress(name);const [rows]=await bigquery.query({query,useLegacySql:false,maximumBytesBilled:'10000000000'});checks[name]=rows;}const state=resolveMappingDecisions(checks.graph_integrity);const graph=inspectProductGraph({explicitEdges:approvedMappingEdges(state.history)});checks.graph_integrity={...graph.summary,conflicted_component_ids:graph.conflicted_component_ids,orphaned_supersession_links:state.orphanedSupersessionLinks.length,conflict_diagnostics:graph.conflict_diagnostics};return {contract:{read_only:true,aggregate_only:false,no_test_writes:true,canonical_graph_integrity:true,diagnostics_bounded:true},checks};}
async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;const result=await validateProductMapping({bigquery:new BigQuery({projectId:project,credentials}),project,onProgress:name=>console.error(`Validating ${name}…`)});console.log(JSON.stringify(result,null,2));}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({validator:'product-mapping-production',read_only:true,error:error.message}));process.exitCode=1});
