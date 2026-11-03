import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from './product-priority-storage.js';
import {stableAnalyticalJSON,resolveAnalyticalPlan,analyticalPlanKey} from './analytical-plan.js';
const LIMIT=8_000_000;
const incomplete=e=>Boolean(e&&typeof e==='object'&&(e.complete===false||e.partial===true||e.truncated===true||e.retrieval_failed===true||Object.values(e).some(v=>v&&typeof v==='object'&&incomplete(v)))) ;
const fail=code=>Object.assign(new Error(code),{code});
const scalar=v=>v==null?null:typeof v==='object'?Object.keys(v).length===1&&'value'in v?scalar(v.value):stableAnalyticalJSON(v):v;
const privateKey=/^(?:email|email_address|phone|phone_number|billing_address|shipping_address|address|customer_id|source_customer_id|canonical_customer_ref|customer_email|customer_name|first_name|last_name|access_token|refresh_token|private_key|authorization|password)$/i;
function safe(value){
 if(Array.isArray(value)){for(const v of value)safe(v);return;}
 if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value)){if(privateKey.test(k))throw fail('SPREADSHEET_PERSONAL_OR_SECRET_FIELDS');safe(v);}}
}
export function retainedSpreadsheetTables(evidence,{answer='',context={},as_of=null,partial=false}={}){
 if(!evidence||typeof evidence!=='object')throw fail('SPREADSHEET_EVIDENCE_UNAVAILABLE');
 safe(evidence);
 const tables=[];
 const nested=v=>v&&typeof v==='object'&&(Array.isArray(v)||Object.values(v).some(x=>nested(x)));
 if(['current_stock','inventory_report'].includes(evidence.kind)&&Array.isArray(evidence.products)){
  const locations=evidence.location_coverage?.resolved||evidence.locations||[];
  const headers=['Product','Variant','SKU',...locations.map(l=>l.name||l.location_name||l.id)];
  const rows=evidence.products.flatMap(p=>(p.variants||[]).map(v=>[p.title,v.title,v.sku||null,...locations.map(l=>{const q=v.locations?.find(q=>q.location_id===(l.id||l.location_id));return typeof q?.available==='number'?q.available:null;})]));
  if(!rows.length)throw fail('SPREADSHEET_NO_STRUCTURED_ROWS');
  tables.push({name:'Inventory',headers,rows});
  const states=evidence.products.flatMap(p=>(p.variants||[]).flatMap(v=>(v.locations||[]).filter(l=>l.available==null).map(l=>[p.title,v.title,l.location_name,l.evidence_state||'unavailable'])));
  if(states.length)tables.push({name:'Unavailable quantities',headers:['Product','Variant','Location','Evidence state'],rows:states});
 }else{
  // Tabular arrays carry their parent scalar labels into nested cohort/product
  // tables, preserving denominators, units and source order without summing.
  const visit=(node,path='Results',parents={},depth=0)=>{
   if(depth>10)throw fail('SPREADSHEET_STRUCTURE_DEPTH');
   if(Array.isArray(node)){
    if(node.length&&node.every(r=>r&&typeof r==='object'&&!Array.isArray(r))){
     const records=node.map(r=>({...parents,...Object.fromEntries(Object.entries(r).filter(([,v])=>!nested(v)).map(([k,v])=>[k,scalar(v)]))}));
     const headers=[...new Set(records.flatMap(Object.keys))];
     if(headers.length&&!node.every(r=>r.result&&typeof r.result==='object'))tables.push({name:path,headers,rows:records.map(r=>headers.map(k=>r[k]??null))});
     node.forEach((r,i)=>{const parent={...parents,parent_row:i+1,...Object.fromEntries(Object.entries(r).filter(([,v])=>v==null||typeof v!=='object'))};for(const [k,v]of Object.entries(r))if(v&&typeof v==='object'&&(Array.isArray(v)?v.length:nested(v)))visit(v,path+' '+k,parent,depth+1);});
    }
    return;
   }
   if(node&&typeof node==='object')for(const [k,v]of Object.entries(node)){
    // Operational metadata is kept in source notes rather than shown as metrics.
    if(['analytical_plan','diagnostics','source_ids','resolution','failures','coverage','periods','semantics','definition','limitations'].includes(k))continue;
    if(v&&typeof v==='object'){const labels=Object.fromEntries(Object.entries(node).filter(([key,value])=>['currency','unit','units','source_store','window_days','denominator','sales_metric','metric','timezone'].includes(key)&&(value==null||typeof value!=='object')));visit(v,path==='Results'?k:path+' '+k,{...parents,...labels},depth+1);}
   }
  };
  visit(evidence);
  if(!tables.length)throw fail('SPREADSHEET_NO_STRUCTURED_ROWS');
 }
 const observationTimes=[...new Map((evidence.products||[]).flatMap(p=>(p.variants||[]).flatMap(v=>(v.locations||[]).map(l=>[JSON.stringify([p.title,v.title,l.location_id,l.observed_at]),{product:p.title,variant:v.title,location:l.location_name,observed_at:l.observed_at}])))).values()];
 const metadata={source_timestamps:{as_of:evidence.as_of,generated_at:evidence.generated_at,started_at:evidence.started_at},periods:evidence.periods||null,observation_times:observationTimes,retained_evidence:true,refreshed:false,as_of,partial:partial||incomplete(evidence),scope:context,coverage:evidence.coverage??evidence.classification_coverage??null,limitations:evidence.limitations??evidence.semantics??null,failures:evidence.failures??null,source_response:answer,blank_cells:'Unavailable or absent in source evidence; never substituted with zero.',ordering:'Source order preserved; no cross-currency totals or recomputed rates.'};
 const notes=Object.entries(metadata).flatMap(([k,v])=>{const value=scalar(v);if(typeof value!=='string'||value.length<=30000)return [[k,value]];const rows=[];for(let i=0;i<value.length;i+=30000)rows.push([`${k} part ${Math.floor(i/30000)+1}`,value.slice(i,i+30000)]);return rows;});
 tables.push({name:'Source notes',headers:['Field','Value'],rows:notes});
 const used=new Set();for(const t of tables){let n=t.name.replace(/[\\/*?:\[\]]/g,' ').slice(0,26)||'Results',candidate=n,i=2;while(used.has(candidate.toLowerCase()))candidate=n+' '+i++;used.add(candidate.toLowerCase());t.name=candidate;if(t.rows.length>1_048_575||t.headers.length>16384||[t.headers,...t.rows].flat().some(v=>typeof v==='string'&&v.length>32767))throw fail('SPREADSHEET_EXCEL_LIMIT');}
 return tables;
}
async function workbookBytes(tables){const wb=new ExcelJS.Workbook();for(const t of tables){const s=wb.addWorksheet(t.name);s.addRow(t.headers);t.rows.forEach(r=>s.addRow(r));s.getRow(1).font={bold:true};s.views=[{state:'frozen',ySplit:1}];s.columns.forEach((c,i)=>c.width=i===0?32:24);}return Buffer.from(await wb.xlsx.writeBuffer());}
export const isRetainedSpreadsheetArtifact=a=>a?.envelope?.kind==='retained_spreadsheet'||a?.retained_export?.version===1;
export const spreadsheetSourceEvidence=a=>a.envelope.kind==='retained_spreadsheet'?a.envelope.source_evidence:a.envelope;
const sourceInfo=a=>a.envelope.kind==='retained_spreadsheet'?a.envelope:{...a.retained_export,source_evidence:a.envelope,row_count:a.envelope.rows?.length||0};
async function nativeWorkbook(e,c,answer){
 // Full source text is split safely into notes below; the native overview
 // cell must also stay within Excel's single-cell limit.
 answer=answer.slice(0,30000);
 const {reportWorkbook}=await import('./report-export.js');
 const period=e.periods?.[0];
 if(e.kind==='governed_klaviyo_campaign_set'){
  const {campaignWorkbookRows}=await import('./campaign-set-analysis.js');const rows=campaignWorkbookRows(e),wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet('Campaigns'),keys=Object.keys(rows[0]);sheet.addRow(keys);rows.forEach(r=>sheet.addRow(keys.map(k=>r[k])));wb.addWorksheet('Definitions').addRow([answer]);return {bytes:Buffer.from(await wb.xlsx.writeBuffer()),filename:'oracle-klaviyo-campaigns.xlsx'};
 }
 if(e.kind==='governed_basket_composition'){
  const {basketWorkbookTables,BASKET_DEFINITIONS}=await import('./basket-composition.js');
  return {bytes:Buffer.from(await reportWorkbook({generated_at:e.generated_at,period,comparison:period,kpis:e.rows,additional_sheets:basketWorkbookTables(e),limitations:[...Object.values(BASKET_DEFINITIONS),JSON.stringify(e.coverage),answer]})),filename:'oracle-retained-results.xlsx'};
 }
 if(e.kind==='governed_weekday_sales')return {bytes:Buffer.from(await reportWorkbook({generated_at:e.generated_at,period,comparison:period,trend:e.rows.map(r=>({source_store:e.source_store,currency:e.currency,...r})),limitations:[answer,JSON.stringify(e.coverage),JSON.stringify(e.definitions),JSON.stringify(e.promotion)]})),filename:'oracle-weekday-sales.xlsx'};
 if(e.kind==='governed_order_values'){
  const {orderValueWorkbookTables,orderValueGapRows}=await import('./order-value-analysis.js');return {bytes:Buffer.from(await reportWorkbook({generated_at:e.generated_at,period,comparison:period,kpis:e.rows,additional_sheets:orderValueWorkbookTables(e),trend:e.sections.flatMap(s=>s.bands.map(b=>({comparison:s.label,...b}))),products:e.candidates,context:orderValueGapRows(e.sections),limitations:[answer,JSON.stringify(e.coverage)]})),filename:'oracle-order-value-scenarios.xlsx'};
 }
 return null;
}
export async function assertRetainedSpreadsheet(a){
 if(!isRetainedSpreadsheetArtifact(a)||!a.analysis_context)throw fail('EXPORT_INTEGRITY_FAILED');
 const e=sourceInfo(a);
 const {assertEvidenceAgreement}=await import('./analysis-route-dispatcher.js');assertEvidenceAgreement(a.analysis_context,e.source_evidence);
 if(createHash('sha256').update(stableAnalyticalJSON(e.source_evidence)).digest('hex')!==e.evidence_sha256)throw fail('EXPORT_INTEGRITY_FAILED');
 const bytes=Buffer.from(a.xlsx_base64||'','base64');if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw fail('EXPORT_INTEGRITY_FAILED');
 if(a.envelope.kind!=='retained_spreadsheet'){const {assertProductArtifact}=await import('./product-artifact-validation.js');await assertProductArtifact({...a,retained_export:undefined});const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);const expectedNotes=retainedSpreadsheetTables(e.source_evidence,{context:a.analysis_context,answer:e.source_answer,as_of:e.source_as_of,partial:e.source_partial}).at(-1).rows;const notes=wb.getWorksheet('Definitions');if(!notes||notes.rowCount<expectedNotes.length)throw fail('EXPORT_INTEGRITY_FAILED');const offset=notes.rowCount-expectedNotes.length;for(const [i,row]of expectedNotes.entries())for(const [j,value]of row.entries())if((notes.getRow(offset+i+1).getCell(j+1).value??null)!==(value??null))throw fail('EXPORT_INTEGRITY_FAILED');return;}
 const expected=retainedSpreadsheetTables(e.source_evidence,{context:a.analysis_context,answer:e.source_answer,as_of:e.source_as_of,partial:e.source_partial});
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);if(wb.worksheets.length!==expected.length)throw fail('EXPORT_INTEGRITY_FAILED');
 for(const [index,t]of expected.entries()){const s=wb.worksheets[index];if(s.name!==t.name||s.rowCount!==t.rows.length+1||s.columnCount!==t.headers.length)throw fail('EXPORT_INTEGRITY_FAILED');for(const [i,row]of [t.headers,...t.rows].entries())for(const [j,v]of row.entries())if((s.getRow(i+1).getCell(j+1).value??null)!==(v??null))throw fail('EXPORT_INTEGRITY_FAILED');}
}
export function retainedSpreadsheetResult(a,id,downloadBase='/api/oracle/exports'){
 const e=sourceInfo(a);
 return {retained_at:e.source_retained_at,retained_source_answer:e.source_answer,answer:`Spreadsheet created from the retained results${e.source_partial||e.source_evidence.complete===false?' (incomplete evidence; see Source notes)':''}. No data was refreshed. Original observation times and limitations are retained.\n\n<details><summary>Show details</summary>\n\n${e.source_answer||'See workbook source notes.'}\n\n</details>`,presentation:{version:1,summary_markdown:`Spreadsheet created from retained results${e.source_partial||e.source_evidence.complete===false?' (incomplete evidence; see workbook source notes)':''}. No data was refreshed.`,supporting_markdown:e.source_answer||''},analysis_context:a.analysis_context,evidence:e.source_evidence,partial:e.source_partial||e.source_evidence.complete===false,tools:[],artifact:{id,filename:a.filename,row_count:e.row_count,download_url:`${downloadBase}/${id}`}};
}
export async function exportRetainedSpreadsheet({recent,context,store,owner,requestId,downloadBase,assertAgreement,now=Date.now()}){
 const unavailable=(code,detail)=>({answer:detail+' No data was refreshed.',analysis_context:context,tools:[],analysis_unavailable:true,export_outcome:{status:'failed',detail,code}});
 if(!store||!owner||!requestId)return unavailable('EXPORT_STORAGE_UNAVAILABLE','Spreadsheet storage is unavailable.');
 const id=priorityArtifactId(owner,requestId);
 const existing=await store.get(id,owner);
 if(existing){if(!isRetainedSpreadsheetArtifact(existing)||stableAnalyticalJSON(existing.analysis_context)!==stableAnalyticalJSON(context))throw fail('EXPORT_REQUEST_ID_CONFLICT');await assertRetainedSpreadsheet(existing);assertAgreement(context,spreadsheetSourceEvidence(existing));return retainedSpreadsheetResult(existing,id,downloadBase);}
 if(!recent?.evidence)return unavailable('SPREADSHEET_EVIDENCE_UNAVAILABLE','There are no compatible retained structured results to export.');
 if(!recent.retained_at||!Number.isFinite(Date.parse(recent.retained_at))||now-Date.parse(recent.retained_at)>15*60_000)return unavailable('SPREADSHEET_EVIDENCE_EXPIRED','The retained results have expired; explicitly request a refreshed report if needed.');
 try{if(recent.analysis_context&&analyticalPlanKey(resolveAnalyticalPlan(context))!==analyticalPlanKey(resolveAnalyticalPlan(recent.analysis_context)))throw fail('SPREADSHEET_SCOPE_MISMATCH');assertAgreement(context,recent.evidence);}catch{return unavailable('SPREADSHEET_SCOPE_MISMATCH','The retained results do not match the current analysis scope.');}
 let tables;try{tables=retainedSpreadsheetTables(recent.evidence,{context,answer:recent.answer,as_of:recent.as_of,partial:recent.partial});}catch(error){if(!/^SPREADSHEET_/.test(error.code||''))throw error;return unavailable(error.code,error.code==='SPREADSHEET_PERSONAL_OR_SECRET_FIELDS'?'These retained results contain fields unsupported by the aggregate spreadsheet exporter.':'The retained results have no supported tabular structure or exceed Excel limits.');}
 const native=await nativeWorkbook(recent.evidence,context,recent.answer||'');
 let bytes=native?.bytes||await workbookBytes(tables);
 if(native){const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);const notes=wb.getWorksheet('Definitions')||wb.addWorksheet('Definitions');for(const row of tables.at(-1).rows)notes.addRow(row);bytes=Buffer.from(await wb.xlsx.writeBuffer());}
 const provenance={version:1,source_answer:recent.answer||'',source_as_of:recent.as_of||null,source_retained_at:recent.retained_at,source_partial:Boolean(recent.partial)||incomplete(recent.evidence),evidence_sha256:createHash('sha256').update(stableAnalyticalJSON(recent.evidence)).digest('hex')};
 const artifact={analysis_context:context,filename:native?.filename||'oracle-retained-results.xlsx',...(native?{retained_export:provenance}:{}),envelope:native?recent.evidence:{kind:'retained_spreadsheet',source_evidence:recent.evidence,...provenance,row_count:tables.slice(0,-1).reduce((n,t)=>n+t.rows.length,0)},sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')};
 if(Buffer.byteLength(JSON.stringify(artifact))>LIMIT)return unavailable('EXPORT_STORAGE_SIZE_EXCEEDED','The retained export exceeds the storage limit; no rows were truncated.');
 await assertRetainedSpreadsheet(artifact);await store.put(id,owner,artifact);const saved=await store.get(id,owner);await assertRetainedSpreadsheet(saved);assertAgreement(context,spreadsheetSourceEvidence(saved));return retainedSpreadsheetResult(saved,id,downloadBase);
}

// Direct/shared callers use an owner-scoped, short-lived cache of validated
// results. UI/durable callers pass their own session-scoped retained evidence.
const retainedByService=new WeakMap();
export function rememberSpreadsheetEvidence(service,owner,result,context,now=Date.now()){
 if(typeof service!=='function'||!owner||!result?.evidence||result.analysis_unavailable)return;
 let entries=retainedByService.get(service);if(!entries){entries=new Map();retainedByService.set(service,entries);}
 for(const [key,v]of entries)if(now-Date.parse(v.retained_at)>15*60_000)entries.delete(key);
 entries.set(owner,{...result,analysis_context:result.analysis_context||context,retained_at:result.retained_at||new Date(now).toISOString(),as_of:result.evidence.as_of||result.evidence.generated_at||new Date(now).toISOString()});
}
export function spreadsheetEvidenceFor(service,owner){return retainedByService.get(service)?.get(owner)||null;}
