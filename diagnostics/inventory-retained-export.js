// Owner-scoped SELECT only: no DDL, report replay, Shopify calls or writes.
import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from '../oracle/product-priority-storage.js';
import {assertInventoryArtifact,inventoryWorkbookTables,inventoryJsonMetadataCell,inventoryMetadataEqual} from '../oracle/inventory-report.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
const identifier=v=>{if(!/^[A-Za-z0-9_-]+$/.test(v||''))throw Object.assign(new Error(),{code:'CONFIGURATION_INVALID'});return v;};
export async function inspectRetainedInventoryExport({bigquery,project,dataset,requestId,owner}){
 const id=priorityArtifactId(owner,requestId),location=(await boundedEvidenceRead(()=>bigquery.dataset(dataset).getMetadata(),{maximumMs:10000}))[0].location;
 const [rows]=await boundedEvidenceRead(()=>bigquery.query({query:`SELECT artifact_json FROM \`${identifier(project)}.${identifier(dataset)}.oracle_exports_v1\` WHERE artifact_id=@id AND owner_key=@owner LIMIT 1`,params:{id,owner},location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:10000,labels:{component:'inventory_incident'}}),{maximumMs:12000});
 const base={stage:'retained_inventory_export',request_id:requestId,read_only:true,report_replayed:false,owner_scoped:true};if(!rows.length)return{...base,status:'not_found'};
 const a=typeof rows[0].artifact_json==='string'?JSON.parse(rows[0].artifact_json):rows[0].artifact_json;if(a.envelope?.kind!=='inventory_report')return{...base,status:'different_artifact_family'};
 const e=a.envelope,bytes=Buffer.from(a.xlsx_base64||'','base64'),wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);
 let differences=0;const cells=[];
 for(const [name,table] of inventoryWorkbookTables(e)){
  const keys=[...new Set(table.flatMap(Object.keys))],sheet=wb.getWorksheet(name);let failureIndex=0,tagIndex=0;if(!sheet)continue;
  for(const [i,row] of table.entries())for(const [j,key] of keys.entries()){
   if(!inventoryJsonMetadataCell(name,key,row))continue;
   let expected=row[key];
   // Reproduce the deployed pre-fix metadata encoding using hydrated native JSON.
   if(name==='Coverage')expected=JSON.stringify(row.Field==='Export limits'?e.limits:row.Field==='Coverage failure'?e.failures[failureIndex++]:e.tag_convention.observed_tags[tagIndex++]);
   else expected=JSON.stringify(e.failures.filter(f=>(!f.product_id||f.product_id===row['Product ID'])&&(!f.variant_id||f.variant_id===row['Variant ID'])&&(!f.location_id||f.location_id===row['Location ID'])));
   const actual=sheet.getRow(i+2).getCell(j+1).value??null;
   if(actual!==expected&&inventoryMetadataEqual(actual,expected)){differences++;if(cells.length<10)cells.push({sheet:name,row:i+2,column:j+1});}
  }
 }
 let validation='verified',integrity=null;try{await assertInventoryArtifact(a);}catch(error){validation='failed';integrity=error.integrity||{reason:'validation_rejected'};}
 return{...base,status:'found',complete:e.complete,catalogue_complete:e.population?.catalogue_complete??e.tag_convention?.catalogue_complete??null,products:e.products.length,locations:e.locations?.length??null,sha256_matches:createHash('sha256').update(bytes).digest('hex')===a.sha256,repaired_workbook_validation:validation,integrity,legacy_json_member_order_differences:differences,example_cells:cells,examples_truncated:differences>cells.length};
}
