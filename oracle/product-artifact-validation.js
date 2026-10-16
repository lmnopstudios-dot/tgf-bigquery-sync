import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { assertCatalogueSelection, scopeMismatch } from './product-catalogue-filter.js';

// Recovery checks stored bytes, not just a successful persistence marker.
export async function assertProductArtifact(artifact){
  const e=artifact?.envelope;
  if(e?.kind==='governed_population_conversion'){const {assertCountryWorkbook}=await import('./country-conversion-export.js');return assertCountryWorkbook(artifact);}
  if(e?.kind==='governed_klaviyo_campaign_set'){
    const {assertCampaignSetEvidence,campaignWorkbookRows}=await import('./campaign-set-analysis.js');
    const {assertPlanAgreement}=await import('./analytical-plan.js');
    if(!artifact.analysis_context)throw scopeMismatch('artifact.analysis_context');
    assertPlanAgreement(artifact.analysis_context,e);assertCampaignSetEvidence(artifact.analysis_context,e);
    const bytes=Buffer.from(artifact.xlsx_base64||'','base64');
    if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw scopeMismatch('artifact.sha256');
    const wb=new ExcelJS.Workbook();try{await wb.xlsx.load(bytes);}catch{throw scopeMismatch('artifact.workbook');}
    const rows=campaignWorkbookRows(e),keys=Object.keys(rows[0]),sheet=wb.getWorksheet('Campaigns');
    if(!sheet||sheet.rowCount!==rows.length+1)throw scopeMismatch('artifact.rows');
    for(const [i,row] of rows.entries())for(const [j,key] of keys.entries())if((sheet.getRow(i+2).getCell(j+1).value??null)!==(row[key]??null))throw scopeMismatch('artifact.metrics');
    return true;
  }
  if(e?.kind==='governed_basket_composition'){
    const {assertBasketEvidence,basketWorkbookTables}=await import('./basket-composition.js');
    if(!artifact.analysis_context)throw scopeMismatch('artifact.analysis_context');
    assertBasketEvidence(artifact.analysis_context,e);
    const bytes=Buffer.from(artifact.xlsx_base64||'','base64');
    if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw scopeMismatch('artifact.sha256');
    const wb=new ExcelJS.Workbook();try{await wb.xlsx.load(bytes);}catch{throw scopeMismatch('artifact.workbook');}
    for(const [name,rows] of [['Summary',e.rows],...basketWorkbookTables(e)]){
      if(!rows.length)continue;
      const sheet=wb.getWorksheet(name),keys=[...new Set(rows.flatMap(Object.keys))];
      if(!sheet||sheet.rowCount!==rows.length+1)throw scopeMismatch('artifact.rows');
      for(const [i,row] of rows.entries())for(const [j,key] of keys.entries())if((sheet.getRow(i+2).getCell(j+1).value??null)!==(row[key]??null))throw scopeMismatch('artifact.metrics');
    }
    return true;
  }
  if(e?.kind==='governed_order_values'){
    const {assertOrderValueEvidence,orderValueGapRows,orderValueWorkbookTables}=await import('./order-value-analysis.js');
    if(!artifact.analysis_context)throw scopeMismatch('artifact.analysis_context');
    assertOrderValueEvidence(artifact.analysis_context,e);
    const bytes=Buffer.from(artifact.xlsx_base64||'','base64');
    if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw scopeMismatch('artifact.sha256');
    const wb=new ExcelJS.Workbook();try{await wb.xlsx.load(bytes);}catch{throw scopeMismatch('artifact.workbook');}
    const expected=[['Summary',e.rows],['Sales',e.sections.flatMap(s=>s.bands.map(b=>({comparison:s.label,...b})))],['Products',e.candidates],['Context',orderValueGapRows(e.sections)],...orderValueWorkbookTables(e)];
    for(const [name,rows] of expected){
      if(!rows.length)continue;
      const sheet=wb.getWorksheet(name),keys=[...new Set(rows.flatMap(Object.keys))];
      if(!sheet||sheet.rowCount!==rows.length+1)throw scopeMismatch('artifact.rows');
      for(const [index,row] of rows.entries())for(const [column,key] of keys.entries())if((sheet.getRow(index+2).getCell(column+1).value??null)!==(row[key]??null))throw scopeMismatch('artifact.metrics');
    }
    return true;
  }
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
