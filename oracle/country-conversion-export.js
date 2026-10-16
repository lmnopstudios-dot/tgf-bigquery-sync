import ExcelJS from 'exceljs';
import { assertPlanAgreement } from './analytical-plan.js';
import { createHash } from 'node:crypto';
import { priorityArtifactId } from './product-priority-storage.js';
import { assertPopulationConversionEvidence } from './population-conversion.js';
export function countryWorkbookTables(e){
  return [['Conversion',e.sections.flatMap(s=>s.rows.map(r=>({month:s.month||null,partial_month:s.partial_month??null,start_date:s.period.start_date,end_date:s.period.end_date,measurement_era:s.measurement_era,time_zone:s.time_zone,population:r.group,country:e.population_scope.country,sessions:r.sessions,completed_checkout_sessions:r.numerator,rate:r.rate})))],['Coverage',e.source.coverage.categories||[...e.source.partitions.flatMap(p=>[...new Set(p.rows.map(r=>r.date))].map(date=>({date,category:'supported',reason:'native_report'}))),...e.source.coverage.missing_days.map(date=>({date,category:'missing',reason:'native_row_missing'})),...e.source.coverage.excluded_days.map(d=>({...d,category:d.reason==='before_governed_Shopify_launch'?'pre-source-history':d.reason==='current_or_future_day'?'current/incomplete day':'measurement-transition exclusion'}))].sort((a,b)=>a.date.localeCompare(b.date))],['Definitions',[{numerator:'Native human sessions_that_completed_checkout',denominator:'Native human sessions',rate:'Sum of numerators / sum of denominators',unknown_geography:'Included in global; excluded from direct rest-of-world predicate',upstream_tracking_completeness:'unverified',source_history:'Shopify from 2025-11-20; Woo/GA4 conversion definitions are incompatible',evidence_cutoff:e.source.coverage.last_compatible_day}]]];
}
export async function exportCountryConversion(result,{context,exportStore,exportOwner,requestId,onEvidence}={}){
  if(context.output_preference!=='xlsx')return result;
  if(!exportStore||!exportOwner||!requestId)return {...result,answer:result.answer+'\n\nExport storage is unavailable; retrieved figures are retained.'};
  const id=priorityArtifactId(exportOwner,requestId);
  try{
    const saved=await exportStore.get?.(id,exportOwner);
    if(saved){assertPlanAgreement(context,saved.envelope);assertPopulationConversionEvidence(context,saved.envelope);await assertCountryWorkbook(saved);return {...result,answer:saved.answer,evidence:saved.envelope,artifact:{id,filename:saved.filename,row_count:saved.envelope.sections.reduce((n,s)=>n+s.rows.length,0),download_url:`/api/oracle/exports/${id}`}};}
    const workbook=new ExcelJS.Workbook();workbook.creator='Oracle';
    for(const [name,rows] of countryWorkbookTables(result.evidence)){
      const sheet=workbook.addWorksheet(name),keys=[...new Set(rows.flatMap(Object.keys))];
      sheet.columns=keys.map(key=>({header:key,key,width:24}));sheet.addRows(rows);
      if(name==='Conversion')sheet.getColumn('rate').numFmt='0.00%';
    }
    const bytes=Buffer.from(await workbook.xlsx.writeBuffer()),filename='oracle-visitor-country-conversion.xlsx';
    await exportStore.put(id,exportOwner,{answer:result.answer,analysis_context:context,envelope:result.evidence,filename,sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')});
    const exported={...result,artifact:{id,filename,row_count:result.evidence.sections.reduce((n,s)=>n+s.rows.length,0),download_url:`/api/oracle/exports/${id}`}};
    await onEvidence?.(exported);return exported;
  }catch(error){if(error.code==='EVIDENCE_SCOPE_MISMATCH')throw error;return {...result,answer:result.answer+'\n\nThe spreadsheet could not be saved. Retrieved figures are retained; retry the export explicitly.'};}
}
export async function assertCountryWorkbook(artifact){
  assertPopulationConversionEvidence(artifact.analysis_context,artifact.envelope);
  const bytes=Buffer.from(artifact.xlsx_base64||'','base64');
  const fail=()=>{throw Object.assign(Error('Country workbook differs from evidence'),{code:'EVIDENCE_SCOPE_MISMATCH'});};
  if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)fail();
  const wb=new ExcelJS.Workbook();try{await wb.xlsx.load(bytes);}catch{fail();}
  for(const [name,rows] of countryWorkbookTables(artifact.envelope)){
    const keys=[...new Set(rows.flatMap(Object.keys))],sheet=wb.getWorksheet(name);
    if(!sheet||sheet.rowCount!==rows.length+1)fail();
    for(const [j,key] of keys.entries())if(sheet.getRow(1).getCell(j+1).value!==key)fail();
    for(const [i,row] of rows.entries())for(const [j,key] of keys.entries())if((sheet.getRow(i+2).getCell(j+1).value??null)!==(row[key]??null))fail();
  }
  return true;
}
