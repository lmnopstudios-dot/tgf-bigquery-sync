import ExcelJS from 'exceljs';
import { bigQueryErrorDiagnostic } from './analysis-jobs.js';
import { priorityArtifactId } from './product-priority-storage.js';
import { createHash } from 'node:crypto';

export const PRIORITY_COLUMNS = ['Priority','Product','Product link','Work needed','Status'];
export const PRIORITY_METHOD = Object.freeze({version:1,weights:{sales:0.5,traffic:0.3,organic:0.2},sales:'Mean percentile of observed product sales ranks within each currency; currencies are never added.',traffic:'Percentile of observed landing sessions.',organic:'Percentile of impressions minus clicks (uncaptured search exposure, not a conversion diagnosis).',missing:'Unmatched/unavailable components contribute zero without renormalizing weights; explicit observed zeros remain observed. No evidence means unranked, not zero impact.',ties:'Score descending, then numeric Shopify product ID ascending. Unranked products follow ranked products with blank Priority.',provisional:'Any missing source, unmatched component, incomplete source coverage or incomplete catalogue makes the ranking provisional; no observed usable evidence makes ranking unavailable.'});

export function isProductPriorityRequest(message){
  const text=String(message||'');
  return /\bproducts?\b/i.test(text)&&(/\b(?:export|download)\b/i.test(text)&&/\b(?:priority|photograph(?:y|s)?|product[ -]page|improvements?)\b/i.test(text)||/\bpriority\b/i.test(text)&&/\b(?:photography|product[ -]page)\b/i.test(text));
}
export function priorityDates(now=Date.now()){
  // Completed business days, using the UI/reporting timezone rather than host time.
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const end=new Date(`${today}T00:00:00Z`);end.setUTCDate(end.getUTCDate()-1);
  const start=new Date(end);start.setUTCDate(start.getUTCDate()-89);
  return {start_date:start.toISOString().slice(0,10),end_date:end.toISOString().slice(0,10),timezone:'Europe/London',completed_days:90};
}
export function shopifyProductId(value){const match=String(value||'').match(/^(?:gid:\/\/shopify\/Product\/)?([1-9]\d*)$/);return match?.[1]||null;}
export function canonicalProductUrl(value){
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!/^\/products\/[^/]+\/?$/.test(u.pathname))return null;u.search='';u.hash='';u.pathname=u.pathname.replace(/\/$/,'');return u.href;}catch{return null;}
}
export const PUBLISHED_PRODUCTS_QUERY=`query OraclePublishedProducts($cursor:String){products(first:100,after:$cursor,sortKey:ID){nodes{id title status publishedAt onlineStoreUrl seo{description}} pageInfo{hasNextPage endCursor}}}`;
export async function fetchPublishedProducts(graphql,{signal}={}){
  const products=new Map(),seen=new Set();let cursor=null,pages=0;
  try{do{
    signal?.throwIfAborted();
    const data=await graphql(PUBLISHED_PRODUCTS_QUERY,{cursor},{signal});const connection=data?.products;
    if(!Array.isArray(connection?.nodes)||typeof connection?.pageInfo?.hasNextPage!=='boolean')throw Object.assign(new Error('Invalid catalogue page'),{code:'CATALOGUE_PAGE_INVALID'});
    pages++;
    for(const p of connection.nodes){
      // ACTIVE/UNLISTED alone is insufficient. publishedAt is Online Store publication,
      // and onlineStoreUrl is null for products not published to Online Store.
      if(!['ACTIVE','UNLISTED'].includes(p.status)||!p.publishedAt||!p.onlineStoreUrl)continue;
      const id=shopifyProductId(p.id),url=canonicalProductUrl(p.onlineStoreUrl);
      if(!id||!url||typeof p.title!=='string')throw Object.assign(new Error('Invalid published product'),{code:'CATALOGUE_PRODUCT_INVALID'});
      const row={product_id:id,title:p.title,url,meta_description:typeof p.seo?.description==='string'?p.seo.description:null,meta_description_verified:typeof p.seo?.description==='string'};
      if(products.has(id)&&JSON.stringify(products.get(id))!==JSON.stringify(row))throw Object.assign(new Error('Conflicting product'),{code:'CATALOGUE_PRODUCT_CONFLICT'});
      products.set(id,row);
    }
    if(!connection.pageInfo.hasNextPage)break;
    const next=connection.pageInfo.endCursor;if(!next||seen.has(next))throw Object.assign(new Error('Pagination stalled'),{code:'CATALOGUE_PAGINATION_STALLED'});
    seen.add(next);cursor=next;
  }while(true);
  return {products:[...products.values()],complete:true,pages,publication_contract:'ACTIVE/UNLISTED + publishedAt + non-null onlineStoreUrl (Online Store publication; not inventory availability)'};
  }catch(error){if(signal?.aborted)throw error;return{products:[...products.values()],complete:false,pages,error_code:code(error),...bigQueryErrorDiagnostic(error),...(Number.isInteger(error.status)?{status:error.status}:{}),publication_contract:'ACTIVE/UNLISTED + publishedAt + non-null onlineStoreUrl'};}
}
const code=error=>/^[A-Z0-9_]{1,64}$/.test(String(error?.code||''))?String(error.code):'SOURCE_FAILED';
const numeric=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
const idOrder=(a,b)=>BigInt(a.product_id)<BigInt(b.product_id)?-1:BigInt(a.product_id)>BigInt(b.product_id)?1:0;
function percentiles(values){const sorted=[...values].sort((a,b)=>a[1]-b[1]);return new Map(sorted.map(([id,value])=>[id,sorted.length===1?(value>0?1:0):sorted.filter(x=>x[1]<value).length/(sorted.length-1)]));}
function urlForEvidence(value,origins){
  if(String(value||'').startsWith('/')&&!String(value).startsWith('//')){if(origins.size!==1)return null;return canonicalProductUrl(`${[...origins][0]}${value}`);}
  return canonicalProductUrl(value);
}
export function rankProducts(catalogue,sources){
  const products=catalogue.products,byId=new Map(products.map(p=>[p.product_id,p])),urls=new Map(),origins=new Set(products.map(p=>new URL(p.url).origin));
  for(const p of products){if(urls.has(p.url))urls.set(p.url,null);else urls.set(p.url,p.product_id);}
  const sales=new Map(),history=new Map(),traffic=new Map(),organic=new Map();
  for(const row of sources.sales?.rows||[]){const id=shopifyProductId(row.product_id),value=numeric(row.sales),currency=String(row.currency||'');if(!byId.has(id)||!/^([A-Z]{3})$/.test(currency)||value===null)continue;const map=(row.evidence_window||row.window)==='history'?history:sales;const item=map.get(id)||{};item[currency]=(item[currency]??0)+value;map.set(id,item);}
  for(const [name,map,fields] of [['traffic',traffic,['sessions']],['organic',organic,['impressions','clicks']]])for(const row of sources[name]?.rows||[]){const url=urlForEvidence(row.url||row.landing_path||row.page,origins),id=urls.get(url);if(!id)continue;const values=fields.map(field=>numeric(row[field]));if(values.some(value=>value===null||value<0))continue;const item=map.get(id)||Object.fromEntries(fields.map(field=>[field,0]));fields.forEach((field,index)=>item[field]+=values[index]);map.set(id,item);}
  const salesRanks=new Map();
  for(const currency of new Set([...sales.values()].flatMap(Object.keys))){for(const [id,rank] of percentiles([...sales].filter(([,values])=>currency in values).map(([id,values])=>[id,values[currency]]))){const values=salesRanks.get(id)||[];values.push(rank);salesRanks.set(id,values);}}
  const trafficRanks=percentiles([...traffic].map(([id,value])=>[id,value.sessions])),organicRanks=percentiles([...organic].map(([id,value])=>[id,Math.max(0,value.impressions-value.clicks)]));
  const rows=products.map(p=>{
    const components={sales:salesRanks.has(p.product_id)?salesRanks.get(p.product_id).reduce((a,b)=>a+b,0)/salesRanks.get(p.product_id).length:null,traffic:trafficRanks.get(p.product_id)??null,organic:organicRanks.get(p.product_id)??null};
    const observed=Object.values(components).some(value=>value!==null),score=observed?Object.entries(components).reduce((total,[key,value])=>total+(value??0)*PRIORITY_METHOD.weights[key],0):null;
    const work=['Review photography'];if(p.meta_description_verified&&!p.meta_description.trim())work.push('Write a meta description (Shopify SEO description is empty)');else work.push('Review product-page content');
    return {...p,score,components,evidence:{sales:sales.get(p.product_id)??null,supporting_sales:history.get(p.product_id)??null,traffic:traffic.get(p.product_id)??null,organic:organic.get(p.product_id)??null},evidence_state:Object.fromEntries(Object.keys(components).map(key=>[key,sources[key]?.status!=='available'?'unavailable':components[key]===null?'unmatched':key==='sales'?Object.values(sales.get(p.product_id)).every(value=>value===0)?'observed_zero':'observed':key==='traffic'?traffic.get(p.product_id).sessions===0?'observed_zero':'observed':organic.get(p.product_id).impressions===0?'observed_zero':'observed'])),work_needed:work.join('; '),status:'To do'};
  }).sort((a,b)=>(a.score===null)-(b.score===null)||(b.score??0)-(a.score??0)||idOrder(a,b));
  let priority=0;for(const row of rows)row.priority=row.score===null?null:++priority;
  const unavailable=rows.every(row=>row.score===null),provisional=!catalogue.complete||Object.values(sources).some(source=>source.status!=='available'||!source.complete)||rows.some(row=>Object.values(row.components).some(value=>value===null));
  return {rows,ranking_status:unavailable?'unavailable':provisional?'provisional':'available'};
}
export async function priorityWorkbook(envelope){
  const workbook=new ExcelJS.Workbook();workbook.creator='Oracle';workbook.created=new Date(envelope.generated_at);workbook.modified=new Date(envelope.generated_at);
  const sheet=workbook.addWorksheet(envelope.manifest?.complete_catalogue===false?'Priorities - incomplete':envelope.ranking_status==='unavailable'?'Priorities - unranked':envelope.ranking_status==='provisional'?'Priorities - provisional':'Product priorities');sheet.columns=PRIORITY_COLUMNS.map((header,index)=>({header,width:[12,48,65,80,20][index]}));
  for(const row of envelope.rows){const added=sheet.addRow([row.priority,row.title,{text:row.url,hyperlink:row.url},row.work_needed,'To do']);added.getCell(3).font={color:{argb:'FF0563C1'},underline:true};added.getCell(5).dataValidation={type:'list',allowBlank:false,formulae:['"To do,In progress,Done,Blocked"'],showErrorMessage:true,errorStyle:'stop',errorTitle:'Choose a status',error:'Use a status from the list.'};added.alignment={vertical:'top',wrapText:true};}
  sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:'A1',to:`E${Math.max(1,sheet.rowCount)}`};
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export function createProductPriorityService({graphql,loadSources,artifactStore,now=()=>Date.now()}){
  const inFlight=new Map();
  return async(message,{analysisContext,exportOwner,requestId,downloadBase='/api/oracle/exports',signal,onProviderStage}={})=>{
    if(!isProductPriorityRequest(message)&&analysisContext?.tool_route!=='export_product_priorities')return null;
    if(!exportOwner||!requestId)throw Object.assign(new Error('Authenticated export owner required'),{code:'EXPORT_OWNER_REQUIRED',failed_stage:'export_authorization'});
    const artifactId=priorityArtifactId(exportOwner,requestId);
    const deliver=artifact=>({answer:artifact.answer,tools:['export_product_priorities'],evidence:artifact.envelope,artifact:{id:artifactId,filename:artifact.filename,row_count:artifact.envelope.rows.length,download_url:`${downloadBase}/${artifactId}`}});
    const stage=async(name,action)=>{onProviderStage?.({stage:name,status:'started'});try{const result=await action();onProviderStage?.({stage:name,status:'success'});return result;}catch(error){const diagnostic=bigQueryErrorDiagnostic(error);onProviderStage?.({stage:name,status:'failed',code:code(error),reason:diagnostic.reason,...(diagnostic.location?{location:diagnostic.location}:{})});throw Object.assign(error,{failed_stage:error.failed_stage||name});}};
    const existing=await stage('export_storage',()=>artifactStore.get(artifactId,exportOwner)).catch(error=>{throw Object.assign(new Error('Durable export storage unavailable'),{...bigQueryErrorDiagnostic(error),code:'EXPORT_STORAGE_UNAVAILABLE',failed_stage:'export_storage'});});if(existing){if(existing.request!==message)throw Object.assign(new Error('Request ID conflict'),{code:'EXPORT_REQUEST_ID_CONFLICT'});return deliver(existing);}
    if(inFlight.has(artifactId)){const result=await inFlight.get(artifactId);const saved=await artifactStore.get(artifactId,exportOwner);if(saved.request!==message)throw Object.assign(new Error('Request ID conflict'),{code:'EXPORT_REQUEST_ID_CONFLICT'});return result;}
    const work=(async()=>{
      const dates={...priorityDates(now()),...(analysisContext?.tool_route==='export_product_priorities'&&analysisContext.start_date&&analysisContext.end_date?{start_date:analysisContext.start_date,end_date:analysisContext.end_date}:{})};
      const catalogue=await stage('priority_catalogue',()=>fetchPublishedProducts(graphql,{signal}));
      if(!catalogue.complete&&!catalogue.products.length)throw Object.assign(new Error('Catalogue unavailable; no export created'),{code:'CATALOGUE_UNAVAILABLE',failed_stage:'priority_catalogue',reason:catalogue.reason,...(catalogue.status?{status:catalogue.status}:{}),provider_code:catalogue.error_code});
      onProviderStage?.({stage:'priority_catalogue',status:catalogue.complete?'complete':'incomplete',...(catalogue.error_code?{code:catalogue.error_code,reason:catalogue.reason}:{}),...(catalogue.status?{status:catalogue.status}:{})});
      const sources=await stage('priority_enrichment',()=>loadSources(dates,{signal,onProviderStage}));const ranked=await stage('priority_ranking',()=>rankProducts(catalogue,sources));
      const availability=Object.fromEntries(Object.entries(sources).map(([key,{rows,...details}])=>[key,{...details,row_count:rows?.length||0,matched_product_count:ranked.rows.filter(row=>row.components[key]!==null).length,unmatched_product_count:ranked.rows.filter(row=>row.components[key]===null).length}]));
      const envelope={kind:'product_priority_export',subject:'product_priority',metrics:['products'],generated_at:new Date(now()).toISOString(),applied_dates:dates,periods:[dates],catalogue:{...catalogue,products:undefined},ranking_method:PRIORITY_METHOD,ranking_status:ranked.ranking_status,evidence_availability:availability,rows:ranked.rows,manifest:{version:1,row_count:ranked.rows.length,complete_catalogue:catalogue.complete,artifact_reference:artifactId,worksheet_count:1,columns:PRIORITY_COLUMNS}};
      const limitations=Object.entries(availability).map(([name,source])=>`${name}: ${source.status} (${source.matched_product_count} matched products, ${source.unmatched_product_count} unmatched)${source.complete?'':'; coverage incomplete or unverified'}${source.error_code?` (${source.error_code})`:''}`).join('; ');
      const answer=`${catalogue.complete?'All current Online Store published Shopify products':'INCOMPLETE catalogue — only retrieved published Shopify products'}: ${ranked.rows.length} rows. Ranking ${ranked.ranking_status}. Applied evidence dates: ${dates.start_date} to ${dates.end_date} (${dates.timezone}; 90 completed days). ${limitations}. Missing/unmatched evidence is not zero; unranked products have blank Priority. Sales ranks stay within currency (50%); landing traffic (30%); uncaptured organic impressions (20%). Ties use Shopify product ID. Review photography is a review task; image quality and purchase journeys were not assessed. Download the staff worksheet below.`;
      const buffer=await stage('priority_workbook',()=>priorityWorkbook(envelope));const artifact={request:message,answer,envelope,filename:`oracle-product-priorities${!catalogue.complete?'-incomplete':ranked.ranking_status==='available'?'':`-${ranked.ranking_status}`}.xlsx`,sha256:createHash('sha256').update(buffer).digest('hex'),xlsx_base64:buffer.toString('base64')};
      signal?.throwIfAborted();await stage('export_persistence',()=>artifactStore.put(artifactId,exportOwner,artifact)).catch(error=>{if(error.code==='EXPORT_STORAGE_SIZE_EXCEEDED')throw error;throw Object.assign(new Error('Export persistence failed'),{...bigQueryErrorDiagnostic(error),code:'EXPORT_PERSISTENCE_FAILED',failed_stage:'export_persistence'});});const saved=await stage('export_verification',()=>artifactStore.get(artifactId,exportOwner));if(!saved)throw Object.assign(new Error('Artifact not persisted'),{code:'EXPORT_PERSISTENCE_FAILED',failed_stage:'export_persistence'});
      onProviderStage?.({stage:'priority_delivery',status:'persisted'});return deliver(saved);
    })();inFlight.set(artifactId,work);try{return await work;}finally{inFlight.delete(artifactId);}
  };
}
