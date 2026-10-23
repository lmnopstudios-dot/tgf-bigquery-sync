import crypto from 'node:crypto';
import {classifyProduct} from './product-mapping.js';
import {classificationReaderCtes} from './classification-reader.js';
import {validateProductClassification,productClassificationDdl,productClassificationMergeSql} from './product-classification.js';

const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const woo=ref=>/^woo:(ww|usd):[0-9]+$/.test(String(ref||''));
const evidenceOf=row=>typeof row.source_evidence==='string'?JSON.parse(row.source_evidence):row.source_evidence||{};
const generic=value=>['collaboration','collaborations'].includes(value);
const current=rows=>{const superseded=new Set(rows.map(r=>r.supersedes_classification_id).filter(Boolean)),today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/London'});return rows.filter(r=>!superseded.has(r.classification_id)&&['active','conflict'].includes(r.status)&&!['shopify_governed_collection','canonical_propagated'].includes(r.provenance)&&(!r.effective_from||r.effective_from<=today)&&(!r.effective_to||r.effective_to>=today));};
export function historicalClassificationState(records={history:[],evidence:[],conflicts:[]}){
 const history=records.history||[],direct=current(history),inherited=(records.evidence||[]).filter(r=>r.mapping_type!=='direct');
 const names=[...new Set((records.evidence||[]).filter(r=>r.classification_type==='collaboration_name'&&!generic(r.classification_value)).map(r=>r.classification_value))];
 return {revision:digest({history:history.map(r=>[r.classification_id,r.status,r.supersedes_classification_id,r.classification_value,r.effective_from,r.effective_to]).sort(),evidence:(records.evidence||[]).map(r=>[r.mapping_type,r.classification_type,r.classification_value,r.status]).sort()}),history,direct,inherited,names,conflict:!!records.conflicts?.length};
}
export function historicalClassificationReadSql(project){return `WITH ${classificationReaderCtes(project)}
SELECT 'history' row_kind,TO_JSON_STRING(h) record_json FROM \`${project}.commerce.product_classifications\` h WHERE subject_ref IN UNNEST(@refs) AND classification_type IN ('product_group','collaboration_name')
UNION ALL SELECT 'evidence',TO_JSON_STRING(e) FROM cr_evidence e WHERE subject_ref IN UNNEST(@refs) AND classification_type IN ('product_group','collaboration_name')
UNION ALL SELECT 'conflicts',TO_JSON_STRING(c) FROM cr_conflicts c WHERE subject_ref IN UNNEST(@refs) AND classification_type IN ('product_group','collaboration_name')
LIMIT 1001`;}
export function createHistoricalCollaborationService({bigquery,project,productMappingService:mappings,collectionClassificationService:collections}){
 const table=`${project}.commerce.product_classifications`;
 const query=async(operation,options)=>bigquery.query({...options,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000,labels:{component:'historical_collaboration',operation}});
 const choices=async()=>{const data=await collections.list({status:'collaboration'});return data.collections.filter(c=>c.governance_status==='collaboration'&&/^[a-z][a-z0-9_]{0,127}$/.test(c.collaboration_name||'')&&!generic(c.collaboration_name)).map(c=>({collection_id:String(c.collection_id),name:c.collaboration_name,title:c.title||c.collaboration_name,revision:digest([String(c.collection_id),c.collaboration_name,c.title||c.collaboration_name])}));};
 const read=async refs=>{const result=new Map(refs.map(ref=>[ref,{history:[],evidence:[],conflicts:[]} ]));if(!refs.length)return result;
  const [rows]=await query('read_classifications',{query:historicalClassificationReadSql(project),params:{refs},types:{refs:['STRING']}});if(rows.length>1000)throw Error('Classification history exceeds the bounded read; use a narrower product selection');
  for(const row of rows){const r=typeof row.record_json==='string'?JSON.parse(row.record_json):row.record_json;if(!result.has(r.subject_ref)||!['history','evidence','conflicts'].includes(row.row_kind))throw Error('Invalid historical classification evidence');result.get(r.subject_ref)[row.row_kind].push(r);}return result;};
 const operationResult=rows=>{const latest=new Map();for(const r of rows)latest.set(Number(r.row_index),r);const results=[...latest.values()].sort((a,b)=>a.row_index-b.row_index).map(r=>({source_ref:r.source_ref,status:r.status,error:r.error||null}));return{operation_id:rows[0]?.operation_id,status:results.every(r=>r.status!=='submitted')?'complete':'processing',results};};
 const actionCode=input=>`historical_collaboration_${input.action}:${input.collection_id||'none'}`;
 const manifest=input=>({action:input.action,collection_id:input.collection_id||null,collection_revision:input.collection_revision||null,source_refs:input.source_refs,expected:input.source_refs.map(ref=>input.expected[ref])});
 const validate=input=>{if(!input||Object.keys(input).some(k=>!['operation_id','action','collection_id','collection_revision','source_refs','expected'].includes(k)))throw Error('invalid historical collaboration request');
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(input.operation_id||'')||!['assign','revoke'].includes(input.action))throw Error('invalid operation or action');
  if(!Array.isArray(input.source_refs)||!input.source_refs.length||input.source_refs.length>8||new Set(input.source_refs).size!==input.source_refs.length||!input.source_refs.every(woo))throw Error('invalid selection: select 1–8 distinct Woo WW/USD products');
  if(!input.expected||input.source_refs.some(ref=>!/^[a-f0-9]{64}$/.test(input.expected[ref]||'')))throw Error('invalid classification revisions: refresh and review again');
  if(input.action==='assign'&&(!/^[0-9]+$/.test(String(input.collection_id||''))||!/^[a-f0-9]{64}$/.test(input.collection_revision||'')))throw Error('A governed collaboration is required');
 };
 const authorized= (rows,user)=>{if(rows.some(r=>r.reviewed_by!==user||!String(r.action).startsWith('historical_collaboration_')))throw Error('invalid operation ownership');};
 const summarizeRecords=async(op,rows,user)=>{
  authorized(rows,user);const pending=rows.filter(r=>r.status==='submitted'&&!rows.some(t=>t.row_index===r.row_index&&t.status!=='submitted'));
  if(pending.length){const records=await read(pending.map(r=>r.source_ref));for(const r of pending){if(records.get(r.source_ref).history.some(h=>evidenceOf(h).operation_id===op))rows.push({...r,status:'already_applied'});}}
  return operationResult(rows);
 };
 return {
  async list({source='',search='',page=1,inventory='all'}={}){
   if(!['','woo:ww','woo:usd'].includes(source)||!['all','no_equivalent'].includes(inventory)||String(search).length>150)throw Error('invalid historical product filter');
   const [data,names]=await Promise.all([mappings.list({view:'woo_assignment',assignmentStatus:inventory,source,search,page,pageSize:25}),choices()]);
   const refs=data.items.map(x=>x.historical_product.source_product_ref);const records=await read(refs);
   return{collaborations:names,items:data.items.map(x=>({product:x.historical_product,mapping_status:x.resolution_status,classification:historicalClassificationState(records.get(x.historical_product.source_product_ref))})),pagination:data.pagination};
  },
  async status(operationId,user){if(!/^[A-Za-z0-9_-]{8,128}$/.test(operationId))throw Error('invalid operation');const rows=await mappings.readGovernanceOperation(operationId);return rows.length?summarizeRecords(operationId,rows,user):null;},
  async save(input,user){validate(input);const op=input.operation_id,requestHash=digest(manifest(input));await mappings.setup();
   let receipts=await mappings.readGovernanceOperation(op);if(receipts.length){authorized(receipts,user);if(input.source_refs.some((ref,i)=>!receipts.some(r=>r.row_index===i&&r.source_ref===ref&&r.row_request_id===digest([requestHash,ref]))))throw Error('invalid operation: already belongs to a different submission');
    const recovered=await summarizeRecords(op,receipts,user);if(recovered.status==='complete')return recovered;
   }
   const choice=input.action==='assign'?(await choices()).find(c=>c.collection_id===String(input.collection_id)):null;if(input.action==='assign'&&(!choice||choice.revision!==input.collection_revision))throw Error('invalid governed collaboration: selected name is no longer active');
   const productByRef=new Map((await mappings.readProductInventory()).map(p=>[p.source_product_ref,p]));
   if(input.source_refs.some(ref=>!productByRef.has(ref)||classifyProduct(productByRef.get(ref).title,productByRef.get(ref))!=='merchandise_product'))throw Error('A selected Woo merchandise product was not found');
   const base=input.source_refs.map((source_ref,row_index)=>({operation_id:op,row_index,row_request_id:digest([requestHash,source_ref]),source_ref,action:actionCode(input),shopify_parent_ref:null,reviewed_by:user,decision_event_id:null,error:null}));
   if(!receipts.length){await mappings.appendGovernanceOperation(base.map(r=>({...r,status:'submitted'})));receipts=await mappings.readGovernanceOperation(op);}
   const states=await read(input.source_refs),newRows=[],terminal=[];
   for(const r of base){const prior=receipts.find(t=>t.row_index===r.row_index&&t.status!=='submitted');if(prior)continue;
    const records=states.get(r.source_ref),state=historicalClassificationState(records);
    if(records.history.some(h=>evidenceOf(h).operation_id===op)){terminal.push({...r,status:'already_applied'});continue;}
    let reason=state.revision!==input.expected[r.source_ref]?'Classification changed; refresh and review again':null;
    if(input.action==='assign'&&state.inherited.some(h=>h.status==='conflict'||(h.classification_type==='collaboration_name'&&!generic(h.classification_value)&&h.classification_value!==choice.name)||(h.classification_type==='product_group'&&['core','core_range'].includes(h.classification_value))))reason='Conflicting inherited classification; review the existing mapping or classification first';
    const old=input.action==='assign'?state.direct:state.direct.filter(h=>h.provenance==='human_approved'&&(h.classification_type==='collaboration_name'||h.classification_value==='collaboration'));
    if(input.action==='revoke'&&!old.length)reason='No current direct human collaboration assignment to remove';
    if(reason){terminal.push({...r,status:'blocked',error:reason});continue;}
    const now=new Date().toISOString(),common={subject_ref:r.source_ref,canonical_product_ref:null,subject_grain:'source_product',provenance:'human_approved',origin_subject_ref:r.source_ref,source_evidence:{operation_id:op,collection_id:choice?.collection_id||null,collection_title:choice?.title||null,ui:'historical_woo_collaboration'},authority:'human',confidence:'high',status:'active',conflict_reason:null,effective_from:null,effective_to:null,supersedes_classification_id:null,recorded_at:now,recorded_by:user,reviewed_at:now,reviewed_by:user};
    const make=(kind,fields)=>validateProductClassification({...common,...fields,classification_id:'pc_'+digest([op,r.source_ref,kind]).slice(0,32)});
    for(const oldRow of old)newRows.push(make('revoke:'+oldRow.classification_id,{classification_type:oldRow.classification_type,classification_value:oldRow.classification_value,status:'revoked',supersedes_classification_id:oldRow.classification_id}));
    if(input.action==='assign')for(const [classification_type,classification_value]of [['product_group','collaboration'],['collaboration_name',choice.name]])newRows.push(make(classification_type,{classification_type,classification_value}));
    terminal.push({...r,status:'saved'});
   }
   if(newRows.length){await query('ensure_classifications',{query:productClassificationDdl(project)});await query('append_classifications',{query:productClassificationMergeSql(table,{appendOnly:true}),params:{payload:JSON.stringify(newRows)},types:{payload:'STRING'}});}
   if(terminal.length)await mappings.appendGovernanceOperation(terminal);return summarizeRecords(op,await mappings.readGovernanceOperation(op),user);
  }
 };
}
