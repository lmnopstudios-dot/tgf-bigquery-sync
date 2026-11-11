import {inventoryCatalogueExportIntent,inventoryScopeError} from './inventory-export-intent.js';
import {FILTERED_INVENTORY_ENTITY,filteredInventoryScope,validateInventoryReportConfig,inventoryReportConfigKey,resolveInventoryGroups,inventoryVariantSelection,inventoryReportScopeLabel} from './inventory-report-config.js';
import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from './product-priority-storage.js';
import {inventoryDiagnostic} from '../shopify/inventory-budget.js';

// Shopify ProductStatus has included UNLISTED since Admin API 2025-10.
// Schema validity and requested population eligibility are separate decisions.
export const INVENTORY_PRODUCT_STATUSES=Object.freeze(['ACTIVE','DRAFT','ARCHIVED','UNLISTED']);
const INVENTORY_POPULATIONS=Object.freeze({
  'all products without made-to-order tag':['ACTIVE','DRAFT','UNLISTED'],
  'active and draft products without made-to-order tag':['ACTIVE','DRAFT']
});
export const isInventoryReportContext=context=>context?.requested_subject==='current_stock'&&(context.stock_scope&&(context.stock_scope.format==='xlsx'||context.output_preference==='xlsx')||context.inventory_report!=null||Object.hasOwn(INVENTORY_POPULATIONS,context.entity_query));
const typeOf=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
export function validateInventoryProduct(product,{page=1,index=0}={}){
  const invalid=(field,value,expected)=>{
    const observed=field==='status'&&typeof value==='string'&&/^[A-Z_]{1,64}$/.test(value)?value:value===null||typeof value==='boolean'||typeof value==='number'?value:null;
    throw Object.assign(new Error('Inventory product schema validation failed'),{code:'INVENTORY_INVALID_PRODUCT',catalogue_validation:{field,observed_type:typeOf(value),observed_value:observed,expected,product_id:typeof product?.id==='string'&&/^gid:\/\/shopify\/Product\/\d+$/.test(product.id)?product.id:null,page,index}});
  };
  if(!product||typeof product!=='object'||Array.isArray(product))invalid('product',product,'Product object');
  if(typeof product.id!=='string'||!product.id)invalid('id',product.id,'nonempty Shopify product ID');
  if(!Array.isArray(product.tags))invalid('tags',product.tags,'array of strings');
  const badTag=product.tags.findIndex(t=>typeof t!=='string');
  if(badTag>=0)invalid(`tags[${badTag}]`,product.tags[badTag],'string');
  if(!INVENTORY_PRODUCT_STATUSES.includes(product.status))invalid('status',product.status,INVENTORY_PRODUCT_STATUSES.join('|'));
  return product;
}

// Catalogue eligibility is a product-tag predicate, never a title search.
export function inventoryReportScope(message){
  const filtered=filteredInventoryScope(message);if(filtered)return filtered;
  const text=String(message||'');
  if(!/\b(?:stock|inventory)\b/i.test(text)||! /\b(?:all\s+(?:(?:active\s+(?:and|&)\s+draft|draft\s+(?:and|&)\s+active)\s+)?(?:Shopify\s+)?(?:products|items)|everything|entire catalog(?:ue)?)\b/i.test(text)){if(inventoryCatalogueExportIntent(message))throw inventoryScopeError();return null;}
  const exclusion=text.match(/\b(?:except|excluding|exclude|without|do not have|don't have|not tagged)\b[\s\S]*?[`"“']?(made[- ]to[- ]order)\b/i);
  if(!exclusion){if(inventoryCatalogueExportIntent(message))throw inventoryScopeError();return null;}
  const explicitStatuses=/\ball\s+(?:active\s+(?:and|&)\s+draft|draft\s+(?:and|&)\s+active)\b/i.test(text);
  return {entity_query:explicitStatuses?'active and draft products without made-to-order tag':'all products without made-to-order tag',location:null,all_locations:true,excluded_tag:'made-to-order'};
}
export const CATALOGUE_QUERY=`query InventoryCatalogue($cursor:String){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title status tags}}}`;
const VARIANTS=`query InventoryReportVariants($id:ID!,$cursor:String){product(id:$id){variants(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title sku selectedOptions{name value} inventoryItem{id tracked}}}}}`;
const LOCATIONS=`query InventoryReportLocations($cursor:String){locations(first:100,after:$cursor,includeLegacy:true){pageInfo{hasNextPage endCursor}nodes{id name isActive}}}`;
const LEVELS=`query InventoryReportLevels($ids:[ID!]!,$location:ID!){nodes(ids:$ids){... on InventoryItem{id inventoryLevel(locationId:$location){quantities(names:["available","on_hand","committed"]){name quantity}}}}}`;
export const INVENTORY_EXPORT_LIMITS={max_requests:20000,max_variants:100000,max_location_rows:1000000,max_duration_ms:600000,storage_bytes:8000000,max_columns:16384,max_cell_characters:32767};
const fail=code=>Object.assign(new Error(code),{code});
export async function readInventoryReport({graphql,getToken,signal,deadlineAt=Date.now()+INVENTORY_EXPORT_LIMITS.max_duration_ms,now=Date.now,limits=INVENTORY_EXPORT_LIMITS,entityQuery='all products without made-to-order tag',reportConfig=null,requiredExactTag=null,catalogueOnly=false,selectProduct=null,prepareSelection=null}){
  const config=validateInventoryReportConfig(reportConfig);if(config)entityQuery=FILTERED_INVENTORY_ENTITY;const excludedTags=(requiredExactTag||selectProduct)?[]:config?.excluded_tags||['made-to-order'];
  const eligibleStatuses=(requiredExactTag||selectProduct)?INVENTORY_PRODUCT_STATUSES:config?.statuses||INVENTORY_POPULATIONS[entityQuery];if(!eligibleStatuses)throw fail('INVENTORY_POPULATION_INVALID');
  deadlineAt=Math.min(deadlineAt,now()+limits.max_duration_ms);
  const started=new Date(now()).toISOString(),failures=[],products=[],locations=[],tags=new Map();let token,requests=0;
  const call=async(query,args)=>{
    signal?.throwIfAborted();if(now()>=deadlineAt)throw fail('INVENTORY_DEADLINE_EXCEEDED');
    const child=AbortSignal.timeout(Math.max(1,Math.min(30000,deadlineAt-now()))),combined=signal?AbortSignal.any([signal,child]):child;
    for(let attempt=0;;attempt++){if(requests>=limits.max_requests)throw fail('INVENTORY_REQUEST_LIMIT');requests++;try{return await graphql(token,query,args,combined);}catch(error){if(attempt>=2||!(error.code==='THROTTLED'||error.http_status===429))throw error;await new Promise((resolve,reject)=>{const timer=setTimeout(done,500*(attempt+1));function done(){combined.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(fail('REQUEST_CANCELLED'));}combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();});}}
  };
  const paginate=async(query,args,connection,consume)=>{let cursor=null,pageNumber=0;const seen=new Set();do{
    const data=await call(query,{...args,cursor}),page=connection(data);
    if(!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw fail('INVENTORY_INVALID_RESPONSE');
    await consume(page.nodes,{page:++pageNumber});
    if(!page.pageInfo.hasNextPage)break;
    cursor=page.pageInfo.endCursor;if(!cursor||seen.has(cursor))throw fail('INVENTORY_INVALID_CURSOR');seen.add(cursor);
  }while(true);};
  let catalogueComplete=false,locationsComplete=false,retained=0;
  try{
    const authTimeout=AbortSignal.timeout(Math.max(1,Math.min(30000,deadlineAt-now())));
    token=await getToken(signal?AbortSignal.any([signal,authTimeout]):authTimeout);
    // Inspect every observed tag before selecting products. A partial scan remains explicit.
    await paginate(CATALOGUE_QUERY,{},d=>d.products,(rows,{page})=>{for(const [index,p] of rows.entries()){validateInventoryProduct(p,{page,index});products.push({...p,variants:[]});for(const tag of p.tags)tags.set(tag,(tags.get(tag)||0)+1);}});catalogueComplete=true;
  }catch(error){failures.push({...inventoryDiagnostic(error,'catalogue'),...(error.catalogue_validation?{validation:error.catalogue_validation}:{})});}
  let selection=null;
  if(prepareSelection&&token)try{selection=await prepareSelection(paginate);}catch(error){failures.push(inventoryDiagnostic(error,'collection_selection'));}
  const requiredTagMatches=p=>!requiredExactTag||p.tags.some(t=>t.toLowerCase()===requiredExactTag.toLowerCase());
  const catalogueAudit=products.map(p=>({product_id:p.id,status:p.status,eligible:(!selectProduct||selectProduct(p,selection))&&requiredTagMatches(p)&&eligibleStatuses.includes(p.status)&&!p.tags.some(t=>excludedTags.includes(t.trim().toLowerCase())),exclusion:!requiredTagMatches(p)?'required_tag_missing':!eligibleStatuses.includes(p.status)?'outside_requested_statuses':p.tags.some(t=>excludedTags.includes(t.trim().toLowerCase()))?(config?'excluded_product_tag':'made-to-order_tag'):null}));
  const eligibleIds=new Set(catalogueAudit.filter(p=>p.eligible).map(p=>p.product_id)),selected=products.filter(p=>eligibleIds.has(p.id));
  if(!catalogueOnly)try{await paginate(LOCATIONS,{},d=>d.locations,rows=>{for(const l of rows){if(!l.id||typeof l.isActive!=='boolean')throw fail('INVENTORY_INVALID_LOCATION');if(l.isActive)locations.push(l);}});locationsComplete=true;if(config){const resolved=resolveInventoryGroups(config,locations);failures.push(...resolved.failures);const ids=new Set([...resolved.groups.pos,...resolved.groups.online].map(l=>l.id));locations.splice(0,locations.length,...locations.filter(l=>ids.has(l.id)));}}catch(error){failures.push(inventoryDiagnostic(error,'locations'));}
  for(const p of selected){
    try{await paginate(VARIANTS,{id:p.id},d=>d.product?.variants,rows=>{if(retained+rows.length>limits.max_variants)throw fail('INVENTORY_VARIANT_LIMIT');p.variants.push(...rows);retained+=rows.length;});}catch(error){failures.push({...inventoryDiagnostic(error,'variants'),product_id:p.id});if(['INVENTORY_REQUEST_LIMIT','INVENTORY_DEADLINE_EXCEEDED','INVENTORY_VARIANT_LIMIT','REQUEST_CANCELLED'].includes(error.code))break;}
  }
  const levelsBounded=retained*locations.length<=limits.max_location_rows;
  if(!levelsBounded){if(!requiredExactTag&&!selectProduct)throw fail('INVENTORY_EXPORT_ROW_LIMIT');failures.push({stage:'levels',code:'INVENTORY_EXPORT_ROW_LIMIT'});}
  const variants=selected.flatMap(p=>p.variants),items=[...new Set(variants.filter(v=>v.inventoryItem?.tracked===true).map(v=>v.inventoryItem.id))],observed=new Map();
  if(levelsBounded)for(const l of locations)for(let i=0;i<items.length;i+=50){const ids=items.slice(i,i+50);try{
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
  return{kind:'inventory_report',subject:'current_stock',entity_query:entityQuery,...(config?{inventory_report:config}:{}),population:{eligible_statuses:eligibleStatuses,catalogue_complete:catalogueComplete,locations_complete:locationsComplete,status_counts:Object.fromEntries(INVENTORY_PRODUCT_STATUSES.map(status=>[status,products.filter(p=>p.status===status).length])),audit:catalogueAudit},source:'live_shopify_admin',products:selected,locations,complete:catalogueComplete&&locationsComplete&&!failures.length,failures,started_at:started,as_of:new Date(now()).toISOString(),tag_convention:{predicate:requiredExactTag?'case-insensitive exact required product tag: '+requiredExactTag:config?'case-insensitive exact excluded product tags: '+config.excluded_tags.join(', '):'trimmed case-insensitive exact product tag made-to-order',observed_tags:[...tags].sort().map(([tag,product_count])=>({tag,product_count})),catalogue_complete:catalogueComplete},limits,request_count:requests};
}
const canonicalJson=value=>JSON.stringify((function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;})(value));
// Filter before constructing the workbook/package. Omitted rows are accounted for
// by aggregate scan evidence, not persisted a second time as full inventory.
export function compactInventoryReportEvidence(e){
  if(!e.inventory_report||e.selection_coverage)return e;
  const selection=inventoryVariantSelection(e),ids=new Set(selection.qualified.map(r=>r.v.id)),states={};
  for(const p of e.products)for(const v of p.variants)for(const l of v.locations)states[l.evidence_state]=(states[l.evidence_state]||0)+1;
  return{...e,products:e.products.map(p=>({...p,variants:p.variants.filter(v=>ids.has(v.id))})).filter(p=>p.variants.length),selection_coverage:{version:1,evaluated:selection.rows.length,qualified:selection.qualified.length,does_not_match:selection.rows.filter(r=>r.state==='does_not_match').length,unknown:selection.unknown_count,inventory_state_counts:states,scanned_inventory_sha256:createHash('sha256').update(canonicalJson(e.products)).digest('hex')}};
}
export function inventoryArtifactSize(a){
  const size=v=>Buffer.byteLength(JSON.stringify(v??null)),e=a.envelope||{},base64=a.xlsx_base64||'';
  return{serialized_package_bytes:size(a),storage_limit_bytes:INVENTORY_EXPORT_LIMITS.storage_bytes,workbook_bytes:Buffer.from(base64,'base64').length,xlsx_base64_bytes:Buffer.byteLength(base64),envelope_bytes:size(e),envelope_components:Object.fromEntries(Object.entries(e).map(([k,v])=>[k,size(v)])),other_package_bytes:size(Object.fromEntries(Object.entries(a).filter(([k])=>!['envelope','xlsx_base64'].includes(k))))};
}
export function inventoryWorkbookTables(e){
  const selection=inventoryVariantSelection(e);
  const qualified=selection?new Set(selection.qualified.map(r=>r.v.id)):null;
  const summary=[],detail=[];
  for(const p of e.products)for(const v of p.variants){
    if(qualified&&!qualified.has(v.id))continue;
    const base={Product:p.title,Status:p.status,'Product ID':p.id,'Variant ID':v.id,SKU:v.sku||'',Variant:v.title,Options:(v.selectedOptions||[]).map(o=>`${o.name}: ${o.value}`).join('; '),Tags:p.tags.join(', ')};
    const row={...base};let total=0,complete=e.complete;
    for(const l of v.locations){const key=`${l.location_name} [${l.location_id}]`;row[`Available: ${key}`]=l.available??l.evidence_state;if(typeof l.available==='number')total+=l.available;if(l.evidence_state!=='observed')complete=false;
      detail.push({...base,'Location ID':l.location_id,Location:l.location_name,Available:l.available,'On hand':l.on_hand,Committed:l.committed,'Evidence state':l.evidence_state,'Retrieved at (UTC)':l.observed_at,'Coverage failures':canonicalJson(e.failures.filter(f=>(!f.product_id||f.product_id===p.id)&&(!f.variant_id||f.variant_id===v.id)&&(!f.location_id||f.location_id===l.location_id)))});
    }
    row['Total available across active locations']=complete?total:null;row['Observed available subtotal']=v.locations.some(l=>l.available!==null)?total:null;row['Coverage']=complete?'complete':'partial / unknown';summary.push(row);
  }
  if(selection){summary.length=0;for(const r of selection.qualified){const row={Product:r.p.title,Status:r.p.status,'Product ID':r.p.id,'Variant ID':r.v.id,SKU:r.v.sku||'',Options:(r.v.selectedOptions||[]).map(o=>`${o.name}: ${o.value}`).join('; '),Tags:r.p.tags.join(', ')};for(const l of selection.groups.pos)row[`Available: ${l.name} [${l.id}]`]=r.v.locations.find(q=>q.location_id===l.id).available;row['Total POS available']=r.pos_total_available;const online=selection.groups.online[0];row[`Online RTS available: ${online.name} [${online.id}]`]=r.online_available;summary.push(row);}}
  return [['Inventory',summary],['Location quantities',detail],['Coverage',[
    {Field:'Complete coverage',Value:String(e.complete)},{Field:'Started at (UTC)',Value:e.started_at},{Field:'Finished at (UTC)',Value:e.as_of},{Field:'Eligibility',Value:(e.population?e.population.eligible_statuses.join(', '):'ACTIVE and DRAFT')+'; exclude ARCHIVED; '+e.tag_convention.predicate},
    {Field:'Quantity definition',Value:'Available, On hand and Committed are separate native quantities; never add them. Missing states are not zero. Totals require full observed coverage; observed subtotal is partial.'},
    ...(selection?[{Field:'Inventory filters',Value:canonicalJson(e.inventory_report)},{Field:'Resolved location groups',Value:canonicalJson(selection.groups)},{Field:'Variant selection coverage',Value:canonicalJson({evaluated:selection.evaluated_count??selection.rows.length,qualified:selection.qualified.length,unknown:selection.unknown_count})}]:[]),...(e.selection_coverage?[{Field:'Retention scope',Value:'Full quantities are retained for qualifying variants only. Omitted nonmatching/unknown variants are represented by scan counts, state counts, fingerprint and coverage failures; no omitted quantity is treated as zero.'},{Field:'Retained selection evidence',Value:canonicalJson(e.selection_coverage)}]:[]),{Field:'Export limits',Value:canonicalJson(e.limits)},...e.failures.map(f=>({Field:'Coverage failure',Value:canonicalJson(f)})),...e.tag_convention.observed_tags.map(t=>({Field:'Observed product tag',Value:canonicalJson(t)}))
  ]],...(selection&&!e.selection_coverage?[['Variant selection',selection.rows.map(r=>({'Product ID':r.p.id,'Variant ID':r.v.id,Selection:r.state,'Total POS available':r.pos_total_available,'Online RTS available':r.online_available}))]]:[]),...(e.population?[['Product eligibility',e.population.audit.map(p=>({'Product ID':p.product_id,Status:p.status,Eligible:p.eligible?'yes':'no','Exclusion reason':p.exclusion||''}))]]:[])];
}
const workbookKeys=(name,rows,e)=>rows.length?[...new Set(rows.flatMap(Object.keys))]:name==='Inventory'&&e?.inventory_report?['Product','Status','Product ID','Variant ID','SKU','Options','Tags',...inventoryVariantSelection(e).groups.pos.map(l=>`Available: ${l.name} [${l.id}]`),'Total POS available',...inventoryVariantSelection(e).groups.online.map(l=>`Online RTS available: ${l.name} [${l.id}]`)]:name==='Variant selection'?['Product ID','Variant ID','Selection','Total POS available','Online RTS available']:name==='Inventory'?['Product','Status','Product ID','Variant ID','SKU','Variant','Options','Tags','Total available across active locations','Coverage']:name==='Product eligibility'?['Product ID','Status','Eligible','Exclusion reason']:['Product ID','Variant ID','Location ID','Available','On hand','Committed','Evidence state','Retrieved at (UTC)','Coverage failures'];
export async function inventoryReportWorkbook(e){const wb=new ExcelJS.Workbook();for(const [name,rows] of inventoryWorkbookTables(e)){const s=wb.addWorksheet(name),keys=workbookKeys(name,rows,e);if(keys.length>INVENTORY_EXPORT_LIMITS.max_columns)throw fail('INVENTORY_EXPORT_COLUMN_LIMIT');if([...keys,...rows.flatMap(Object.values)].some(v=>typeof v==='string'&&v.length>INVENTORY_EXPORT_LIMITS.max_cell_characters))throw fail('INVENTORY_EXPORT_CELL_LIMIT');s.columns=keys.map(key=>({header:key,key,width:26}));rows.forEach(r=>s.addRow(r));s.getRow(1).font={bold:true};s.views=[{state:'frozen',ySplit:1}];}return Buffer.from(await wb.xlsx.writeBuffer());}
// BigQuery JSON storage does not preserve object-member order. Only cells
// deliberately containing JSON metadata compare parsed JSON semantics; numeric
// quantities, identities, statuses, headers and array order remain strict.
export function inventoryJsonMetadataCell(sheet,key,row){return sheet==='Location quantities'&&key==='Coverage failures'||sheet==='Coverage'&&key==='Value'&&['Export limits','Coverage failure','Observed product tag','Inventory filters','Resolved location groups','Variant selection coverage','Retained selection evidence'].includes(row.Field);}
export function inventoryMetadataEqual(actual,expected){try{return typeof actual==='string'&&typeof expected==='string'&&canonicalJson(JSON.parse(actual))===canonicalJson(JSON.parse(expected));}catch{return false;}}
export async function assertInventoryArtifact(a){
  if(a.envelope?.inventory_report&&inventoryReportConfigKey(a.analysis_context?.inventory_report||filteredInventoryScope(a.request)?.inventory_report)!==inventoryReportConfigKey(a.envelope.inventory_report))throw Object.assign(fail('EVIDENCE_SCOPE_MISMATCH'),{failed_stage:'evidence_validation'});
  const reject=(reason,detail={})=>{throw Object.assign(fail('EXPORT_INTEGRITY_FAILED'),{integrity:{reason,...detail}});};
  if(a.envelope?.selection_coverage){
    const e=a.envelope,c=e.selection_coverage,selection=inventoryVariantSelection(e);
    if(!selection||c.version!==1||['evaluated','qualified','does_not_match','unknown'].some(k=>!Number.isSafeInteger(c[k])||c[k]<0)||c.evaluated!==c.qualified+c.does_not_match+c.unknown||c.qualified!==selection.rows.length||selection.qualified.length!==selection.rows.length||!/^[a-f0-9]{64}$/.test(c.scanned_inventory_sha256||'')||!c.inventory_state_counts||Object.values(c.inventory_state_counts).some(n=>!Number.isSafeInteger(n)||n<0)||Object.values(c.inventory_state_counts).reduce((n,v)=>n+v,0)!==c.evaluated*e.locations.length)reject('selection_coverage');
    for(const p of e.products)if(!e.inventory_report.statuses.includes(p.status)||p.tags.some(t=>e.inventory_report.excluded_tags.includes(t.trim().toLowerCase())))reject('product_eligibility');
    if(new Set(selection.rows.map(r=>r.v.id)).size!==selection.rows.length)reject('duplicate_variant');
  }
  const bytes=Buffer.from(a.xlsx_base64||'','base64');if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)reject('sha256');
  const wb=new ExcelJS.Workbook();try{await wb.xlsx.load(bytes);}catch{reject('invalid_workbook');}
  const tables=inventoryWorkbookTables(a.envelope);if(wb.worksheets.length!==tables.length)reject('sheet_count');
  for(const [name,rows] of tables){
    const s=wb.getWorksheet(name),keys=workbookKeys(name,rows,a.envelope);
    if(!s||s.rowCount!==Math.max(1,rows.length+1)||s.columnCount!==keys.length)reject('shape',{sheet:name});
    if(keys.some((key,i)=>s.getRow(1).getCell(i+1).value!==key))reject('headers',{sheet:name});
    for(const [i,row] of rows.entries())for(const [j,key] of keys.entries()){
      const actual=s.getRow(i+2).getCell(j+1).value??null,expected=row[key]??null;
      if(actual!==expected&&!(inventoryJsonMetadataCell(name,key,row)&&inventoryMetadataEqual(actual,expected)))reject('cell',{sheet:name,row:i+2,column:j+1});
    }
  }
}
export const inventoryReportRowCount=e=>inventoryVariantSelection(e)?.qualified.length??e.products.reduce((n,p)=>n+p.variants.length,0);
export function inventoryReportAnswer(e){const selection=inventoryVariantSelection(e);if(selection)return `Inventory export: ${selection.qualified.length} qualifying variants; ${selection.unknown_count} variants excluded because required Available quantities are unknown. Filters: ${inventoryReportScopeLabel(e.inventory_report).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}. ${e.complete?'Coverage complete.':'Coverage incomplete; see Coverage sheet.'} All requested location quantities must be known numeric values; zero and negatives are retained. Sorted by total POS ${e.inventory_report.sort.direction}.`;return `Inventory export: ${e.products.length} eligible products (${(e.population?.eligible_statuses||['ACTIVE','DRAFT']).join('/')}) at ${e.locations.length} active locations. ${e.complete?'Coverage complete.':'Coverage incomplete; see Coverage sheet.'} Product eligibility uses tags. Available, On hand and Committed remain separate. Retrieved ${e.started_at} to ${e.as_of} (UTC). Export limits: ${JSON.stringify(e.limits)}.`;}
export function createInventoryReportService({graphql,getToken,artifactStore,now=Date.now}){
  return async(message,options={})=>{
    if(options.analysisContext?.stock_scope)return null;
    const scope=inventoryReportScope(message);if(!scope&&!isInventoryReportContext(options.analysisContext))return null;
    const entityQuery=options.analysisContext?.entity_query||scope?.entity_query;
    const config=validateInventoryReportConfig(options.analysisContext?.inventory_report||scope?.inventory_report);
    if(scope?.inventory_report&&config&&inventoryReportConfigKey(scope.inventory_report)!==inventoryReportConfigKey(config))throw fail('EVIDENCE_SCOPE_MISMATCH');
    const {exportOwner,requestId,downloadBase='/api/oracle/exports'}=options;if(!exportOwner||!requestId)throw fail('EXPORT_OWNER_REQUIRED');
    const stage=async(name,work)=>{const started=now();options.onProviderStage?.({stage:name,status:'started'});try{const value=await work();options.onProviderStage?.({stage:name,status:'success',elapsed_ms:now()-started});return value;}catch(error){const diagnostic=inventoryDiagnostic(error,name);options.onProviderStage?.({...diagnostic,status:'failed',elapsed_ms:now()-started,...(error.integrity?{integrity:error.integrity}:{})});error.failed_stage??=name;throw error;}};
    const id=priorityArtifactId(exportOwner,requestId),existing=await stage('inventory_export_lookup',()=>artifactStore.get(id,exportOwner));
    let a=existing;if(a){if(a.request!==message||a.envelope.kind!=='inventory_report'||a.envelope.entity_query!==entityQuery||inventoryReportConfigKey(a.envelope.inventory_report)!==inventoryReportConfigKey(config))throw fail('EXPORT_REQUEST_ID_CONFLICT');await stage('inventory_export_validation',()=>assertInventoryArtifact(a));}else{
      const e=await stage('inventory_shopify_reads',()=>readInventoryReport({graphql,getToken,now,signal:options.signal,deadlineAt:options.deadlineAt,entityQuery,reportConfig:config}));options.onProviderStage?.({stage:'inventory_coverage',complete:e.complete,products:e.products.length,variants:e.products.reduce((n,p)=>n+p.variants.length,0),locations:e.locations.length,request_count:e.request_count,failure_count:e.failures.length,failure_codes:[...new Set(e.failures.map(f=>f.code))]});const compact=await stage('inventory_selection_projection',()=>compactInventoryReportEvidence(e));options.onProviderStage?.({stage:'inventory_evidence_size',scanned_envelope_bytes:Buffer.byteLength(JSON.stringify(e)),retained_envelope_bytes:Buffer.byteLength(JSON.stringify(compact)),scanned_variants:e.products.reduce((n,p)=>n+p.variants.length,0),retained_variants:inventoryReportRowCount(compact)});const bytes=await stage('inventory_workbook_generation',()=>inventoryReportWorkbook(compact));
      a={request:message,...(config?{analysis_context:{requested_subject:'current_stock',tool_route:'get_shopify_inventory_by_location',entity_query:entityQuery,inventory_report:config,output_preference:'xlsx',requested_formats:['xlsx']}}:{}),envelope:compact,filename:'oracle-inventory.xlsx',answer:inventoryReportAnswer(compact),sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')};
      await stage('inventory_export_size',()=>{const measurement=inventoryArtifactSize(a);options.onProviderStage?.({stage:'inventory_export_components',...measurement});if(measurement.serialized_package_bytes>INVENTORY_EXPORT_LIMITS.storage_bytes)throw Object.assign(fail('EXPORT_STORAGE_SIZE_EXCEEDED'),{size_diagnostic:measurement});});
      options.signal?.throwIfAborted();await stage('inventory_export_persistence',()=>artifactStore.put(id,exportOwner,a));a=await stage('inventory_export_verification',async()=>{const saved=await artifactStore.get(id,exportOwner);if(!saved)throw fail('EXPORT_PERSISTENCE_FAILED');await assertInventoryArtifact(saved);return saved;});
    }
    const result={answer:a.answer,tools:['get_shopify_inventory_by_location'],partial:!a.envelope.complete,evidence:a.envelope,artifact:{id,filename:a.filename,row_count:inventoryReportRowCount(a.envelope),download_url:`${downloadBase}/${id}`}};await stage('inventory_evidence_delivery',()=>options.onEvidence?.(result));return result;
  };
}
