import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { assertCatalogueSelection, scopeMismatch } from './product-catalogue-filter.js';

// Recovery checks stored bytes, not just a successful persistence marker.
export async function assertProductArtifact(artifact){
  const e=artifact?.envelope;
  if(!e?.report_config)return true; // Other supported export families validate separately.
  if(e.manifest?.complete_catalogue!==true)throw scopeMismatch('manifest.complete_catalogue');
  assertCatalogueSelection(e,e.report_config);
  const bytes=Buffer.from(artifact.xlsx_base64||'','base64');
  if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw scopeMismatch('artifact.sha256');
  const wb=new ExcelJS.Workbook();
  try{await wb.xlsx.load(bytes);}catch{throw scopeMismatch('artifact.workbook');}
  const sheet=wb.worksheets[0],preset=Boolean(e.report_config.priority_preset),linkColumn=preset?3:2;
  if(wb.worksheets.length!==1||sheet.rowCount!==e.rows.length+1)throw scopeMismatch('artifact.product_ids');
  for(const [index,row] of e.rows.entries()){
    if(sheet.getRow(index+2).getCell(linkColumn).value?.hyperlink!==row.url)throw scopeMismatch('artifact.product_ids');
    if(!preset)for(const [column,definition] of e.report_columns.entries()){
      if(!definition.metric)continue;
      const actual=sheet.getRow(index+2).getCell(column+1).value??null,expected=row.metrics[definition.key]??null;
      if(actual!==expected)throw scopeMismatch('artifact.metrics');
    }
  }
  return true;
}
