import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from './product-priority-storage.js';
import {inventoryDiagnostic} from '../shopify/inventory-budget.js';

// Catalogue eligibility is a product-tag predicate, never a title search.
export function inventoryReportScope(message){
  const text=String(message||'');
  if(!/\b(?:stock|inventory)\b/i.test(text)||! /\b(?:all products|everything|all items|entire catalog(?:ue)?)\b/i.test(text))return null;
  const exclusion=text.match(/\b(?:except|excluding|exclude|without|do not have|don't have|not tagged)\b[\s\S]*?[`"“']?(made[- ]to[- ]order)\b/i);
  if(!exclusion)return null;
  return {entity_query:'all products without made-to-order tag',location:null,all_locations:true,excluded_tag:'made-to-order'};
}
export const CATALOGUE_QUERY=`query InventoryCatalogue($cursor:String){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title status tags}}}`;
const VARIANTS=`query InventoryReportVariants($id:ID!,$cursor:String){product(id:$id){variants(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title sku selectedOptions{name value} inventoryItem{id tracked}}}}}`;
const LOCATIONS=`query InventoryReportLocations($cursor:String){locations(first:100,after:$cursor,includeLegacy:true){pageInfo{hasNextPage endCursor}nodes{id name isActive}}}`;
const LEVELS=`query InventoryReportLevels($ids:[ID!]!,$location:ID!){nodes(ids:$ids){... on InventoryItem{id inventoryLevel(locationId:$location){quantities(names:["available","on_hand","committed"]){name quantity}}}}}`;
export const INVENTORY_EXPORT_LIMITS={max_requests:20000,max_variants:100000,max_location_rows:1000000,max_duration_ms:600000,storage_bytes:8000000,max_columns:16384,max_cell_characters:32767};
const fail=code=>Object.assign(new Error(code),{code});
export async function readInventoryReport({graphql,getToken,signal,deadlineAt=Date.now()+INVENTORY_EXPORT_LIMITS.max_duration_ms,now=Date.now,limits=INVENTORY_EXPORT_LIMITS}){
  deadlineAt=Math.min(deadlineAt,now()+limits.max_duration_ms);
  const started=new Date(now()).toISOString(),failures=[],products=[],locations=[],tags=new Map();let token,requests=0;
  const call=async(query,args)=>{
    signal?.throwIfAborted();if(now()>=deadlineAt)throw fail('INVENTORY_DEADLINE_EXCEEDED');
    const child=AbortSignal.timeout(Math.max(1,Math.min(30000,deadlineAt-now()))),combined=signal?AbortSignal.any([signal,child]):child;
    for(let attempt=0;;attempt++){if(requests>=limits.max_requests)throw fail('INVENTORY_REQUEST_LIMIT');requests++;try{return await graphql(token,query,args,combined);}catch(error){if(attempt>=2||!(error.code==='THROTTLED'||error.http_status===429))throw error;await new Promise((resolve,reject)=>{const timer=setTimeout(done,500*(attempt+1));function done(){combined.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(fail('REQUEST_CANCELLED'));}combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();});}}
  };
  const paginate=async(query,args,connection,consume)=>{let cursor=null;const seen=new Set();do{
    const data=await call(query,{...args,cursor}),page=connection(data);
    if(!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw fail('INVENTORY_INVALID_RESPONSE');
    await consume(page.nodes);
    if(!page.pageInfo.hasNextPage)break;
    cursor=page.pageInfo.endCursor;if(!cursor||seen.has(cursor))throw fail('INVENTORY_INVALID_CURSOR');seen.add(cursor);
  }while(true);};
  let catalogueComplete=false,locationsComplete=false,retained=0;
  try{
    const authTimeout=AbortSignal.timeout(Math.max(1,Math.min(30000,deadlineAt-now())));
    token=await getToken(signal?AbortSignal.any([signal,authTimeout]):authTimeout);
    // Inspect every observed tag before selecting products. A partial scan remains explicit.
    await paginate(CATALOGUE_QUERY,{},d=>d.products,rows=>{for(const p of rows){if(!p.id||!Array.isArray(p.tags)||p.tags.some(t=>typeof t!=='string')||!['ACTIVE','DRAFT','ARCHIVED'].includes(p.status))throw fail('INVENTORY_INVALID_PRODUCT');products.push({...p,variants:[]});for(const tag of p.tags)tags.set(tag,(tags.get(tag)||0)+1);}});catalogueComplete=true;
  }catch(error){failures.push(inventoryDiagnostic(error,'catalogue'));}
  const selected=products.filter(p=>['ACTIVE','DRAFT'].includes(p.status)&&!p.tags.some(t=>t.trim().toLowerCase()==='made-to-order'));
  try{await paginate(LOCATIONS,{},d=>d.locations,rows=>{for(const l of rows){if(!l.id||typeof l.isActive!=='boolean')throw fail('INVENTORY_INVALID_LOCATION');if(l.isActive)locations.push(l);}});locationsComplete=true;}catch(error){failures.push(inventoryDiagnostic(error,'locations'));}
  for(const p of selected){
    try{await paginate(VARIANTS,{id:p.id},d=>d.product?.variants,rows=>{if(retained+rows.length>limits.max_variants)throw fail('INVENTORY_VARIANT_LIMIT');p.variants.push(...rows);retained+=rows.length;});}catch(error){failures.push({...inventoryDiagnostic(error,'variants'),product_id:p.id});if(['INVENTORY_REQUEST_LIMIT','INVENTORY_DEADLINE_EXCEEDED','INVENTORY_VARIANT_LIMIT','REQUEST_CANCELLED'].includes(error.code))break;}
  }
  if(retained*locations.length>limits.max_location_rows)throw fail('INVENTORY_EXPORT_ROW_LIMIT');
  const variants=selected.flatMap(p=>p.variants),items=[...new Set(variants.filter(v=>v.inventoryItem?.tracked===true).map(v=>v.inventoryItem.id))],observed=new Map();
  for(const l of locations)for(let i=0;i<items.length;i+=50){const ids=items.slice(i,i+50);try{
    const data=await call(LEVELS,{ids,location:l.id});if(!Array.isArray(data?.nodes))throw fail('INVENTORY_INVALID_RESPONSE');
    const at=new Date(now()).toISOString();for(const item of data.nodes.filter(Boolean))if(ids.includes(item.id)&&Object.hasOwn(item,'inventoryLevel'))observed.set(`${item.id}|${l.id}`,{level:item.inventoryLevel,at});
  }catch(error){failures.push({...inventoryDiagnostic(error,'levels'),location_id:l.id,inventory_item_ids:ids});}}
  for(const v of variants)v.locations=locations.map(l=>{
    const value=observed.get(`${v.inventoryItem?.id}|${l.id}`),tracked=v.inventoryItem?.tracked;
    const q=name=>{const n=value?.level?.quantities?.find(q=>q.name===name)?.quantity;return typeof n==='number'&&Number.isFinite(n)?n:null;};
    const quantities={available:q('available'),on_hand:q('on_hand'),committed:q('committed')};
    const state=tracked===false?'untracked':tracked!==true?'tracking_unknown':!value?'failed':value.level===null?'unstocked':Object.values(quantities).some(n=>n===null)?'incomplete':'observed';
    if(['failed','incomplete','tracking_unknown'].includes(state))failures.push({stage:'level_coverage',code:`INVENTORY_${state.toUpperCase()}`,variant_id:v.id,location_id:l.id});
    return{location_id:l.id,location_name:l.name,...quantities,evidence_state:state,observed_at:value?.at||null};
  });
  return{kind:'inventory_report',subject:'current_stock',entity_query:'all products without made-to-order tag',source:'live_shopify_admin',products:selected,locations,complete:catalogueComplete&&locationsComplete&&!failures.length,failures,started_at:started,as_of:new Date(now()).toISOString(),tag_convention:{predicate:'trimmed case-insensitive exact product tag made-to-order',observed_tags:[...tags].sort().map(([tag,product_count])=>({tag,product_count})),catalogue_complete:catalogueComplete},limits,request_count:requests};
}
export function inventoryWorkbookTables(e){
  const summary=[],detail=[];
  for(const p of e.products)for(const v of p.variants){
    const base={Product:p.title,Status:p.status,'Product ID':p.id,'Variant ID':v.id,SKU:v.sku||'',Variant:v.title,Options:(v.selectedOptions||[]).map(o=>`${o.name}: ${o.value}`).join('; '),Tags:p.tags.join(', ')};
    const row={...base};let total=0,complete=e.complete;
    for(const l of v.locations){const key=`${l.location_name} [${l.location_id}]`;row[`Available: ${key}`]=l.available??l.evidence_state;if(typeof l.available==='number')total+=l.available;if(l.evidence_state!=='observed')complete=false;
      detail.push({...base,'Location ID':l.location_id,Location:l.location_name,Available:l.available,'On hand':l.on_hand,Committed:l.committed,'Evidence state':l.evidence_state,'Retrieved at (UTC)':l.observed_at,'Coverage failures':JSON.stringify(e.failures.filter(f=>(!f.product_id||f.product_id===p.id)&&(!f.variant_id||f.variant_id===v.id)&&(!f.location_id||f.location_id===l.location_id)))});
    }
    row['Total available across active locations']=complete?total:null;row['Observed available subtotal']=v.locations.some(l=>l.available!==null)?total:null;row['Coverage']=complete?'complete':'partial / unknown';summary.push(row);
  }
  return [['Inventory',summary],['Location quantities',detail],['Coverage',[
    {Field:'Complete coverage',Value:String(e.complete)},{Field:'Started at (UTC)',Value:e.started_at},{Field:'Finished at (UTC)',Value:e.as_of},{Field:'Eligibility',Value:'ACTIVE and DRAFT; exclude ARCHIVED; '+e.tag_convention.predicate},
    {Field:'Quantity definition',Value:'Available, On hand and Committed are separate native quantities; never add them. Missing states are not zero. Totals require full observed coverage; observed subtotal is partial.'},
    {Field:'Export limits',Value:JSON.stringify(e.limits)},...e.failures.map(f=>({Field:'Coverage failure',Value:JSON.stringify(f)})),...e.tag_convention.observed_tags.map(t=>({Field:'Observed product tag',Value:JSON.stringify(t)}))
  ]]];
}
const workbookKeys=(name,rows)=>rows.length?[...new Set(rows.flatMap(Object.keys))]:name==='Inventory'?['Product','Status','Product ID','Variant ID','SKU','Variant','Options','Tags','Total available across active locations','Coverage']:['Product ID','Variant ID','Location ID','Available','On hand','Committed','Evidence state','Retrieved at (UTC)','Coverage failures'];
export async function inventoryReportWorkbook(e){const wb=new ExcelJS.Workbook();for(const [name,rows] of inventoryWorkbookTables(e)){const s=wb.addWorksheet(name),keys=workbookKeys(name,rows);if(keys.length>INVENTORY_EXPORT_LIMITS.max_columns)throw fail('INVENTORY_EXPORT_COLUMN_LIMIT');if([...keys,...rows.flatMap(Object.values)].some(v=>typeof v==='string'&&v.length>INVENTORY_EXPORT_LIMITS.max_cell_characters))throw fail('INVENTORY_EXPORT_CELL_LIMIT');s.columns=keys.map(key=>({header:key,key,width:26}));rows.forEach(r=>s.addRow(r));s.getRow(1).font={bold:true};s.views=[{state:'frozen',ySplit:1}];}return Buffer.from(await wb.xlsx.writeBuffer());}
export async function assertInventoryArtifact(a){
  const bytes=Buffer.from(a.xlsx_base64||'','base64');if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw fail('EXPORT_INTEGRITY_FAILED');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);const tables=inventoryWorkbookTables(a.envelope);if(wb.worksheets.length!==tables.length)throw fail('EXPORT_INTEGRITY_FAILED');
  for(const [name,rows] of tables){const s=wb.getWorksheet(name),keys=workbookKeys(name,rows);if(!s||s.rowCount!==Math.max(1,rows.length+1)||s.columnCount!==keys.length||keys.some((key,i)=>s.getRow(1).getCell(i+1).value!==key))throw fail('EXPORT_INTEGRITY_FAILED');for(const [i,row] of rows.entries())for(const [j,key] of keys.entries())if((s.getRow(i+2).getCell(j+1).value??null)!==(row[key]??null))throw fail('EXPORT_INTEGRITY_FAILED');}
}
export function inventoryReportAnswer(e){return `Inventory export: ${e.products.length} eligible active/draft products at ${e.locations.length} active locations. ${e.complete?'Coverage complete.':'Coverage incomplete; see Coverage sheet.'} Product eligibility uses tags. Available, On hand and Committed remain separate. Retrieved ${e.started_at} to ${e.as_of} (UTC). Export limits: ${JSON.stringify(e.limits)}.`;}
export function createInventoryReportService({graphql,getToken,artifactStore,now=Date.now}){
  return async(message,options={})=>{
    if(!inventoryReportScope(message)&&options.analysisContext?.entity_query!=='all products without made-to-order tag')return null;
    const {exportOwner,requestId,downloadBase='/api/oracle/exports'}=options;if(!exportOwner||!requestId)throw fail('EXPORT_OWNER_REQUIRED');
    const id=priorityArtifactId(exportOwner,requestId),existing=await artifactStore.get(id,exportOwner);
    let a=existing;if(a){if(a.request!==message||a.envelope.kind!=='inventory_report')throw fail('EXPORT_REQUEST_ID_CONFLICT');await assertInventoryArtifact(a);}else{
      const e=await readInventoryReport({graphql,getToken,now,signal:options.signal,deadlineAt:options.deadlineAt});const bytes=await inventoryReportWorkbook(e);
      a={request:message,envelope:e,filename:'oracle-inventory.xlsx',answer:inventoryReportAnswer(e),sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')};
      if(Buffer.byteLength(JSON.stringify(a))>INVENTORY_EXPORT_LIMITS.storage_bytes)throw fail('EXPORT_STORAGE_SIZE_EXCEEDED');
      options.signal?.throwIfAborted();await artifactStore.put(id,exportOwner,a);a=await artifactStore.get(id,exportOwner);if(!a)throw fail('EXPORT_PERSISTENCE_FAILED');await assertInventoryArtifact(a);
    }
    const result={answer:a.answer,tools:['get_shopify_inventory_by_location'],partial:!a.envelope.complete,evidence:a.envelope,artifact:{id,filename:a.filename,row_count:a.envelope.products.reduce((n,p)=>n+p.variants.length,0),download_url:`${downloadBase}/${id}`}};await options.onEvidence?.(result);return result;
  };
}
