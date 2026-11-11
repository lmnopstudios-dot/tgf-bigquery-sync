import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {buildEyewearTables,createEyewearReportService,createEyewearStockReader,eyewearMappings,eyewearProductSelected} from '../oracle/eyewear-report.js';
import {eyewearSalesSql} from '../oracle/eyewear-sales.js';
import {oracleRequestRoute} from '../public/oracle/request-routing.js';

const now=Date.parse('2026-11-10T16:00:00Z');
const period={start_date:'2023-11-10',end_date:'2026-11-09'};
const short='Cutler and Gross stock and sales report';
const long=`Build a three-year Cutler and Gross eyewear sales and stock review for
The Great Frog. Cover the last three years through yesterday, Europe/London.
Use Shopify, Square, WooCommerce WW and WooCommerce USD.

Include products that meet either rule:
1. They are in the Shopify Sunglasses collection.
2. Their product title contains “Cutler and Gross” or “Cutler & Gross”,
   case-insensitively.

Apply the title rule to historical Square and WooCommerce catalogue and
order-line titles too, so older styles can qualify even if they no longer
exist in Shopify. Include sold-out, archived and discontinued styles.
Exclude identifiable accessories, replacement parts and repairs.

Count products matching both rules only once. Use approved cross-platform
mappings and reporting families to group the same style and colour and
identify older aliases. Keep ambiguous matches separate. A clear historical
title match can count towards eyewear sales even if it cannot safely be
grouped with a current Shopify product.

Show monthly results and three-year totals, by style and colour, split
by source and by online versus in-store where known. Keep unknown channels
separate. Include:
- Distinct orders containing at least one matching eyewear line.
- Pairs sold, returned pairs where known, and net pairs where supported.
- Eyewear line sales after discounts, excluding other items in the basket.
  Keep currencies separate and state how tax and refunds are treated.
- First and last observed sale dates, and the best-selling styles and colours.

Count each eligible order once in the overall order total, even if it
contains multiple eyewear styles. Do not sum per-style order counts to
get the overall total. Exclude known WooCommerce orders migrated into
Shopify from the Shopify figures.

Separately, show current available Shopify stock by variant and location,
with Online Ready to Ship called out and the stock read timestamped.
Show historical stockouts only where actual inventory evidence exists.
Do not assume no recorded sales means no demand, or calculate historical
sell-through from today's stock.

Report date coverage by source, missing order lines, unresolved product
matches and any gaps in returns or channel attribution. Show genuine
zeroes only where coverage supports them. Keep successful sections if
a source is unavailable.

Return a short summary and a downloadable Excel workbook with the monthly
sales, style and colour totals, current stock, and coverage. Highlight
which styles and colours sold consistently and are worth reviewing for
a restock. Do not change stock or place any orders.`;
const product=(n,title)=>({id:'gid://shopify/Product/'+n,title,status:'ACTIVE',tags:[]});
const products=[product(1,'Cutler & Gross Rapture'),product(2,'Collection-only model')];
const inventory={products,complete:true};
const edges=[{a:'woo:ww:5',b:'shopify:shopify:1',b_title:products[0].title},{a:'woo:ww:6',b:'shopify:shopify:1'},
  {a:'woo:ww:6',b:'shopify:shopify:2'}];
const line=(r={})=>({oid:'same-native-id',lid:'1',ref:'shopify:shopify:1',title:products[0].title,
  variant_id:'101',colour:'Black',day:'2026-10-01',channel:'Online Store',units:'1',sales:'100',currency:'GBP',...r});
const coverage=[{month:'2026-10-01',channel:'Online Store',eligible_orders:3,orders_with_lines:2,first_date:'2026-10-01',last_date:'2026-10-03'}];
const shopify=[line(),line(),line({lid:'2',ref:'shopify:shopify:2',title:products[1].title,variant_id:'102',units:'2'}),
  line({lid:'3',title:'Cutler & Gross replacement lenses'})];
const woo=[line({ref:'woo:ww:9',title:'Cutler and Gross retired colour',colour:null,variant_id:'57',day:'2026-09-01'})];

test('selected collection and title overlap does not duplicate; conflicting aliases stay separate',()=>{
  const selected=new Set(products.map(p=>p.id));
  assert.equal(eyewearProductSelected(products[0],selected),true);
  assert.equal(eyewearProductSelected(products[1],selected),true);
  assert.equal(eyewearProductSelected(product(3,'Cutler & Gross replacement lenses'),selected),false);
  const mappings=eyewearMappings(products,edges);
  assert.ok(mappings.resolution.get('woo:ww:6').ambiguous);
  assert.ok(!mappings.eligible.has('woo:ww:6'));
  const clean=eyewearMappings(products,edges.slice(0,1));
  assert.equal(clean.resolution.get('woo:ww:5').canonical,'shopify:shopify:1');
  assert.ok(clean.eligible.has('woo:ww:5'));
});

test('counts multi-style order once, keeps historical title-only records, and preserves failures',()=>{
  const mappings={...eyewearMappings(products,[]),complete:true};
  const result=buildEyewearTables({period,inventory,mappings,returns:new Map([[JSON.stringify(['same-native-id','1']),1]]),
    components:[{source:'shopify',data:{coverage,lines:shopify}},{source:'ww',data:{coverage:[],lines:woo}},{source:'square',error:'unavailable'}]});
  assert.equal(result.observedOrders,2);
  assert.equal(result.stats.lines,3);
  assert.equal(result.rows[0][0].pairs_sold,4);
  assert.equal(result.rows[0][0].matched_returned_pairs,1);
  assert.equal(result.rows[0][0].net_pairs,null);
  assert.ok(result.rows[2].some(r=>r.style==='Cutler and Gross retired colour'));
  assert.ok(result.rows[4].some(r=>r.source==='Square'&&r.status==='unavailable'));
  assert.ok(result.rows[4].some(r=>r.source==='Shopify'&&r.orders_without_lines===1));
  const sql=eyewearSalesSql('fixture','shopify');
  assert.match(sql,/COALESCE\(l.source_app_id,''\)!=@matrixify/);
  assert.match(sql,/OR ref IN UNNEST\(JSON_VALUE_ARRAY\(@eligible_refs\)\)/);
  assert.match(sql,/PARTITION BY order_id,line_item_id/);
  for(const source of ['square','ww','usd'])assert.match(eyewearSalesSql('fixture',source),/REGEXP_CONTAINS.*cutler/);
});

test('catalogue, collection membership, variants and stock paginate beyond the legacy 25 cap',async()=>{
  const all=Array.from({length:31},(_,i)=>product(i+1,i===30?'Collection-only':'Cutler & Gross '+i));
  const conn=(nodes,next=null)=>({nodes,pageInfo:{hasNextPage:Boolean(next),endCursor:next}});
  const queries=[];
  const read=createEyewearStockReader({getToken:async()=>'fixture',graphql:async(_token,q,v)=>{
    queries.push(q);
    if(q.includes('EyewearCollections'))return {collections:conn([{id:'fixture-collection',title:'Sunglasses'}])};
    if(q.includes('EyewearCollectionProducts'))return {collection:{products:v.cursor?conn([all.at(-1)]):conn([all[0]],'collection-next')}};
    if(q.includes('InventoryCatalogue'))return {products:v.cursor?conn(all.slice(25)):conn(all.slice(0,25),'next')};
    if(q.includes('InventoryReportLocations'))return {locations:conn([{id:'loc',name:'Online Ready to Ship',isActive:true}])};
    if(q.includes('InventoryReportVariants'))return {product:{variants:v.cursor?conn([{id:v.id+'/2',title:'Blue',inventoryItem:{id:v.id+'/item2',tracked:true}}]):
      conn([{id:v.id+'/1',title:'Black',inventoryItem:{id:v.id+'/item1',tracked:true}}],v.id===all[0].id?'variants-next':null)}};
    if(q.includes('InventoryReportLevels'))return {nodes:v.ids.map(id=>({id,inventoryLevel:{quantities:['available','on_hand','committed'].map(name=>({name,quantity:0}))}}))};
    assert.fail('Unexpected Shopify query');
  }});
  const r=await read({});
  assert.equal(r.complete,true);
  assert.equal(r.products.length,31);
  assert.equal(r.products.reduce((n,p)=>n+p.variants.length,0),32);
  assert.equal(queries.filter(q=>q.includes('InventoryCatalogue')).length,2);
});

test('short and original requests use authenticated durable workbook delivery with partial source evidence',async t=>{
  const exportStore=createMemoryExportStore(),calls=[];
  const eyewearReport=createEyewearReportService({artifactStore:exportStore,
    readStock:async()=>inventory,readMappings:async()=>({rows:edges.slice(0,1),complete:true}),
    readSource:async(source,args)=>{calls.push({source,args});assert.deepEqual(args.period,period);
      if(source==='square')throw Error('fixture unavailable');
      return {coverage,lines:source==='shopify'?shopify:source==='ww'?woo:[]};},
    readShopifyReturns:async()=>[]});
  const baseline=createOracleBaselineDispatcher({eyewearReport,currentStock:()=>assert.fail('legacy capped stock route')});
  const h=await acceptanceServer({baseline,exportStore,generateProposals:async()=>assert.fail('unexpected proposals')},{durable:true,now});
  t.after(h.close);
  for(const prompt of [short,long]){
    assert.equal(oracleRequestRoute(prompt,{hasCompletedJob:true}),'job');
    const r=await h.submit(prompt);
    assert.equal(r.analysis_context.tool_route,'get_eyewear_sales_stock');
    assert.equal(r.evidence.observed_orders,2);
    assert.deepEqual(r.evidence.failed_sources,['Square']);
    const url=h.origin+r.artifact.download_url;
    assert.equal((await fetch(url)).status,401);
    const download=await fetch(url,{headers:h.headers});assert.equal(download.status,200);
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));
    assert.deepEqual(wb.worksheets.map(s=>s.name),['Summary','Monthly sales','Style and colour','Current stock','Coverage']);
  }
  assert.equal(calls.length,8);
  assert.ok(calls[0].args.eligibleRefs.includes('woo:ww:5'));
});

test('a clear historical title anchors approved older aliases without a current listing',()=>{
  const mappings=eyewearMappings([], [{a:'woo:ww:9',b:'square:square:alias'}],woo);
  assert.ok(mappings.eligible.has('square:square:alias'));
  assert.equal(mappings.resolution.get('woo:ww:9').canonical,mappings.resolution.get('square:square:alias').canonical);
});

test('Square eyewear binds only retained order and line views and withholds unsupported fields',()=>{
  const sql=eyewearSalesSql('fixture','square');
  assert.deepEqual([...new Set([...sql.matchAll(/fixture\.square_data\.(\w+)/g)].map(m=>m[1]))],
    ['retail_orders','retail_order_items']);
  assert.match(sql,/PARTITION BY order_id ORDER BY updated_at/);
  assert.match(sql,/PARTITION BY order_id, COALESCE/);
  assert.match(sql,/JOIN eligible e USING\(oid\)/);
  assert.match(sql,/'Unknown' channel/);
  assert.match(sql,/CAST\(NULL AS NUMERIC\) sales/);
});
