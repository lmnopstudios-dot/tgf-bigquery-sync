import {parseCurrentStock} from './current-stock-scope.js';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from './product-priority-storage.js';
import {inventoryReportWorkbook,assertInventoryArtifact,INVENTORY_EXPORT_LIMITS} from './inventory-report.js';
import {inventoryReportScope,createInventoryReportService,inventoryReportAnswer,isInventoryReportContext} from './inventory-report.js';
import {classificationReaderCtes} from './classification-reader.js';
import {createInventoryReadBudget,inventoryDiagnostic} from '../shopify/inventory-budget.js';
import {createBatchedInventoryByLocation,inventoryLocationSelector,inventoryLocationSelectorForRequest} from '../shopify/inventory-by-location.js';

export function currentStockScope(message) {
  const named=parseCurrentStock(message);
  if(named&&!/^(?:all|every|entire|everything|active and draft products)\b/i.test(named.entity_query))return named;
  return inventoryReportScope(message)||named;
}

export const STOCK_RESOLUTION_QUERY=`query StockProductResolution($query:String!,$cursor:String){products(first:25,query:$query,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title handle status}}}`;
const words=text=>text.toLowerCase().normalize('NFKC').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean).map(w=>w.length>3?w.replace(/s$/,''):w);
const esc=value=>String(value??'Unavailable').replace(/[\r\n]/g,' ').replaceAll('|','\|').replaceAll('<','&lt;').replaceAll('>','&gt;');
const number=value=>typeof value==='number'?String(value):'Unavailable';

export function stockAnswer(evidence) {
  if(evidence.kind==='inventory_report')return inventoryReportAnswer(evidence);
  if(evidence.resolution?.method==='product_not_resolved')return `No catalogue product was resolved for **${esc(evidence.entity_query)}**. Please check the name or provide a product link. Inventory has not been read.`;
  if(evidence.ambiguous)return `Which product group do you mean by **${esc(evidence.entity_query)}**? Please give a more specific catalogue title or product group.\n\n${(evidence.candidates||[]).slice(0,8).map((p,i)=>`${i+1}. ${esc(p.title)}`).join('\n')}`;
  const rows=evidence.products.flatMap(p=>p.variants.flatMap(v=>v.locations.map(l=>({p,v,l}))));
  const observed=rows.filter(r=>r.l.evidence_state==='observed'),short=observed.filter(r=>r.l.available<=0);
  const total=observed.reduce((n,r)=>n+r.l.available,0);
  const untracked=rows.length&&rows.every(r=>r.v.inventory_tracked===false);
  const lines=[untracked?`Inventory for **${esc(evidence.entity_query)}** is untracked; physical stock counts are unavailable.`:observed.length?`**${esc(evidence.entity_query)}:** ${total} available units across ${observed.length} observed variant/location rows${evidence.complete?'':'; coverage is partial'}.`:`Current stock for **${esc(evidence.entity_query)}** is ${evidence.availability==='failed'?'unavailable because retrieval failed':'unavailable'}. Missing inventory is not zero.`];
  if(evidence.resolution?.method==='catalogue_title_candidates')lines.push('Scope: matching catalogue product titles; this is not a verified governed product group.');
  if(short.length)lines.push(`**Shortages:** ${short.length} observed variant/location rows have zero or negative available stock.`);
  if(!evidence.complete)lines.push('**Incomplete coverage:** failed or missing locations/variants remain unavailable; totals include only observed available quantities.');
  const times=observed.map(r=>r.l.observed_at).filter(Boolean).sort();
  if(times.length){lines.push(`Observed (UTC): ${times[0]}${times.at(-1)!==times[0]?` to ${times.at(-1)}`:''}.`);if(Date.now()-Date.parse(times[0])>15*60_000)lines.push('**Stale evidence:** these saved observations are over 15 minutes old; current stock has not been re-read.');}
  const displayCount=evidence.stock_scope?.layout==='matrix'?evidence.products.reduce((n,p)=>n+p.variants.length,0):rows.length;
  if(displayCount>60)lines.push(`Showing 60 of ${displayCount} ${evidence.stock_scope?.layout==='matrix'?'variants':'variant/location rows'}; remaining rows are in Show details. Shortage and partial-coverage counts cover all returned rows.`);
  const primaryRows=[...rows].sort((a,b)=>Number(a.l.available>0)-Number(b.l.available>0)).slice(0,60);
  if(rows.length&&evidence.stock_scope?.layout==='matrix'){
    const locations=evidence.location_coverage.resolved;
    const variants=evidence.products.flatMap(p=>p.variants.map(v=>({p,v})));
    lines.push(['| Product | Variant / SKU | '+locations.map(l=>esc(l.name)).join(' | ')+' |','|---|---|'+locations.map(()=>'---:|').join(''),...variants.slice(0,60).map(({p,v})=>'| '+esc(p.title)+' | '+esc(v.title)+' / '+esc(v.sku||'—')+' | '+locations.map(l=>number(v.locations.find(q=>q.location_id===l.id)?.available)).join(' | ')+' |')].join('\n'));
  }else {
  if(rows.length)lines.push(['| Product | Variant / SKU | Location | Available | On hand | Committed | Stock status | Observed (UTC) |','|---|---|---|---:|---:|---:|---|---|',...primaryRows.map(({p,v,l})=>`| ${esc(p.title)} | ${esc(v.title)} / ${esc(v.sku||'—')} | ${esc(l.location_name)} | ${number(l.available)} | ${number(l.on_hand)} | ${number(l.committed)} | ${v.inventory_tracked===false?'Untracked':v.inventory_tracked==null?'Tracking unverified':'Tracked'}${p.is_made_to_order?'; Made to order':''}${v.inventoryPolicy==='CONTINUE'?'; Continue selling / backorder allowed':''}${v.availableForSale===true?'; Purchasable':v.availableForSale===false?'; Not purchasable':''} | ${esc(l.observed_at||'Unobserved')} |`)].join('\n'));
  }
  if(rows.some(r=>r.p.is_made_to_order||r.v.inventoryPolicy==='CONTINUE'||r.v.inventory_tracked===false))lines.push('Purchasability, untracked inventory and continue-selling policy do not establish ready-to-ship stock.');
  const details={...(rows.length>60?{all_rows:rows.map(({p,v,l})=>({product:p.title,variant:v.title,sku:v.sku,...l}))}:{}),resolution:evidence.resolution,source:evidence.source,location_coverage:evidence.location_coverage,source_ids:evidence.products.map(p=>({product_id:p.id,variants:p.variants.map(v=>({variant_id:v.id,inventory_item_id:v.inventory_item_id,tracked:v.inventory_tracked,inventory_policy:v.inventoryPolicy}))})),failures:evidence.failures,diagnostics:evidence.diagnostics};
  lines.push(`<details>\n<summary>Show details</summary>\n\nLive Shopify Admin observations; each row shows its actual retrieval time. Available, on-hand and committed are separate native quantities and are never added together. Available is Shopify's sellable quantity, not a verified shipping promise. Finished-product inventory does not establish production capacity or component/stone availability. Missing levels do not establish zero.\n\n\`\`\`json\n${JSON.stringify(details,null,2).replaceAll('`','\\u0060')}\n\`\`\`\n\n</details>`);
  return lines.join('\n\n');
}

// Reads existing structured classifications only. Never invokes classification sync/setup.
export function createStockGroupLookup({bigquery,project}) {
  if(!/^[A-Za-z0-9_-]+$/.test(project))throw new Error('Invalid project');
  return async(entity,{signal}={})=>{
    if(signal?.aborted)throw Object.assign(new Error('Cancelled'),{code:'REQUEST_CANCELLED'});
    const group=entity.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    const [rows]=await bigquery.query({query:`WITH ${classificationReaderCtes(project)} SELECT DISTINCT subject_ref,classification_value FROM cr_resolved
      WHERE classification_type='product_group' AND classification_value IN UNNEST(@groups)
      AND STARTS_WITH(subject_ref,'shopify:shopify:') LIMIT 26`,params:{groups:[group,group.replace(/s$/,'')]},useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'5000',labels:{component:'oracle_current_stock',operation:'group_resolution'}});
    return rows;
  };
}

export function createCurrentStockService({graphql,getToken,lookupGroup=null,locationSelector=inventoryLocationSelector(),now=Date.now,log=()=>{},artifactStore}) {
  const inventoryReport=artifactStore?createInventoryReportService({graphql,getToken,artifactStore,now}):null;
  return async(message,options={})=>{
    const scope=options.analysisContext?.requested_subject==='current_stock'?{entity_query:options.analysisContext.entity_query,location:options.analysisContext.location,all_locations:options.analysisContext.location==null,stock_scope:options.analysisContext.stock_scope}:currentStockScope(message);
    const report=scope?.stock_scope?null:await inventoryReport?.(message,options);if(report)return report;
    if(!scope?.stock_scope&&(inventoryReportScope(message)||isInventoryReportContext(options.analysisContext)))throw Object.assign(new Error('Inventory export storage unavailable'),{code:'EXPORT_STORAGE_UNAVAILABLE'});
    if(!scope)return null;
    if(scope.stock_scope?.format==='xlsx'&&!artifactStore)throw Object.assign(new Error('Export storage unavailable'),{code:'EXPORT_STORAGE_UNAVAILABLE'});
    const deadlineAt=Math.min(options.deadlineAt??Infinity,now()+45_000),budget=createInventoryReadBudget({deadlineAt,signal:options.signal,maxRequests:4,now});
    let resolvedToken;
    let resolution={method:'unresolved',product_ids:[]},candidates=[],result,ambiguity=false;
    try{
      let group=[];
      const selected=options.analysisContext?.pending_product_candidates?.find(c=>c.product_ref===options.analysisContext.product_ref);
      if(selected)group=[{subject_ref:selected.product_ref,classification_value:null}];
      if(lookupGroup&&!selected){try{group=await budget.bounded(signal=>lookupGroup(scope.entity_query,{signal}),'governed_group_resolution');}catch(error){resolution.group_diagnostic=inventoryDiagnostic(error,'governed_group_resolution');}}
      if(group.length>25){ambiguity=true;}else if(group.length){resolution={method:selected?'validated_product_selection':'governed_product_group',product_ids:[...new Set(group.map(r=>r.subject_ref.replace('shopify:shopify:','')))],classification_values:[...new Set(group.map(r=>r.classification_value))]};}
      else{
        const token=await budget.call(signal=>getToken(signal),'authentication');resolvedToken=token;
        const terms=words(scope.entity_query),query=terms.map(w=>`title:${w}*`).join(' AND ');
        if(!terms.length)throw Object.assign(new Error('Empty query'),{code:'INVENTORY_PRODUCT_UNRESOLVED'});
        const data=await budget.call(signal=>graphql(token,STOCK_RESOLUTION_QUERY,{query,cursor:null},signal),'product_resolution');
        if(!Array.isArray(data?.products?.nodes))throw Object.assign(new Error('Invalid products'),{code:'INVENTORY_INVALID_RESPONSE'});
        candidates=data.products.nodes.map(({id,title,handle,status})=>({id,title,handle,status}));
        let relevant=candidates.filter(p=>terms.every(w=>words(p.title).includes(w)));
        if(!relevant.length&&!candidates.length){
          // Bounded catalogue scan supplies typo candidates, never auto-approvals.
          const suggestions=[];let cursor=null,more=false;
          for(let page=0;page<2;page++){
            const d=await budget.call(signal=>graphql(token,STOCK_RESOLUTION_QUERY,{query:terms.map(w=>`title:${w.slice(0,3)}*`).join(' OR '),cursor},signal),'product_candidate_discovery');
            if(!Array.isArray(d?.products?.nodes))throw Object.assign(new Error('Invalid candidates'),{code:'INVENTORY_INVALID_RESPONSE'});
            suggestions.push(...d.products.nodes);more=Boolean(d.products.pageInfo?.hasNextPage);cursor=d.products.pageInfo?.endCursor;if(!more||!cursor)break;
          }
          candidates=suggestions.filter(p=>similarProduct(scope.entity_query,p.title)).slice(0,8);
          relevant=[];
          if(candidates.length)ambiguity=true;
          resolution.candidate_search_complete=!more;
        }
        ambiguity=ambiguity||Boolean(data.products.pageInfo?.hasNextPage)||relevant.length!==candidates.length;
        resolution={...resolution,method:!relevant.length&&!candidates.length?'product_not_resolved':'catalogue_title_candidates',product_ids:relevant.map(p=>p.id),candidates:relevant};
      }
      if(!ambiguity&&resolution.product_ids.length){
        const load=createBatchedInventoryByLocation({graphql,getToken:resolvedToken?async()=>resolvedToken:getToken,locationSelector:inventoryLocationSelectorForRequest(scope.location,locationSelector),now,log});
        result=await load(resolution.product_ids,{deadlineAt,signal:options.signal,allLocations:scope.all_locations,maxRequests:36,locationRequest:scope.stock_scope});
      }else result={products:[],complete:false,availability:'unavailable',failures:[],source:'live_shopify_admin'};
    }catch(error){result={products:[],complete:false,availability:'failed',failures:[inventoryDiagnostic(error,'product_resolution')],source:'live_shopify_admin'};}
    const evidence={...result,subject:'current_stock',kind:'current_stock',entity_query:scope.entity_query,stock_scope:scope.stock_scope||null,resolution,ambiguous:ambiguity,candidates,diagnostics:{resolution:budget.finish(),inventory:result.diagnostics||null}};
    const rendered=stockAnswer(evidence),split=rendered.indexOf('<details>');
    const answer={answer:rendered,tools:['get_shopify_inventory_by_location'],evidence,presentation:{version:1,summary_markdown:split<0?rendered:rendered.slice(0,split).trim(),supporting_markdown:split<0?'':rendered.slice(split).replace(/<\/?details>|<summary>Show details<\/summary>/g,'').trim()}};
    if(scope.stock_scope?.format==='xlsx'&&evidence.products.length){
      const {exportOwner,requestId,downloadBase='/api/oracle/exports'}=options;
      if(!exportOwner||!requestId)throw Object.assign(new Error('Export owner required'),{code:'EXPORT_OWNER_REQUIRED'});
      const envelope={...evidence,kind:'inventory_report',products:evidence.products.map(p=>({...p,variants:p.variants.map(v=>({...v,inventoryItem:{id:v.inventory_item_id,tracked:v.inventory_tracked}}))})),locations:evidence.location_coverage.resolved,started_at:evidence.as_of,tag_convention:{predicate:'Catalogue product identity; no tag exclusion',observed_tags:[],catalogue_complete:evidence.complete},limits:INVENTORY_EXPORT_LIMITS};
      const bytes=await inventoryReportWorkbook(envelope),id=priorityArtifactId(exportOwner,requestId);
      const artifact={request:message,analysis_context:options.analysisContext,envelope,filename:'oracle-product-inventory.xlsx',answer:answer.answer,xlsx_base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
      if(Buffer.byteLength(JSON.stringify(artifact))>INVENTORY_EXPORT_LIMITS.storage_bytes)throw Object.assign(new Error('Export too large'),{code:'EXPORT_STORAGE_SIZE_EXCEEDED'});
      await assertInventoryArtifact(artifact);await artifactStore.put(id,exportOwner,artifact);
      answer.artifact={id,filename:artifact.filename,row_count:evidence.products.reduce((n,p)=>n+p.variants.length,0),download_url:`${downloadBase}/${id}`};
    }
    await options.onEvidence?.(answer);
    return answer;
  };
}

function similarProduct(query,title){
 const tokens=words(title);
 return words(query).every(a=>tokens.some(b=>{
   if(a===b)return true;
   if(a.length<4||Math.abs(a.length-b.length)>2)return false;
   let row=Array.from({length:b.length+1},(_,i)=>i);
   for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+Number(a[i-1]!==b[j-1]));row=next;}
   return row[b.length]<=Math.min(2,Math.floor(a.length/4));
 }));
}
