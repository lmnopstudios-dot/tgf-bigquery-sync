import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from './product-priority-storage.js';
import {readInventoryReport,INVENTORY_EXPORT_LIMITS} from './inventory-report.js';
import {EYEWEAR_BRAND,EYEWEAR_EXCLUDE,EYEWEAR_SOURCES} from './eyewear-sales.js';
import {offsetMonth} from '../public/oracle/tw-supplier-intent.js';

const SHEETS=['Summary','Monthly sales','Style and colour','Current stock','Coverage'];
const brand=new RegExp(EYEWEAR_BRAND,'i'),accessory=new RegExp(EYEWEAR_EXCLUDE,'i');
const shortId=x=>String(x||'').replace(/^gid:\/\/shopify\/(?:Product|ProductVariant)\//,'');
const normalizedRef=x=>String(x||'').replace(/^shopify:shopify:gid:\/\/shopify\/Product\//,'shopify:shopify:');
const shopRef=x=>'shopify:shopify:'+shortId(x);
const sourceNames={shopify:'Shopify',square:'Square',ww:'WooCommerce WW',usd:'WooCommerce USD'};
const collectionQuery='query EyewearCollections($cursor:String){collections(first:100,after:$cursor,query:"title:Sunglasses"){nodes{id title handle} pageInfo{hasNextPage endCursor}}}';
const collectionProducts='query EyewearCollectionProducts($id:ID!,$cursor:String){collection(id:$id){products(first:100,after:$cursor){nodes{id} pageInfo{hasNextPage endCursor}}}}';

export function eyewearProductSelected(product,collection){
  return !accessory.test(product.title||'')&&(brand.test(product.title||'')||collection?.has(product.id)===true);
}
export function createEyewearStockReader({graphql,getToken}){
  return opts=>readInventoryReport({...opts,graphql,getToken,selectProduct:eyewearProductSelected,
    limits:{...INVENTORY_EXPORT_LIMITS,max_requests:900,max_variants:2500,max_location_rows:25000},
    prepareSelection:async paginate=>{
      const matches=[];
      await paginate(collectionQuery,{},d=>d.collections,rows=>{
        for(const c of rows)if(String(c.title).trim().toLowerCase()==='sunglasses')matches.push(c);
      });
      if(matches.length!==1)throw Object.assign(Error('Sunglasses collection not uniquely resolved'),{code:'EYEWEAR_COLLECTION_NOT_UNIQUE'});
      const ids=new Set();
      await paginate(collectionProducts,{id:matches[0].id},d=>d.collection?.products,rows=>{
        for(const p of rows){if(!p.id)throw Error('Collection product ID missing');ids.add(p.id);}
      });
      return ids;
    }});
}

export function eyewearMappings(products,rows,historicalTitles=[]){
  const titles=new Map(products.map(p=>[shopRef(p.id),p.title])),eligible=new Set(titles.keys()),graph=new Map();
  for(const {ref,title} of historicalTitles)if(ref&&brand.test(title||'')&&!accessory.test(title||'')){
    const key=normalizedRef(ref);
    eligible.add(key);
    if(!titles.has(key))titles.set(key,title);
  }
  const connect=(a,b)=>{const edges=graph.get(a)||new Set();edges.add(b);graph.set(a,edges);};
  for(const m of rows){
    const a=normalizedRef(m.a),b=normalizedRef(m.b);
    if(!a||!b)continue;
    connect(a,b);connect(b,a);
    for(const [ref,title] of [[a,m.a_title],[b,m.b_title]])if(title&&!titles.has(ref))titles.set(ref,title);
  }
  const resolution=new Map(),visited=new Set();
  for(const ref of graph.keys()){
    if(visited.has(ref))continue;
    const component=[],pending=[ref];
    while(pending.length){const key=pending.pop();if(visited.has(key))continue;visited.add(key);component.push(key);for(const x of graph.get(key)||[])pending.push(x);}
    const parents=component.filter(x=>/^shopify:shopify:(?!gid:\/\/shopify\/ProductVariant\/)/.test(x));
    const anchored=component.some(x=>eligible.has(x)||brand.test(titles.get(x)||'')&&!accessory.test(titles.get(x)||''));
    // Multiple Shopify parents are conflicting evidence. Count independently
    // eligible titles/collection members, but do not admit ambiguous aliases.
    const canonical=parents.length===1?parents[0]:parents.length===0?[...component].sort()[0]:null;
    for(const x of component){
      resolution.set(x,{canonical,title:canonical?titles.get(canonical)||null:null,ambiguous:!canonical});
      if(anchored&&canonical&&!accessory.test(titles.get(x)||''))eligible.add(x);
    }
  }
  return {eligible,resolution};
}

const numeric=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x?.value??x))?Number(x?.value??x):null;
const newTotals=()=>({refs:new Set(),orders:new Set(),units:0,missingUnits:0,sales:0,missingSales:0,returns:0,observedReturnLines:0,lineCount:0,months:new Set(),first:null,last:null});
function add(g,row){
  if(row.ref)g.refs.add(row.ref);
  g.orders.add(row.orderKey);g.months.add(row.day.slice(0,7));g.lineCount++;
  if(row.units==null)g.missingUnits++;else g.units+=row.units;
  if(row.sales==null)g.missingSales++;else g.sales+=row.sales;
  if(row.returned!=null){g.returns+=row.returned;g.observedReturnLines++;}
  if(!g.first||row.day<g.first)g.first=row.day;
  if(!g.last||row.day>g.last)g.last=row.day;
}
function format(g,{money=false,trace=false}={}){
  return {...(trace?{source_product_refs:[...g.refs].sort().slice(0,40).join(' | '),source_product_ref_count:g.refs.size}:{}),distinct_orders:g.orders.size,pairs_sold:g.missingUnits===g.lineCount?null:g.units,
    lines_missing_units:g.missingUnits,discounted_line_sales:money&&g.missingSales<g.lineCount?Math.round(g.sales*1e4)/1e4:null,
    lines_missing_sales:g.missingSales,matched_returned_pairs:g.observedReturnLines?g.returns:null,
    net_pairs:null,first_observed_sale:g.first,last_observed_sale:g.last,months_with_sales:g.months.size};
}
const addGroup=(map,keys,row)=>{const key=JSON.stringify(keys);if(!map.has(key))map.set(key,{keys,totals:newTotals()});add(map.get(key).totals,row);};
const groupRows=(map,labels,opts)=>[...map.values()].map(({keys,totals})=>({...Object.fromEntries(labels.map((k,i)=>[k,keys[i]])),...format(totals,opts)}));
const monthsIn=({start_date,end_date})=>{const a=[];for(let m=start_date.slice(0,7);m<=end_date.slice(0,7);m=offsetMonth(m,1))a.push(m);return a;};
const keyOf=(oid,lid)=>JSON.stringify([String(oid),String(lid)]);

export function buildEyewearTables({period,inventory,mappings,components,returns}){
  const products=inventory?.products||[],{resolution}=mappings;
  const variants=new Map(products.flatMap(p=>(p.variants||[]).map(v=>[shortId(v.id),v])));
  const coverage=[],stocks=[],lineRows=[],seen=new Set();
  const stats={lines:0,unresolved:0,ambiguous:0,unknownChannel:0};
  for(const c of components){
    const source=sourceNames[c.source];
    const months=new Map();
    for(const r of c.data?.coverage||[]){
      const month=String(r.month?.value??r.month).slice(0,7);
      if(!months.has(month))months.set(month,[]);
      months.get(month).push(r);
    }
    for(const month of monthsIn(period)){
      const entries=months.get(month)||[];
      if(!entries.length)coverage.push({source,month,status:c.error||'No eligible orders observed; source coverage unverified'});
      for(const x of entries)coverage.push({source,month,channel:x.channel,status:'Observed; source coverage unverified',
        eligible_orders:Number(x.eligible_orders),orders_without_lines:Number(x.eligible_orders)-Number(x.orders_with_lines),
        first_observed_order:x.first_date,last_observed_order:x.last_date});
    }
    if(c.aliasError)coverage.push({source,status:'Approved historical alias expansion failed; initial observed results retained'});
    for(const r of c.data?.lines||[]){
      const key=JSON.stringify([c.source,r.oid,r.lid]);
      if(!r.oid||!r.lid||seen.has(key)||r.day<period.start_date||r.day>period.end_date||accessory.test(r.title||''))continue;
      seen.add(key);
      const ref=normalizedRef(r.ref),mapped=resolution.get(ref);
      const styleKey=mapped?.canonical||ref||`${c.source}:title:${String(r.title||'').trim().toLowerCase()}`;
      const recordedColour=c.source==='shopify'?variants.get(shortId(r.variant_id))?.selectedOptions?.find(x=>/^colou?r$/i.test(x.name))?.value:null;
      const colour=String(recordedColour||r.colour||'').trim();
      const knownColour=colour&&!/^default title$/i.test(colour);
      // An approved parent family does not prove cross-source colour identity.
      const colourKey=knownColour?`${c.source}:${r.variant_id||colour.toLowerCase()}`:r.variant_id?`${c.source}:${r.variant_id}`:'unknown';
      const colourLabel=knownColour?colour:r.variant_id?`Unknown colour (${c.source} variant ${shortId(r.variant_id)})`:'Unknown colour';
      const channel=/^(unknown)?$/i.test(String(r.channel||''))?'Unknown':r.channel;
      const currency=/^[A-Z]{3}$/.test(r.currency||'')?r.currency:'Unknown';
      const row={source,ref,styleKey,style:mapped?.title||r.title||'Unnamed eyewear',colourKey,colourLabel,
        mapping:mapped?.ambiguous?'Ambiguous; source identity retained':mapped?.canonical?'Approved identity / family':'Source identity',
        day:r.day,channel,currency,orderKey:`${c.source}:${r.oid}`,
        units:numeric(r.units),sales:currency==='Unknown'?null:numeric(r.sales),
        returned:c.source==='shopify'?returns.get(keyOf(r.oid,r.lid))??null:null};
      stats.lines++;if(!mapped?.canonical)stats.unresolved++;if(mapped?.ambiguous)stats.ambiguous++;if(channel==='Unknown')stats.unknownChannel++;
      lineRows.push(row);
    }
  }
  const total=newTotals(),bySource=new Map(),byCurrency=new Map(),monthly=new Map(),monthlyStyles=new Map(),styles=new Map(),crossStyle=new Map(),styleTotals=new Map();
  const styleNames=new Map(),colourNames=new Map();
  for(const r of lineRows){
    const {source,channel,currency,styleKey,style,colourKey,colourLabel,mapping}=r;
    const month=r.day.slice(0,7);
    if(!styleNames.has(styleKey))styleNames.set(styleKey,style);
    const colourRef=JSON.stringify([styleKey,colourKey]);
    if(!colourNames.has(colourRef))colourNames.set(colourRef,colourLabel);
    const label=styleNames.get(styleKey),colourName=colourNames.get(colourRef);
    add(total,r);
    addGroup(bySource,[source,channel],r);
    addGroup(byCurrency,[source,channel,currency],r);
    addGroup(monthly,[month,source,channel],r);
    addGroup(monthlyStyles,[month,source,channel,currency,styleKey,label,colourKey,colourName,mapping],r);
    addGroup(styles,[source,channel,currency,styleKey,label,colourKey,colourName,mapping],r);
    addGroup(styleTotals,[styleKey,label],r);
    addGroup(crossStyle,[styleKey,label,colourKey,colourName,mapping],r);
  }
  // Totals across sources retain source-qualified orders; no inferred cross-source de-duplication.
  const headline={section:'All observed sources',start:period.start_date,end:period.end_date,
    ...format(total),distinct_orders:lineRows.length?total.orders.size:null};
  const summary=[headline,
    ...groupRows(bySource,['source','channel']).map(r=>({section:'Observed source/channel totals',...r})),
    ...groupRows(byCurrency,['source','channel','currency'],{money:true}).map(r=>({section:'Currency breakdown (do not sum order counts)',...r})),
    ...groupRows(styleTotals,['style_ref','style'],{trace:true})
      .sort((a,b)=>(b.pairs_sold??0)-(a.pairs_sold??0)).slice(0,20).map(r=>({section:'Best-selling styles by observed pairs',...r})),
    ...groupRows(crossStyle,['style_ref','style','colour_ref','colour','mapping'])
      .filter(r=>r.months_with_sales>=2)
      .sort((a,b)=>b.months_with_sales-a.months_with_sales||(b.pairs_sold??0)-(a.pairs_sold??0)).slice(0,20)
      .map(r=>({section:'Restock review: repeated observed sales',...r,coverage_note:'Observed months only; compare live stock and check missing history before buying'}))];
  const monthlyRows=[
    ...groupRows(monthly,['month','source','channel']).map(r=>({level:'Source/channel total',...r})),
    ...groupRows(monthlyStyles,['month','source','channel','currency','style_ref','style','colour_ref','colour','mapping'],{money:true}).map(r=>({level:'Style / colour / currency',...r}))
  ].sort((a,b)=>a.month.localeCompare(b.month)||a.level.localeCompare(b.level)||a.source.localeCompare(b.source));
  for(const p of products)for(const v of p.variants||[]){
    const levels=v.locations?.length?v.locations:[{}];
    for(const l of levels)stocks.push({product:p.title,status:p.status,variant:v.title,sku:v.sku,product_id:p.id,variant_id:v.id,
      location:l.location_name??null,location_id:l.location_id??null,online_ready_to_ship:/^online ready to ship$/i.test(l.location_name||''),
      available:l.available??null,on_hand:l.on_hand??null,committed:l.committed??null,observed_at:l.observed_at??null,
      evidence:l.evidence_state??'Location evidence unavailable',storefront_sellability:'Not established by inventory quantity'});
  }
  coverage.push(
    {source:'Product identity',status:mappings.complete?'Approved mapping reads completed; colour labels retain source variant identity':'Approved mappings partial or unavailable',unresolved_eyewear_lines:stats.unresolved,ambiguous_eyewear_lines:stats.ambiguous,unknown_channel_eyewear_lines:stats.unknownChannel},
    {source:'Catalogue / stock',status:inventory?.complete?'Paginated stock read completed':'Stock or collection coverage incomplete',observed_at:inventory?.as_of??null},
    ...(inventory?.failures||[]).map(f=>({source:'Catalogue / stock',status:f.stage+': '+f.code})),
    {source:'Returns',status:'Shopify shows matched successful refund-line quantities where observed. Return completeness is unverified; net pairs are blank. Other sources have no verified line-return binding.'},
    {source:'Money',status:'Discounted merchandise line amounts, excluding shipping and other basket items; no FX conversion. Woo line totals exclude tax, Shopify and Square retain source tax treatment. Refunds are not deducted from line sales.'},
    {source:'Orders',status:'Successful, non-cancelled Shopify sale/capture orders (known Matrixify imports excluded); completed Square orders; completed/processing Woo orders. Overall order counts use source-qualified identities and do not infer undocumented duplicates.'},
    {source:'Interpretation',status:'Sales are observed, not audited totals. Missing months, refunds, and historical inventory are not zero. Current stock cannot establish historical sell-through, stockout periods or storefront sellability.'}
  );
  const sortedStyles=groupRows(styles,['source','channel','currency','style_ref','style','colour_ref','colour','mapping'],{money:true,trace:true})
    .sort((a,b)=>(b.pairs_sold??-1)-(a.pairs_sold??-1)||a.style.localeCompare(b.style));
  return {stats,observedOrders:headline.distinct_orders,rows:[summary,monthlyRows,sortedStyles,stocks,coverage]};
}

export async function assertEyewearArtifact(a){
  const bytes=Buffer.from(a.xlsx_base64||'','base64');
  if(a.envelope?.kind!=='eyewear_report'||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('EYEWEAR_INVALID_ARTIFACT');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);
  if(SHEETS.some(name=>!wb.getWorksheet(name)))throw Error('EYEWEAR_INVALID_WORKBOOK');
}

export function createEyewearReportService({readStock,readSource,readMappings,readShopifyReturns,artifactStore}){
  return async(message,options)=>{
    const {analysisContext:context,exportOwner,requestId,signal,deadlineAt}=options;
    if(!exportOwner||!requestId)return {answer:'The eyewear report requires authenticated Oracle chat.',tools:[],analysis_unavailable:true};
    const period={start_date:context.start_date,end_date:context.end_date};
    const id=priorityArtifactId(exportOwner,requestId);
    let a=await artifactStore.get(id,exportOwner);
    if(a&&(a.request!==message||a.envelope?.start_date!==period.start_date||a.envelope?.end_date!==period.end_date))throw Error('EYEWEAR_EXPORT_CONFLICT');
    if(!a){
      const opts={signal,deadlineAt};
      const [stock,mapping]=await Promise.allSettled([
        readStock({...opts,deadlineAt:Math.min(deadlineAt??Infinity,Date.now()+120000)}),readMappings(opts)
      ]);
      const inventory=stock.status==='fulfilled'?stock.value:null, mappingRows=mapping.status==='fulfilled'?mapping.value:{rows:[],complete:false};
      let mappings={...eyewearMappings(inventory?.products||[],mappingRows.rows),complete:mappingRows.complete};
      const sourceKeys=Object.keys(EYEWEAR_SOURCES);
      const settled=await Promise.allSettled(sourceKeys.map(source=>readSource(source,{...opts,period,eligibleRefs:[...mappings.eligible]})));
      const safeFailure = error => {
        const code=Number(error?.code), reason=error?.errors?.[0]?.reason;
        return {
          ...( [400,401,403,404,408,429,500,502,503,504].includes(code) ? {bigquery_code:code} : {}),
          failure_category:['accessDenied','notFound','invalidQuery','quotaExceeded','rateLimitExceeded','backendError','jobTimeout','billingTierLimitExceeded'].includes(reason)
            ? reason : ['EYEWEAR_READ_DEADLINE','EYEWEAR_LINE_LIMIT','EYEWEAR_INVALID_SOURCE'].includes(error?.message) ? error.message : 'unclassified'
        };
      };
      const components=settled.map((result,i)=>({source:sourceKeys[i],...(result.status==='fulfilled'?{data:result.value}:{error:'Source read failed; sales unavailable',diagnostic:safeFailure(result.reason)})}));
      // A historical branded line can anchor an approved alias even when the
      // catalogue no longer contains it and the reviewed edge has no title.
      const expanded=eyewearMappings(inventory?.products||[],mappingRows.rows,components.flatMap(c=>c.data?.lines||[]));
      const added=[...expanded.eligible].filter(ref=>!mappings.eligible.has(ref));
      const prefixes={shopify:'shopify:shopify:',square:'square:square:',ww:'woo:ww:',usd:'woo:usd:'};
      await Promise.all(components.filter(c=>c.data&&added.some(ref=>ref.startsWith(prefixes[c.source])&&expanded.resolution.get(ref)?.canonical))
        .map(async c=>{
          try{c.data=await readSource(c.source,{...opts,period,eligibleRefs:[...expanded.eligible]});}
          catch{c.aliasError=true;}
        }));
      mappings={...expanded,complete:mappingRows.complete&&!components.some(c=>c.aliasError)};
      for(const c of components)options.onProviderStage?.({stage:'eyewear_sales_source',source:c.source,
        ...c.diagnostic,status:c.error?'failed':'success',...(c.data?{line_count:c.data.lines.length}:{} )});
      const returns=new Map(),shopify=components.find(c=>c.source==='shopify');
      let returnReadFailed=false;
      if(shopify?.data?.lines.length)try{
        for(const r of await readShopifyReturns(shopify.data.lines,{...opts,period})){
          const n=numeric(r.returned);if(n!=null&&n>=0)returns.set(keyOf(r.oid,r.lid),n);
        }
      }catch{returnReadFailed=true;}
      const result=buildEyewearTables({period,inventory,mappings,components,returns});
      if(returnReadFailed)result.rows[4].push({source:'Shopify returns',status:'Refund line read failed; returned quantities unavailable'});
      const workbook=new ExcelJS.Workbook();
      for(const [i,name] of SHEETS.entries()){
        const s=workbook.addWorksheet(name),rows=result.rows[i],keys=[...new Set(rows.flatMap(Object.keys))];
        s.columns=(keys.length?keys:['status']).map(key=>({header:key,key,width:/status|note/.test(key)?58:/style|product/.test(key)?39:24}));
        for(const row of rows)s.addRow(row);
        s.getRow(1).font={bold:true};s.views=[{state:'frozen',ySplit:1}];
        if(rows.length)s.autoFilter={from:'A1',to:s.getRow(1).getCell(s.columnCount).address};
      }
      const bytes=Buffer.from(await workbook.xlsx.writeBuffer());
      const failed=components.filter(c=>c.error).map(c=>sourceNames[c.source]);
      const envelope={kind:'eyewear_report',subject:'eyewear_sales_stock',...period,periods:[period],
        observed_orders:result.observedOrders,observed_lines:result.stats.lines,failed_sources:failed,stock_complete:inventory?.complete===true,
        as_of:inventory?.as_of??null,row_count:result.rows[2].length};
      const answer=`Cutler and Gross stock and sales report: ${period.start_date} to ${period.end_date} inclusive (London). ${result.observedOrders==null?'No qualifying orders could be established.':`${result.observedOrders} distinct observed orders across available sources.`} ${failed.length?'Unavailable sales sources: '+failed.join(', ')+'. ':''} Shopify stock coverage: ${inventory?.complete?'paginated read completed':'partial or unavailable'}. See the workbook for styles, colours, restock review and evidence gaps. Observed figures do not certify complete sales history.`;
      a={request:message,envelope,answer,filename:'oracle-eyewear-sales.xlsx',sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')};
      await assertEyewearArtifact(a);signal?.throwIfAborted();await options.assertLease?.();
      await artifactStore.put(id,exportOwner,a);a=await artifactStore.get(id,exportOwner);
    }
    await assertEyewearArtifact(a);
    return {answer:a.answer,tools:['get_eyewear_sales_stock'],partial:true,evidence:a.envelope,
      artifact:{id,filename:a.filename,row_count:a.envelope.row_count,download_url:`${options.downloadBase||'/api/oracle/exports'}/${id}`}};
  };
}
